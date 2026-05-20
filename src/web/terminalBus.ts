/**
 * Direct channel for raw terminal output — bypasses Zustand to avoid O(n²) overhead.
 * useWebSocket writes here; TerminalView reads from here.
 *
 * Buffers data when no writer is registered yet (terminal still initializing),
 * then flushes the buffer as soon as a writer registers.
 *
 * Also tracks per-session offset metadata for the "load earlier history"
 * feature: lowestOffset (earliest byte the client has shown), highestOffset
 * (newest byte received), reachedEarliest (server has confirmed nothing
 * older remains in its buffer).
 */

import { estimateBase64Bytes } from './base64';

type Writer = (b64Data: string, offsetEnd?: number, isReplay?: boolean) => void;
type SnapshotListener = (snapshot: HistorySnapshot) => void;
type MetaListener = (meta: SessionMeta) => void;

const MAX_BUFFERED_BYTES_PER_SESSION = 512 * 1024;

const writers = new Map<string, Writer>();
const buffers = new Map<string, { chunks: Array<{ b64: string; offsetEnd?: number; isReplay?: boolean }>; bytes: number }>();
const meta = new Map<string, SessionMeta>();
const metaListeners = new Map<string, Set<MetaListener>>();
const snapshotListeners = new Map<string, Set<SnapshotListener>>();

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

function appendBufferedChunk(sessionId: string, b64Data: string, offsetEnd?: number, isReplay?: boolean): void {
  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = { chunks: [], bytes: 0 };
    buffers.set(sessionId, buffer);
  }

  buffer.chunks.push({ b64: b64Data, offsetEnd, isReplay });
  buffer.bytes += estimateBase64Bytes(b64Data);

  while (buffer.bytes > MAX_BUFFERED_BYTES_PER_SESSION && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift();
    if (!removed) break;
    buffer.bytes -= estimateBase64Bytes(removed.b64);
    // After eviction, the oldest data the client still has is the new head
    // chunk. Advance lowestOffset so the history-load UI knows older bytes
    // need to be re-fetched from the server.
    const head = buffer.chunks[0];
    if (head && typeof head.offsetEnd === 'number') {
      const headStart = head.offsetEnd - estimateBase64Bytes(head.b64);
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
      writer(chunk.b64, chunk.offsetEnd, chunk.isReplay);
    }
    buffers.delete(sessionId);
  }
}

export function unregisterTerminalWriter(sessionId: string): void {
  writers.delete(sessionId);
  // Keep the buffer — if the terminal re-mounts it will get the data back
}

/** Returns true if a writer was found and data was delivered */
export function writeToTerminal(sessionId: string, b64Data: string, offsetEnd?: number, isReplay = false): boolean {
  // Track offsets regardless of whether a writer is present — keeps history
  // metadata accurate even if the terminal is still mounting.
  if (typeof offsetEnd === 'number' && Number.isFinite(offsetEnd)) {
    const m = getOrCreateMeta(sessionId);
    const bytes = estimateBase64Bytes(b64Data);
    const offsetStart = offsetEnd - bytes;
    if (m.highestOffset === 0 && m.lowestOffset === 0) {
      m.lowestOffset = Math.max(0, offsetStart);
    }
    if (offsetEnd > m.highestOffset) m.highestOffset = offsetEnd;
    emitMeta(sessionId);
  }

  const writer = writers.get(sessionId);
  if (writer) {
    writer(b64Data, offsetEnd, isReplay);
    return true;
  }

  // No writer yet — buffer bounded recent output for remounts.
  appendBufferedChunk(sessionId, b64Data, offsetEnd, isReplay);
  return false;
}

/** Clean up buffer when a session is removed */
export function clearTerminalBuffer(sessionId: string): void {
  buffers.delete(sessionId);
  writers.delete(sessionId);
  meta.delete(sessionId);
  metaListeners.delete(sessionId);
  snapshotListeners.delete(sessionId);
}

export function getSessionMeta(sessionId: string): SessionMeta {
  return { ...getOrCreateMeta(sessionId) };
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
