import { EventEmitter } from 'node:events';
import { type BaseAdapter, waitingPromptFingerprint } from '../adapters/base.js';
import type {
  NormalizedEvent,
  MetadataData,
  RawOutputData,
  SessionStatus,
  AutomationActionData,
} from '../adapters/types.js';
import type { SessionInfo, SessionSummary } from './types.js';
import * as PROF from '../server/profile.js';
import { getDefaultHostTag, getSystemDisplayHostname } from './host.js';

const _hostname = getSystemDisplayHostname();

/**
 * Exact decoded byte length of a base64 string.
 *
 * Every raw offset in this file is built from this, so it has to be the TRUE
 * byte count. The previous `Math.ceil(len * 3 / 4)` ignored the `=` padding and
 * over-counted by up to 2 bytes per event. That is invisible on one event, but
 * a busy session holds ~19k of them, so offsets drifted ~36KB from real byte
 * positions across a full ring — enough that a client cannot do byte arithmetic
 * against them (e.g. splicing a fetched page onto bytes it already holds), and
 * enough that the ring's own accounting was off.
 */
function base64ByteLength(b64: string): number {
  const n = b64.length;
  if (n === 0) return 0;
  let padding = 0;
  if (b64.charCodeAt(n - 1) === 0x3d) padding++;
  if (n > 1 && b64.charCodeAt(n - 2) === 0x3d) padding++;
  return (n / 4) * 3 - padding;
}

const MAX_RECENT_EVENTS = 1000;
// In-memory cap for raw terminal output per session. Held so the dashboard
// can scroll back through history on demand without persisting to disk.
const MAX_RAW_BYTES = 16 * 1024 * 1024; // 16MB
/**
 * Low-water mark for raw-ring eviction. Evicting one event per overflow means
 * an Array.shift() — O(n) over a ring that holds 100k+ tiny events — on every
 * single chunk once the ring is full. Dropping to 90% in one splice instead
 * amortizes that to roughly one O(n) pass per 1.6MB of output.
 */
const RAW_EVICT_LOW_WATER_BYTES = Math.floor(MAX_RAW_BYTES * 0.9);
// Cap on raw bytes returned by getRecentEvents() (initial subscribe / route
// replay). Kept small so opening a tab on a large session is fast — over a
// remote tunnel the transfer of this blob dominates open latency. Older
// history is fetched on demand via history:load.
const INITIAL_RAW_REPLAY_BYTES = 256 * 1024; // 256KB
// Target size for the coalesced chunks getRawHistorySnapshot() returns. A busy
// session accumulates 100k+ tiny raw events (a redrawing statusline emits
// dozens/sec); shipping them one-per-array element makes the history:snapshot
// JSON enormous AND forces the browser to run atob/btoa/regex 100k times on the
// main thread — the multi-second freeze when scrolling back a large remote
// session. Merging contiguous bytes into ~512KB chunks collapses that work from
// O(100k) to O(tens) without changing what the client renders (it concatenates
// the chunks regardless of how they're split).
const SNAPSHOT_CHUNK_BYTES = 512 * 1024; // 512KB
const DEFAULT_AUTO_COMPACT_MINUTES = 60;
// Auto-approve presses Enter to accept the default ("Yes") option. We poll
// the headless screen (the source of truth for "is a prompt visible right
// now") on a tick, so neither status:change events nor a rolling stripped-
// text buffer can lead us astray.
//
// - AUTO_APPROVE_TICK_MS: how often we check the screen.
// - AUTO_APPROVE_INITIAL_DELAY_MS: minimum dwell before the first press, so
//   the app finishes rendering the prompt and a stray pre-prompt frame
//   doesn't trigger us.
// - AUTO_APPROVE_PRESS_COOLDOWN_MS: gap between Enter presses while we're
//   still in the "fast" phase (first AUTO_APPROVE_FAST_PRESSES presses for
//   a single prompt instance).
// - AUTO_APPROVE_FAST_PRESSES: how many quick presses before we back off.
//   If the prompt accepts our Enter, it disappears within a frame or two;
//   needing more than 2–3 attempts means \r isn't being consumed and
//   spamming more would just stack up actions when it eventually does
//   (e.g. dispatching the same agent N times if the prompt is "launch
//   agent? Yes/No").
// - AUTO_APPROVE_SLOW_COOLDOWN_MS: cooldown once we've burned the fast
//   budget. We keep trying so the user never gets stuck forever, but at
//   a rate that's clearly "polling for recovery" not "spamming keys."
// - AUTO_APPROVE_RESET_MS: how long the prompt must stay GONE before we
//   consider the next sighting "a new prompt" (resets dwell + press count).
const AUTO_APPROVE_TICK_MS = 250;
const AUTO_APPROVE_INITIAL_DELAY_MS = 750;
const AUTO_APPROVE_PRESS_COOLDOWN_MS = 1500;
const AUTO_APPROVE_FAST_PRESSES = 2;
const AUTO_APPROVE_SLOW_COOLDOWN_MS = 30_000;
const AUTO_APPROVE_RESET_MS = 2000;
const DEFAULT_REPEAT_INTERVAL_SECONDS = 60;
const AUTO_COMPACT_COMMAND = '/compact';
const REPEAT_CLEAR_COMMAND = '/clear';
const REPEAT_CLEAR_DELAY_MS = 1000;

