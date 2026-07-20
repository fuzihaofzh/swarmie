/**
 * Direct channel for raw terminal output — bypasses Zustand to avoid O(n²) overhead.
 * Per-terminal WebSocket streams write here; TerminalView reads from here.
 *
 * Buffers data when no writer is registered yet (terminal still initializing),
 * then flushes the buffer as soon as a writer registers.
 *
 * Also tracks per-session offset metadata for the "load earlier history"
 * feature: lowestOffset (earliest byte the client has shown), highestOffset
 * (newest byte received), reachedEarliest (server has confirmed nothing
 * older remains in its buffer).
 */

// Chunks flowing through this bus are raw latin1 "binary strings" (one char per
// byte), NOT base64. The live path receives binary WS frames and the replay/
// history paths atob() their base64 at the WS boundary, so byte size is just
// `.length` — exact, no estimate needed.
type Writer = (binData: string, offsetEnd?: number, isReplay?: boolean) => void;
type SnapshotListener = (snapshot: HistorySnapshot) => void;
type MetaListener = (meta: SessionMeta) => void;

const MAX_BUFFERED_BYTES_PER_SESSION = 512 * 1024;

/**
 * Cap for the per-session raw-history cache (see rawCaches). xterm discards
 * anything past its scrollback cap on render, so caching much more than it can
 * display buys nothing; this is roughly a full server ring's worth.
 */
const RAW_CACHE_MAX_BYTES = 24 * 1024 * 1024;
/** Evict down to this in one splice once the cache overflows (see appendRawCache). */
const RAW_CACHE_LOW_WATER_BYTES = Math.floor(RAW_CACHE_MAX_BYTES * 0.9);

const writers = new Map<string, Writer>();
const buffers = new Map<string, { chunks: Array<{ bin: string; offsetEnd?: number; isReplay?: boolean }>; bytes: number }>();
const meta = new Map<string, SessionMeta>();
const metaListeners = new Map<string, Set<MetaListener>>();
const snapshotListeners = new Map<string, Set<SnapshotListener>>();

/**
 * Every raw byte this client has seen, kept so "load earlier" can fetch only
 * the older DELTA instead of re-fetching everything up to the live end.
 *
 * Without it the client holds no raw history (it writes to xterm and drops the
 * bytes), so rebuilding a scrolled-back view means asking the server for
 * [from, END] — on a full 16MB ring that is a single ~21MB base64 message per
 * page, which is the history-load freeze. With the cache the client already has
 * [cacheStart, END] and only needs [newFrom, cacheStart), a bounded chunk.
 */
interface RawCache {
  chunks: Array<{ bin: string; offsetEnd: number }>;
  bytes: number;
  /** Offset of the first byte held in chunks[0]. */
  startOffset: number;
  /**
   * Set once the cap has forced an eviction. Eviction drops to a low-water
   * mark, so `bytes` sits below the cap most of the time — this flag is what
   * "the cache is at capacity" actually means (see isRawCacheFull).
   */
  evicted: boolean;
}
const rawCaches = new Map<string, RawCache>();

function appendRawCache(sessionId: string, bin: string, offsetEnd: number): void {
  if (bin.length === 0) return;
  let c = rawCaches.get(sessionId);
  if (!c) {
    c = { chunks: [], bytes: 0, startOffset: Math.max(0, offsetEnd - bin.length), evicted: false };
    rawCaches.set(sessionId, c);
  }
  c.chunks.push({ bin, offsetEnd });
  c.bytes += bin.length;
  if (c.bytes > RAW_CACHE_MAX_BYTES) {
    // Same amortization as the server ring: shifting one chunk per overflow is
    // O(n) on every frame once the cache is full, so drop to a low-water mark
    // in a single splice instead.
    const toFree = c.bytes - RAW_CACHE_LOW_WATER_BYTES;
    let dropCount = 0;
    let freed = 0;
    while (dropCount < c.chunks.length - 1 && freed < toFree) {
      freed += c.chunks[dropCount].bin.length;
      dropCount++;
    }
    if (dropCount > 0) {
      c.chunks.splice(0, dropCount);
      c.bytes -= freed;
      c.evicted = true;
      const head = c.chunks[0];
      if (head) c.startOffset = Math.max(0, head.offsetEnd - head.bin.length);
    }
  }
}

/** Offset of the oldest byte this client still holds, or null if it holds none. */
export function getRawCacheStart(sessionId: string): number | null {
  const c = rawCaches.get(sessionId);
  if (!c || c.chunks.length === 0) return null;
  return c.startOffset;
}

/** The cached bytes, oldest first — the source for a scrolled-back rebuild. */
export function getRawCacheChunks(sessionId: string): string[] {
  const c = rawCaches.get(sessionId);
  if (!c) return [];
  return c.chunks.map((x) => x.bin);
}

/**
 * Offset one past the newest cached byte, or null when nothing is cached. A
 * rebuild renders the cache as of this point, so anything that streams in
 * afterwards is replayed by offset against it.
 */
export function getRawCacheEnd(sessionId: string): number | null {
  const c = rawCaches.get(sessionId);
  if (!c || c.chunks.length === 0) return null;
  return c.chunks[c.chunks.length - 1].offsetEnd;
}

/**
 * Splice a server-fetched older block onto the front of the cache. `bin` must
 * cover exactly [startOffset, endOffset) and end where the cache currently
 * begins, so the cache stays a contiguous run ending at the live edge.
 */
export function prependRawCache(sessionId: string, bin: string, startOffset: number, endOffset: number): void {
  let c = rawCaches.get(sessionId);
  if (!c) {
    c = { chunks: [], bytes: 0, startOffset, evicted: false };
    rawCaches.set(sessionId, c);
  }
  if (bin.length === 0) {
    c.startOffset = Math.min(c.startOffset, startOffset);
    return;
  }
  c.chunks.unshift({ bin, offsetEnd: endOffset });
  c.bytes += bin.length;
  c.startOffset = startOffset;
  // Deliberately no trim here. Dropping from the end would cut the live edge and
  // break the invariant this cache exists to hold (it must stay contiguous
  // through to the newest byte); dropping from the front would discard the very
  // page just fetched. The cap is instead enforced by refusing to page further
  // back — see isRawCacheFull().
}

/**
 * True once the cache holds its cap, meaning "load earlier" should stop: paging
 * back further can't be retained (the live append side would evict it again),
 * exactly like xterm dropping lines past its scrollback cap.
 */
export function isRawCacheFull(sessionId: string): boolean {
  const c = rawCaches.get(sessionId);
  return !!c && (c.evicted || c.bytes >= RAW_CACHE_MAX_BYTES);
}

export function clearRawCache(sessionId: string): void {
  rawCaches.delete(sessionId);
}

export interface SessionMeta {
  /** Lowest offset still represented in the client's xterm buffer (0 if none seen yet). */
  lowestOffset: number;
  /** Highest offset ever observed for this session. */
  highestOffset: number;
  /** True once the server has confirmed no older bytes remain. */
  reachedEarliest: boolean;
}

export interface HistorySnapshot {
  startOffset: number;
  endOffset: number;
  chunks: string[];
  reachedEarliest: boolean;
}

function getOrCreateMeta(sessionId: string): SessionMeta {
  let m = meta.get(sessionId);
  if (!m) {
    m = { lowestOffset: 0, highestOffset: 0, reachedEarliest: false };
    meta.set(sessionId, m);
  }
  return m;
}

function emitMeta(sessionId: string): void {
  const m = meta.get(sessionId);
  if (!m) return;
  const listeners = metaListeners.get(sessionId);
  if (!listeners) return;
  for (const l of listeners) l(m);
}

function appendBufferedChunk(sessionId: string, binData: string, offsetEnd?: number, isReplay?: boolean): void {
  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], bytes: 0 };
    buffers.set(sessionId, buffer);
  }

  buffer.chunks.push({ bin: binData, offsetEnd, isReplay });
  buffer.bytes += binData.length;

  while (buffer.bytes > MAX_BUFFERED_BYTES_PER_SESSION && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift();
    if (!removed) break;
    buffer.bytes -= removed.bin.length;
    // After eviction, the oldest data the client still has is the new head
    // chunk. Advance lowestOffset so the history-load UI knows older bytes
    // need to be re-fetched from the server.
    const head = buffer.chunks[0];
    if (head && typeof head.offsetEnd === 'number') {
      const headStart = head.offsetEnd - head.bin.length;
      const m = meta.get(sessionId);
      if (m && headStart > m.lowestOffset) {
        m.lowestOffset = headStart;
        emitMeta(sessionId);
      }
    }
  }
}