export interface SessionSettingsPatch {
  autoApprove?: boolean;
  autoCompact?: boolean;
  repeatEnabled?: boolean;
  repeatCommand?: string;
  repeatIntervalSeconds?: number;
  repeatClear?: boolean;
  tags?: string[];
}

/**
 * Merge contiguous base64 raw chunks into fewer, larger base64 chunks of about
 * `targetBytes` decoded each. The concatenation of the output equals the
 * concatenation of the input, so this is transparent to any consumer that just
 * decodes-and-joins (the web terminal does). Used to keep a history snapshot of
 * a fragmented session (100k+ tiny events) from exploding the JSON payload and
 * the browser's per-chunk decode work.
 */
function coalesceBase64Chunks(chunks: string[], targetBytes: number): string[] {
  if (chunks.length <= 1) return chunks;
  const out: string[] = [];
  let bucket: Buffer[] = [];
  let bucketBytes = 0;
  const flush = (): void => {
    if (bucket.length === 0) return;
    out.push(Buffer.concat(bucket).toString('base64'));
    bucket = [];
    bucketBytes = 0;
  };
  for (const b64 of chunks) {
    const buf = Buffer.from(b64, 'base64');
    bucket.push(buf);
    bucketBytes += buf.length;
    if (bucketBytes >= targetBytes) flush();
  }
  flush();
  return out;
}

function normalizeRepeatCommand(command: string): string {
  return command.replace(/[\r\n]+/g, ' ');
}

function hasRepeatCommand(command: string): boolean {
  return command.trim().length > 0;
}

function isRepeatReadyStatus(status: SessionStatus): boolean {
  return status === 'idle' || status === 'done' || status === 'waiting_input';
}

function isAutoCompactReadyStatus(status: SessionStatus): boolean {
  return status === 'idle' || status === 'done';
}

function isAutoCompactBusyStatus(status: SessionStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'thinking' || status === 'tool_executing';
}

function clampRepeatIntervalSeconds(seconds: number): number {
  return Math.min(24 * 60 * 60, Math.max(1, Math.floor(seconds)));
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, '-').slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized.slice(0, 12);
}

function defaultTagsForHostname(hostname: string): string[] {
  return normalizeTags([getDefaultHostTag(hostname)]);
}

export class Session extends EventEmitter {
  readonly id: string;
  readonly name: string;
  /** @internal exposed for coordinator IPC forwarding */
  readonly adapter: BaseAdapter;
  /** Local sessions have their PTY size controlled by the CLI terminal, not web */
  isLocal = false;
  autoApprove = false;
  autoCompact = false;
  repeatEnabled = false;
  repeatCommand = '';
  repeatIntervalSeconds = DEFAULT_REPEAT_INTERVAL_SECONDS;
  repeatClear = false;
  tags: string[] = [];
  private events: NormalizedEvent[] = [];
  private rawEvents: NormalizedEvent[] = [];
  private rawBytes = 0;
  /** Monotonic total raw bytes ever written; never decreases (even after eviction). */
  private _rawBytesEverWritten = 0;
  private _endTime?: number;
  private _metadata: SessionInfo['metadata'] = {};
  private _command: string[] = [];
  private _cwd: string;
  private _workspaceCwd: string;
  private _hostname: string;
  private _initialHostname: string;
  private _autoCompactMinutes = DEFAULT_AUTO_COMPACT_MINUTES;
  /**
   * Auto-approve state machine. Driven by a tick that polls the headless
   * screen — completely independent of status:change events, which historically
   * raced with sub-agent output and got the Enter key cancelled at the
   * worst possible moment.
   *
   * - _autoApproveTicker: setInterval handle (null when disabled).
   * - _autoApprovePromptFirstSeenAt: when we first saw the current prompt;
   *   used to enforce the initial-dwell delay.
   * - _autoApproveLastPressAt: timestamp of the last \r we sent, for cooldown.
   * - _autoApprovePressCount: consecutive presses for THIS prompt instance.
   * - _autoApprovePromptLastSeenAt: when the prompt last looked visible; if
   *   it stays gone for AUTO_APPROVE_RESET_MS, we consider this prompt done
   *   and reset the counters for the next one.
   */
  private _autoApproveTicker: ReturnType<typeof setInterval> | null = null;
  private _autoApprovePromptFirstSeenAt: number | null = null;
  private _autoApprovePromptLastSeenAt: number | null = null;
  private _autoApproveLastPressAt = 0;
  private _autoApprovePressCount = 0;
  private _autoApprovePromptFingerprint: string | null = null;
  private _autoApproveEligibility: 'no_prompt' | 'unverified_prompt' | 'eligible' = 'no_prompt';
  private _autoApproveRuleId: string | null = null;
  private _autoCompactTimer: ReturnType<typeof setTimeout> | null = null;
  private _repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private _repeatClearTimer: ReturnType<typeof setTimeout> | null = null;
  private _submitTimers = new Set<ReturnType<typeof setTimeout>>();
  private _nextAutoCompactAt: number | undefined;
  private _nextRepeatAt: number | undefined;
  private _autoCompactBlockedUntilBusy = false;
  private _autoCompactWaitingForRunToIdle = false;
  /** User-facing status. The adapter keeps its lower-level lifecycle separately. */
  private _publishedStatus: SessionStatus = 'starting';
  private _seen = true;
  /** Set after a real post-start work cycle and consumed by its next idle. */
  private _workCyclePending = false;
  private _workCycleShouldPublishDone = true;
  private _suppressNextWorkCycleDone = false;
  private _nextWorkCycleIsUserWork = false;
  private _acknowledgingDone = false;
  private _stateChangeSeq = 0;

  constructor(id: string, name: string, adapter: BaseAdapter, opts?: { cwd?: string; hostname?: string }) {
    super();
    this.id = id;
    this.name = name;
    this.adapter = adapter;
    this._cwd = opts?.cwd ?? process.cwd();
    this._workspaceCwd = this._cwd;
    this._hostname = opts?.hostname ?? _hostname;
    this._initialHostname = this._hostname;
    this.tags = defaultTagsForHostname(this._hostname);

    this.adapter.on('event', (event: NormalizedEvent) => {
      this.handleEvent(event);
    });
  }

  get info(): SessionInfo {
    return {
      id: this.id,
      name: this.name,
      tool: this.adapter.info.name,
      adapterInfo: this.adapter.info,
      status: this._publishedStatus,
      seen: this._seen,
      stateChangeSeq: this._stateChangeSeq,
      startTime: this.adapter.startTime,
      endTime: this._endTime,
      cwd: this._cwd,
      workspaceCwd: this._workspaceCwd,
      command: this._command,
      recentEvents: this.events.slice(-MAX_RECENT_EVENTS),
      metadata: { ...this._metadata },
    };
  }

  get summary(): SessionSummary {
    return {
      id: this.id,
      name: this.name,
      tool: this.adapter.info.name,
      status: this._publishedStatus,
      seen: this._seen,
      stateChangeSeq: this._stateChangeSeq,
      startTime: this.adapter.startTime,
      endTime: this._endTime,
      displayName: this.adapter.info.displayName,
      icon: this.adapter.info.icon,
      cwd: this._cwd,
      hostname: this._hostname,
      initialHostname: this._initialHostname,
      autoApprove: this.autoApprove || undefined,
      autoCompact: this.autoCompact || undefined,
      repeatEnabled: this.repeatEnabled || undefined,
      repeatCommand: hasRepeatCommand(this.repeatCommand) ? this.repeatCommand : undefined,
      repeatIntervalSeconds: this.repeatIntervalSeconds !== DEFAULT_REPEAT_INTERVAL_SECONDS
        ? this.repeatIntervalSeconds
        : undefined,
      repeatClear: this.repeatClear || undefined,
      nextRepeatAt: this._nextRepeatAt,
      nextAutoCompactAt: this._nextAutoCompactAt,
      tags: this.tags.length > 0 ? [...this.tags] : undefined,
    };
  }

  get status() {
    return this._publishedStatus;
  }

  get seen(): boolean {
    return this._seen;
  }

  get stateChangeSeq(): number {
    return this._stateChangeSeq;
  }

  start(): void {
    this.adapter.start();
  }

  write(data: string): void {
    this.markSeen();
    this.adapter.write(data);
  }

  /**
   * A visible client acknowledges the current result. `done` is sticky until
   * this acknowledgement, then folds back to the adapter's ordinary idle.
   */
  markSeen(): void {
    if (this._seen && this._publishedStatus !== 'done') return;
    this._seen = true;
    this._acknowledgingDone = this._publishedStatus === 'done';
    try {
      this.handleEvent({
        type: 'status:change',
        sessionId: this.id,
        timestamp: Date.now(),
        data: {
          from: this._publishedStatus,
          to: this._publishedStatus === 'done' ? 'idle' : this._publishedStatus,
        },
      });
    } finally {
      this._acknowledgingDone = false;
    }
  }

  resize(cols: number, rows: number): void {
    this.adapter.resize(cols, rows);
  }

  /** Trigger SIGWINCH at current PTY size — forces ink apps to redraw */
  redraw(): void {
    this.adapter.redraw();
  }

  kill(signal?: string): void {
    this.adapter.kill(signal);
  }