export function registerTerminalWriter(sessionId: string, writer: Writer): void {
  writers.set(sessionId, writer);

  // Flush any buffered data that arrived before the writer was ready
  const buffer = buffers.get(sessionId);
  if (buffer && buffer.chunks.length > 0) {
    for (const chunk of buffer.chunks) {
      writer(chunk.bin, chunk.offsetEnd, chunk.isReplay);
    }
    buffers.delete(sessionId);
  }
}

export function unregisterTerminalWriter(sessionId: string, writer?: Writer): void {
  if (writer && writers.get(sessionId) !== writer) return;
  writers.delete(sessionId);
  // Keep the buffer — if the terminal re-mounts it will get the data back
}

/** Returns true if a writer was found and data was delivered */
export function writeToTerminal(sessionId: string, binData: string, offsetEnd?: number, isReplay = false): boolean {
  // Track offsets regardless of whether a writer is present — keeps history
  // metadata accurate even if the terminal is still mounting.
  if (typeof offsetEnd === 'number' && Number.isFinite(offsetEnd)) {
    // Keep the bytes so "load earlier" can fetch only the older delta. Both the
    // live and replay paths land here, so the cache stays contiguous through to
    // the newest byte.
    appendRawCache(sessionId, binData, offsetEnd);
    const m = getOrCreateMeta(sessionId);
    const offsetStart = offsetEnd - binData.length;
    const prevLowest = m.lowestOffset;
    if (m.highestOffset === 0 && m.lowestOffset === 0) {
      m.lowestOffset = Math.max(0, offsetStart);
    }
    if (offsetEnd > m.highestOffset) m.highestOffset = offsetEnd;
    // Only notify listeners when a field the UI actually renders on changes.
    // highestOffset advances on every output frame but nothing reads it in
    // render, so emitting here unconditionally re-rendered TerminalView (and
    // re-ran its history-load effect) on every single WS frame.
    if (m.lowestOffset !== prevLowest) emitMeta(sessionId);
  }

  const writer = writers.get(sessionId);
  if (writer) {
    writer(binData, offsetEnd, isReplay);
    return true;
  }

  // No writer yet — buffer bounded recent output for remounts.
  appendBufferedChunk(sessionId, binData, offsetEnd, isReplay);
  return false;
}

/** Clean up buffer when a session is removed */
export function clearTerminalBuffer(sessionId: string): void {
  buffers.delete(sessionId);
  writers.delete(sessionId);
  meta.delete(sessionId);
  metaListeners.delete(sessionId);
  snapshotListeners.delete(sessionId);
  rawCaches.delete(sessionId);
}

export function getSessionMeta(sessionId: string): SessionMeta {
  return { ...getOrCreateMeta(sessionId) };
}

/**
 * Force "no older history available" for a session. Used when the terminal's
 * scrollback buffer is full: xterm caps retained lines, so any older bytes
 * would be discarded on render — fetching/re-rendering them is pure wasted
 * (and ever-growing) work, so we stop offering "load earlier".
 */
export function markReachedEarliest(sessionId: string): void {
  const m = getOrCreateMeta(sessionId);
  if (m.reachedEarliest) return;
  m.reachedEarliest = true;
  emitMeta(sessionId);
}

export function subscribeSessionMeta(sessionId: string, listener: MetaListener): () => void {
  let set = metaListeners.get(sessionId);
  if (!set) {
    set = new Set();
    metaListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const s = metaListeners.get(sessionId);
    s?.delete(listener);
  };
}

/**
 * Apply a server snapshot to the metadata only — TerminalView listens via
 * subscribeHistorySnapshot to actually rebuild xterm.
 */
export function applyHistorySnapshot(sessionId: string, snapshot: HistorySnapshot): void {
  const m = getOrCreateMeta(sessionId);
  m.lowestOffset = snapshot.startOffset;
  if (snapshot.endOffset > m.highestOffset) m.highestOffset = snapshot.endOffset;
  m.reachedEarliest = snapshot.reachedEarliest;
  emitMeta(sessionId);
  const listeners = snapshotListeners.get(sessionId);
  if (listeners) {
    for (const l of listeners) l(snapshot);
  }
}

export function subscribeHistorySnapshot(sessionId: string, listener: SnapshotListener): () => void {
  let set = snapshotListeners.get(sessionId);
  if (!set) {
    set = new Set();
    snapshotListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const s = snapshotListeners.get(sessionId);
    s?.delete(listener);
  };
}