  setSettings(patch: SessionSettingsPatch): void {
    if (patch.autoApprove !== undefined) {
      this.autoApprove = patch.autoApprove;
      if (this.autoApprove) {
        this.startAutoApproveTicker();
      } else {
        this.stopAutoApproveTicker();
      }
    }
    if (patch.autoCompact !== undefined) {
      this.autoCompact = patch.autoCompact;
      this._autoCompactBlockedUntilBusy = false;
      this._autoCompactWaitingForRunToIdle = false;
    }
    if (patch.repeatEnabled !== undefined) {
      this.repeatEnabled = patch.repeatEnabled;
    }
    if (patch.repeatCommand !== undefined) {
      this.repeatCommand = normalizeRepeatCommand(patch.repeatCommand);
    }
    if (patch.repeatIntervalSeconds !== undefined) {
      this.repeatIntervalSeconds = clampRepeatIntervalSeconds(patch.repeatIntervalSeconds);
    }
    if (patch.repeatClear !== undefined) {
      this.repeatClear = patch.repeatClear;
    }
    if (patch.tags !== undefined) {
      this.tags = normalizeTags(patch.tags);
    }

    if (this.autoCompact && isAutoCompactReadyStatus(this.adapter.status)) {
      this.scheduleAutoCompact();
    } else {
      this.clearAutoCompactTimer();
    }

    if (this.repeatEnabled && isRepeatReadyStatus(this.adapter.status)) {
      this.scheduleRepeat();
    } else if (!this.repeatEnabled) {
      this.clearRepeatTimers();
    }
  }

  setAutoCompactMinutes(minutes: number): void {
    const clamped = Math.min(24 * 60, Math.max(1, Math.floor(minutes)));
    this._autoCompactMinutes = clamped;
    if (this.autoCompact && isAutoCompactReadyStatus(this.adapter.status)) {
      this.scheduleAutoCompact();
    }
  }

  getRecentEvents(): NormalizedEvent[] {
    const structured = this.events.slice(-MAX_RECENT_EVENTS);
    const rawSubset = this._rawTailUpTo(INITIAL_RAW_REPLAY_BYTES);
    return [...rawSubset, ...structured].sort((a, b) => a.timestamp - b.timestamp);
  }

  getRecentStructuredEvents(): NormalizedEvent[] {
    return this.events.slice(-MAX_RECENT_EVENTS);
  }

  getRawEventsSince(fromOffset: number): NormalizedEvent[] {
    const requested = Math.max(0, Math.floor(fromOffset));
    return this.rawEvents.filter((event) => {
      const data = event.data as RawOutputData;
      return typeof data.offsetEnd !== 'number' || data.offsetEnd > requested;
    });
  }

  /**
   * Snapshot of raw chunks in [fromOffset, toOffset), defaulting to the current
   * end. Returns the actual start (may be > fromOffset if older bytes were
   * evicted from the in-memory ring) and a flag indicating whether the start
   * matches the earliest data the server still retains.
   *
   * `toOffset` lets a client that already holds the newer bytes ask for ONLY the
   * older delta. Without it a "load earlier" re-sends everything from the
   * requested offset to the live end — for a full ring that is one ~21MB base64
   * message per page, which is the history-load freeze. A client that caches
   * what it has streamed can instead page back in bounded chunks.
   */
  getRawHistorySnapshot(fromOffset: number, toOffset?: number): {
    startOffset: number;
    endOffset: number;
    chunks: string[];
    reachedEarliest: boolean;
  } {
    const earliest = this._rawBytesEverWritten - this.rawBytes;
    const requested = Math.max(0, Math.floor(fromOffset));
    const startTarget = Math.max(earliest, requested);
    const endTarget = typeof toOffset === 'number' && Number.isFinite(toOffset)
      ? Math.min(this._rawBytesEverWritten, Math.max(startTarget, Math.floor(toOffset)))
      : this._rawBytesEverWritten;
    // Walk BACKWARD from the newest event and stop at startTarget, rather than
    // scanning the whole ring from the front and skipping everything older. The
    // cost is then O(events in the requested window), not O(events in the ring):
    // a busy session holds 100k+ tiny raw events, so a front-to-back scan made
    // even a small "load earlier" pay for the entire ring — and that price grows
    // with MAX_RAW_BYTES, which is why enlarging the ring used to slow paging
    // down. Same traversal shape as _rawTailUpTo(). The result is identical:
    // still [startTarget, END], just assembled in reverse.
    const reversed: string[] = [];
    let startOffset = endTarget;
    let endOffset = endTarget;
    let sawChunk = false;
    for (let i = this.rawEvents.length - 1; i >= 0; i--) {
      const data = this.rawEvents[i].data as RawOutputData;
      const offsetEnd = data.offsetEnd;
      // Offsets are assigned in handleEvent and only ever grow, so the first
      // event at or before startTarget means everything below it is older too.
      // Guard the missing-offset case the way the forward scan did (skip, don't
      // stop) so one unstamped event can't truncate the window.
      if (typeof offsetEnd !== 'number') continue;
      if (offsetEnd <= startTarget) break;
      const size = base64ByteLength(data.data);
      // Wholly newer than the window — keep walking back into range.
      if (offsetEnd - size >= endTarget) continue;
      // A chunk STRADDLING endTarget is included whole and endOffset reports how
      // far it actually reaches, which may overshoot what was asked for. Chunks
      // are never split (they are opaque base64 units), and dropping a straddler
      // instead would silently leave a hole between this page and what the
      // caller already holds — a torn rebuild. Callers must trim the overlap
      // using endOffset.
      if (!sawChunk) {
        endOffset = offsetEnd;
        sawChunk = true;
      }
      // The TRUE start of the oldest chunk returned, not the requested bound.
      // Chunks come back whole at both ends, so clamping this up to startTarget
      // (what this used to do) under-reported the range and left the reply
      // covering more bytes than [startOffset, endOffset) claimed — which breaks
      // any caller splicing by byte count.
      startOffset = offsetEnd - size;
      reversed.push(data.data);
    }
    // Collected newest-first; unshift() per event would be O(n^2).
    const matched = reversed.reverse();
    return {
      startOffset,
      endOffset,
      // Coalesce the (often 100k+) tiny chunks into a handful of large ones.
      // Purely a transport/processing optimization — the client concatenates
      // them, so the rendered bytes are identical.
      chunks: coalesceBase64Chunks(matched, SNAPSHOT_CHUNK_BYTES),
      reachedEarliest: startOffset <= earliest,
    };
  }

  /**
   * Latest `maxBytes` of raw output, coalesced into one base64 blob, plus the
   * current end offset. Used to resync a client that fell too far behind: the
   * server drops the stale backlog and sends a terminal reset + this tail so the
   * client snaps to the current screen instead of grinding through seconds of
   * queued output. Dropped intermediate bytes are scrolled-off content; the
   * reset (RIS) prepended by the caller clears any dangling escape state.
   */
  getRawResyncTail(maxBytes: number): { data: string; offsetEnd: number } {
    const tail = this._rawTailUpTo(maxBytes);
    const buf = Buffer.concat(
      tail.map((e) => Buffer.from((e.data as RawOutputData).data, 'base64')),
    );
    return { data: buf.toString('base64'), offsetEnd: this._rawBytesEverWritten };
  }

  /**
   * In-memory buffer sizes for diagnostics (debug endpoint). Lets us see
   * whether a session is hoarding raw output (toward the 16MB cap) which
   * inflates every subscribe/replay and can stall slow tunnels.
   */
  getBufferStats(): {
    events: number;
    rawEvents: number;
    rawBytes: number;
    rawBytesEverWritten: number;
    detectBufferLen: number;
  } {
    return {
      events: this.events.length,
      rawEvents: this.rawEvents.length,
      rawBytes: this.rawBytes,
      rawBytesEverWritten: this._rawBytesEverWritten,
      detectBufferLen: this.adapter.detectBuffer.length,
    };
  }

  /**
   * Raw bytes written within the last `windowMs` — instantaneous output
   * throughput. A session flooding the dashboard (MB/s) is the signature of a
   * client-side freeze: the bytes drain from the server fine but overwhelm
   * xterm. Computed from the existing rawEvents ring, no extra bookkeeping.
   */
  getRecentRawBytes(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    let bytes = 0;
    for (let i = this.rawEvents.length - 1; i >= 0; i--) {
      const evt = this.rawEvents[i];
      if (evt.timestamp < cutoff) break;
      bytes += base64ByteLength((evt.data as RawOutputData).data);
    }
    return bytes;
  }

  /** Tail of rawEvents covering at most `maxBytes` from the end. */
  private _rawTailUpTo(maxBytes: number): NormalizedEvent[] {
    if (this.rawBytes <= maxBytes) return this.rawEvents.slice();
    const out: NormalizedEvent[] = [];
    let bytes = 0;
    for (let i = this.rawEvents.length - 1; i >= 0; i--) {
      const evt = this.rawEvents[i];
      const b64 = (evt.data as RawOutputData).data;
      const size = base64ByteLength(b64);
      if (bytes + size > maxBytes && out.length > 0) break;
      out.unshift(evt);
      bytes += size;
    }
    return out;
  }

  private handleEvent(inputEvent: NormalizedEvent): void {
    let event = inputEvent;
    if (event.type === 'status:change') {
      const raw = event.data as { from: SessionStatus; to: SessionStatus };
      const previous = this._publishedStatus;
      let next = raw.to;

      if (isAutoCompactBusyStatus(raw.to)) {
        // The initial starting -> busy -> idle handshake is readiness, not a
        // completed user task. Later transitions into busy open a work cycle.
        if (!isAutoCompactBusyStatus(previous) && previous !== 'starting' && !this._workCyclePending) {
          this._workCyclePending = true;
          this._workCycleShouldPublishDone = this._nextWorkCycleIsUserWork
            && !this._suppressNextWorkCycleDone;
          this._nextWorkCycleIsUserWork = false;
          this._suppressNextWorkCycleDone = false;
        }
      } else if (raw.to === 'idle' && this._workCyclePending) {
        next = this._workCycleShouldPublishDone ? 'done' : 'idle';
        this._workCyclePending = false;
        if (next === 'done') this._seen = false;
      } else if (raw.to === 'idle' && previous === 'done' && !this._acknowledgingDone) {
        // Renderers may publish the same idle frame repeatedly. `done` is an
        // acknowledgement state, so only markSeen() is allowed to fold it.
        next = 'done';
      }

      if (next !== previous) {
        this._stateChangeSeq++;
        if (next === 'waiting_input' || next === 'done' || next === 'completed' || next === 'error') {
          this._seen = false;
        }
      }
      this._publishedStatus = next;
      event = {
        ...event,
        data: {
          ...raw,
          from: previous,
          to: next,
          stateChangeSeq: this._stateChangeSeq,
          seen: this._seen,
        },
      };
    }

    if (event.type === 'raw:output') {
      const tRing = PROF.profiling ? PROF.nowNs() : 0n;
      const rawData = event.data as RawOutputData;
      const b64 = rawData.data;
      const size = base64ByteLength(b64);
      this._rawBytesEverWritten += size;
      rawData.offsetEnd = this._rawBytesEverWritten;
      this.rawEvents.push(event);
      this.rawBytes += size;
      if (this.rawBytes > MAX_RAW_BYTES) {
        // Count how many leading events to drop to reach the low-water mark,
        // then remove them in a single splice.
        const toFree = this.rawBytes - RAW_EVICT_LOW_WATER_BYTES;
        let dropCount = 0;
        let freed = 0;
        while (dropCount < this.rawEvents.length - 1 && freed < toFree) {
          freed += base64ByteLength((this.rawEvents[dropCount].data as RawOutputData).data);
          dropCount++;
        }
        if (dropCount > 0) {
          this.rawEvents.splice(0, dropCount);
          this.rawBytes -= freed;
        }
      }
      if (PROF.profiling) PROF.mark('ring.append', tRing, size, this.id);
    } else {
      this.events.push(event);

      // Trim old events to prevent memory growth
      if (this.events.length > MAX_RECENT_EVENTS * 2) {
        this.events = this.events.slice(-MAX_RECENT_EVENTS);
      }
    }

    switch (event.type) {
      case 'session:start': {
        const data = event.data as { command: string[]; cwd: string };
        this._command = data.command;
        this._cwd = data.cwd;
        break;
      }
      case 'session:end': {
        this._endTime = event.timestamp;
        this.stopAutoApproveTicker();
        this.clearAutoCompactTimer();
        this.clearRepeatTimers();
        this.clearSubmitTimers();
        break;
      }
      case 'cwd:change': {
        const data = event.data as { cwd: string; hostname?: string };
        this._cwd = data.cwd;
        if (data.hostname) this._hostname = data.hostname;
        break;
      }
      case 'user:input': {
        this._nextWorkCycleIsUserWork = true;
        this._seen = true;
        break;
      }
      case 'status:change': {
        const data = event.data as { from: SessionStatus; to: SessionStatus };
        // Auto-approve no longer reacts to status transitions; the ticker
        // started in setSettings polls the screen directly. That avoids a
        // class of bugs where sub-agent output flicked status:change → running
        // mid-prompt and cancelled the pending Enter.
        // A fresh waiting transition is still a useful prompt-generation
        // boundary: queued sub-agent approvals can replace one card with the
        // next before the screen ever becomes prompt-free. Clear the dwell
        // and retry budget here; the ticker will arm itself against the new
        // card on its next poll.
        if (data.to === 'waiting_input' && data.from !== 'waiting_input' && this.autoApprove) {
          this.resetAutoApproveState();
        }
        if (isAutoCompactBusyStatus(data.to) && this._autoCompactBlockedUntilBusy && !this._autoCompactWaitingForRunToIdle) {
          this._autoCompactBlockedUntilBusy = false;
        }
        if (isRepeatReadyStatus(data.to)) {
          this.scheduleRepeat();
        } else {
          this.clearRepeatTimer();
        }
        if (isAutoCompactReadyStatus(data.to) && this._autoCompactWaitingForRunToIdle) {
          this._autoCompactWaitingForRunToIdle = false;
        }
        if (this.autoCompact && isAutoCompactReadyStatus(data.to)) {
          this.scheduleAutoCompact();
        } else {
          this.clearAutoCompactTimer();
        }
        break;
      }
      case 'metadata': {
        const meta = event.data as MetadataData;
        if (meta.model) this._metadata.model = meta.model;
        if (meta.costUsd !== undefined) this._metadata.costUsd = (this._metadata.costUsd ?? 0) + meta.costUsd;
        if (meta.durationMs !== undefined) this._metadata.durationMs = meta.durationMs;
        if (meta.inputTokens !== undefined) this._metadata.inputTokens = (this._metadata.inputTokens ?? 0) + meta.inputTokens;
        if (meta.outputTokens !== undefined) this._metadata.outputTokens = (this._metadata.outputTokens ?? 0) + meta.outputTokens;
        break;
      }
    }

    // Re-emit for upstream consumers (session manager, web server)
    this.emit('event', event);
  }

  private startAutoApproveTicker(): void {
    if (this._autoApproveTicker) return;
    this.resetAutoApproveState();
    // Run a tick once immediately so tests / fresh enables don't wait an
    // extra interval before noticing an already-visible prompt.
    this.tickAutoApprove();
    this._autoApproveTicker = setInterval(() => this.tickAutoApprove(), AUTO_APPROVE_TICK_MS);
    (this._autoApproveTicker as { unref?: () => void }).unref?.();
  }

  private stopAutoApproveTicker(): void {
    if (this._autoApproveTicker) {
      clearInterval(this._autoApproveTicker);
      this._autoApproveTicker = null;
    }
    this.resetAutoApproveState();
  }

  private resetAutoApproveState(): void {
    this._autoApprovePromptFirstSeenAt = null;
    this._autoApprovePromptLastSeenAt = null;
    this._autoApproveLastPressAt = 0;
    this._autoApprovePressCount = 0;
    this._autoApprovePromptFingerprint = null;
    this._autoApproveEligibility = 'no_prompt';
    this._autoApproveRuleId = null;
  }

  /**
   * One tick: require a currently visible, structurally verified approval
   * whose selected default is explicitly safe for Enter. A waiting status by
   * itself is enough to notify the user, but never enough to authorize input.
   */
  private tickAutoApprove(): void {
    if (!this.autoApprove) return;

    const now = Date.now();
    const status = this.adapter.status;
    if (status === 'completed' || status === 'error') {
      this.stopAutoApproveTicker();
      return;
    }

    const screen = this.adapter.getScreenSnapshot();
    const promptVisible = status === 'waiting_input' || screen.promptVisible;

    if (!promptVisible) {
      this._autoApproveEligibility = 'no_prompt';
      this._autoApproveRuleId = null;
      // Reset only after the prompt has been gone for a while, so a single
      // frame of mid-redraw blank doesn't lose our press counter.
      if (this._autoApprovePromptLastSeenAt
          && now - this._autoApprovePromptLastSeenAt >= AUTO_APPROVE_RESET_MS) {
        this.resetAutoApproveState();
      }
      return;
    }

    const detection = screen.detection;
    const fingerprint = waitingPromptFingerprint(screen.recent);
    const verifiedPrompt = detection?.rawState === 'blocked'
      && detection.visibleBlocker
      && detection.automationSafe
      && Boolean(detection.matchedRuleId)
      && Boolean(fingerprint);

    if (!verifiedPrompt) {
      // A blocking menu can be perfectly valid without being safe to approve
      // automatically (for example, a model picker or a cursor on "No").
      // Drop any retry budget from the preceding card immediately so it can
      // never spill into this one.
      this.resetAutoApproveState();
      this._autoApproveEligibility = 'unverified_prompt';
      this._autoApproveRuleId = detection?.matchedRuleId ?? null;
      return;
    }

    // A group of sub-agents can queue several approval cards back-to-back.
    // Claude replaces the old card with the next in the same render frame, so
    // there is no prompt-free 2s gap to reset the retry counter. Treat changed
    // card content as a new prompt immediately. A redraw of unchanged content
    // keeps the existing counter and therefore retains the anti-spam backoff.
    if (fingerprint && this._autoApprovePromptFingerprint
        && fingerprint !== this._autoApprovePromptFingerprint) {
      this.resetAutoApproveState();
    }
    if (fingerprint) this._autoApprovePromptFingerprint = fingerprint;
    this._autoApproveEligibility = 'eligible';
    this._autoApproveRuleId = detection.matchedRuleId ?? null;

    this._autoApprovePromptLastSeenAt = now;
    if (this._autoApprovePromptFirstSeenAt == null) {
      this._autoApprovePromptFirstSeenAt = now;
    }

    // Wait for initial dwell — gives the app a moment to finish rendering
    // before we press the default option.
    if (now - this._autoApprovePromptFirstSeenAt < AUTO_APPROVE_INITIAL_DELAY_MS) {
      return;
    }

    // Cooldown between presses for the same prompt.
    // Cooldown widens once the fast budget is spent: if the first couple of
    // Enters didn't take, the next press won't either, and spamming \r can
    // accidentally accept whatever new prompt the app eventually does show
    // (e.g. dispatching the same agent multiple times). Stay armed but poll
    // at a recovery rate.
    const cooldown = this._autoApprovePressCount >= AUTO_APPROVE_FAST_PRESSES
      ? AUTO_APPROVE_SLOW_COOLDOWN_MS
      : AUTO_APPROVE_PRESS_COOLDOWN_MS;
    if (this._autoApproveLastPressAt
        && now - this._autoApproveLastPressAt < cooldown) {
      return;
    }

    // forwardKeys (not write) so a remote session's status stays
    // waiting_input until the remote actually moves past the prompt —
    // otherwise the local input state machine flips us to "running".
    // Most PTYs report Enter as CR, but a few SSH/Ink combinations leave the
    // approval widget listening for LF instead. Keep the first two fast
    // retries identical to a real xterm Enter (preserving normal behavior),
    // then try LF during the slower recovery phase so a stuck prompt can
    // recover without sending two Enter events back-to-back.
    const enter = this._autoApprovePressCount % 3 === 2 ? '\n' : '\r';
    this.adapter.forwardKeys(enter);
    this.handleEvent({
      type: 'automation:action',
      sessionId: this.id,
      timestamp: now,
      data: {
        action: 'press_enter',
        policy: 'verified_prompt',
        ruleId: detection.matchedRuleId!,
        key: enter === '\r' ? 'cr' : 'lf',
        attempt: this._autoApprovePressCount + 1,
      } satisfies AutomationActionData,
    });
    this._autoApproveLastPressAt = now;
    this._autoApprovePressCount++;
  }

  /** Diagnostic snapshot of the auto-approve ticker state. */
  getAutoApproveDebug(): {
    enabled: boolean;
    tickerActive: boolean;
    promptFirstSeenAt: number | null;
    promptLastSeenAt: number | null;
    lastPressAt: number;
    pressCount: number;
    eligibility: 'no_prompt' | 'unverified_prompt' | 'eligible';
    ruleId: string | null;
    sinceFirstSeenMs: number | null;
    sinceLastPressMs: number | null;
  } {
    const now = Date.now();
    return {
      enabled: this.autoApprove,
      tickerActive: this._autoApproveTicker !== null,
      promptFirstSeenAt: this._autoApprovePromptFirstSeenAt,
      promptLastSeenAt: this._autoApprovePromptLastSeenAt,
      lastPressAt: this._autoApproveLastPressAt,
      pressCount: this._autoApprovePressCount,
      eligibility: this._autoApproveEligibility,
      ruleId: this._autoApproveRuleId,
      sinceFirstSeenMs: this._autoApprovePromptFirstSeenAt
        ? now - this._autoApprovePromptFirstSeenAt
        : null,
      sinceLastPressMs: this._autoApproveLastPressAt
        ? now - this._autoApproveLastPressAt
        : null,
    };
  }

  private scheduleAutoCompact(delayMs?: number): void {
    this.clearAutoCompactTimer();
    if (!this.autoCompact || !isAutoCompactReadyStatus(this.adapter.status)) return;
    if (this._autoCompactBlockedUntilBusy) return;

    const waitMs = delayMs ?? this._autoCompactMinutes * 60 * 1000;
    this._nextAutoCompactAt = Date.now() + waitMs;
    this._autoCompactTimer = setTimeout(() => {
      this.runAutoCompact();
    }, waitMs);
  }

  private runAutoCompact(): void {
    this._autoCompactTimer = null;
    this._nextAutoCompactAt = undefined;
    if (!this.autoCompact || !isAutoCompactReadyStatus(this.adapter.status)) return;

    // Context maintenance is not a user task completion and should not create
    // an unread `done` notification when its command returns to idle.
    this._suppressNextWorkCycleDone = true;
    this.submitSlashCommand(AUTO_COMPACT_COMMAND);
    this._autoCompactBlockedUntilBusy = true;
    this._autoCompactWaitingForRunToIdle = isAutoCompactBusyStatus(this.adapter.status);
  }

  private clearAutoCompactTimer(): void {
    if (this._autoCompactTimer) {
      clearTimeout(this._autoCompactTimer);
      this._autoCompactTimer = null;
    }
    this._nextAutoCompactAt = undefined;
  }

  private scheduleRepeat(): void {
    this.clearRepeatTimer();
    if (!this.repeatEnabled || !hasRepeatCommand(this.repeatCommand) || ['completed', 'error'].includes(this.adapter.status)) return;

    this._nextRepeatAt = Date.now() + this.repeatIntervalSeconds * 1000;
    this._repeatTimer = setTimeout(() => {
      this._repeatTimer = null;
      this._nextRepeatAt = undefined;
      this.runRepeat();
    }, this.repeatIntervalSeconds * 1000);
  }

  private runRepeat(): void {
    if (!this.repeatEnabled || !hasRepeatCommand(this.repeatCommand) || !isRepeatReadyStatus(this.adapter.status)) return;

    if (!this.repeatClear) {
      this.submitCommand(this.repeatCommand);
      return;
    }

    this.submitCommand(REPEAT_CLEAR_COMMAND);
    this.clearRepeatClearTimer();
    this._repeatClearTimer = setTimeout(() => {
      this._repeatClearTimer = null;
      if (!this.repeatEnabled || !hasRepeatCommand(this.repeatCommand) || ['completed', 'error'].includes(this.adapter.status)) return;
      this.submitCommand(this.repeatCommand);
    }, REPEAT_CLEAR_DELAY_MS);
  }

  private clearRepeatTimer(): void {
    if (this._repeatTimer) {
      clearTimeout(this._repeatTimer);
      this._repeatTimer = null;
    }
    this._nextRepeatAt = undefined;
  }

  private clearRepeatClearTimer(): void {
    if (this._repeatClearTimer) {
      clearTimeout(this._repeatClearTimer);
      this._repeatClearTimer = null;
    }
  }

  private clearRepeatTimers(): void {
    this.clearRepeatTimer();
    this.clearRepeatClearTimer();
  }

  private submitSlashCommand(command: string): void {
    this.submitCommand(command);
  }

  private submitCommand(command: string): void {
    const normalized = command.replace(/[\r\n]+$/, '');
    this.write(`${normalized}\n`);
    this.scheduleSubmitWrite('\x0D\x0A', 200);
    this.scheduleSubmitWrite('\r', 500);
  }

  private scheduleSubmitWrite(data: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this._submitTimers.delete(timer);
      if (['completed', 'error'].includes(this.adapter.status)) return;
      this.write(data);
    }, delayMs);
    this._submitTimers.add(timer);
  }

  private clearSubmitTimers(): void {
    for (const timer of this._submitTimers) {
      clearTimeout(timer);
    }
    this._submitTimers.clear();
  }
}
