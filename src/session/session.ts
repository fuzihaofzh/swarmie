import { EventEmitter } from 'node:events';
import { hostname as osHostname } from 'node:os';
import type { BaseAdapter } from '../adapters/base.js';
import type { NormalizedEvent, MetadataData, RawOutputData, SessionStatus } from '../adapters/types.js';
import type { SessionInfo, SessionSummary } from './types.js';
import { getDefaultHostTag } from './host.js';

const _hostname = osHostname();

const MAX_RECENT_EVENTS = 1000;
// In-memory cap for raw terminal output per session. Held so the dashboard
// can scroll back through history on demand without persisting to disk.
const MAX_RAW_BYTES = 16 * 1024 * 1024; // 16MB
// Cap on raw bytes returned by getRecentEvents() (initial subscribe / route
// replay). Larger than this is fetched on demand via history:load so clients
// don't pay a 16MB transfer on every connect.
const INITIAL_RAW_REPLAY_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_AUTO_COMPACT_MINUTES = 60;
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

function normalizeRepeatCommand(command: string): string {
  return command.replace(/[\r\n]+/g, ' ');
}

function hasRepeatCommand(command: string): boolean {
  return command.trim().length > 0;
}

function isRepeatReadyStatus(status: SessionStatus): boolean {
  return status === 'idle' || status === 'waiting_input';
}

function isAutoCompactReadyStatus(status: SessionStatus): boolean {
  return status === 'idle';
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
  private _hostname: string;
  private _initialHostname: string;
  private _autoCompactMinutes = DEFAULT_AUTO_COMPACT_MINUTES;
  private _autoApproveTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoCompactTimer: ReturnType<typeof setTimeout> | null = null;
  private _repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private _repeatClearTimer: ReturnType<typeof setTimeout> | null = null;
  private _submitTimers = new Set<ReturnType<typeof setTimeout>>();
  private _nextAutoCompactAt: number | undefined;
  private _nextRepeatAt: number | undefined;
  private _autoCompactBlockedUntilBusy = false;
  private _autoCompactWaitingForRunToIdle = false;

  constructor(id: string, name: string, adapter: BaseAdapter, opts?: { cwd?: string; hostname?: string }) {
    super();
    this.id = id;
    this.name = name;
    this.adapter = adapter;
    this._cwd = opts?.cwd ?? process.cwd();
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
      status: this.adapter.status,
      startTime: this.adapter.startTime,
      endTime: this._endTime,
      cwd: this._cwd,
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
      status: this.adapter.status,
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
    return this.adapter.status;
  }

  start(): void {
    this.adapter.start();
  }

  write(data: string): void {
    this.adapter.write(data);
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
      if (this.autoApprove && this.adapter.status === 'waiting_input') {
        this.scheduleAutoApprove();
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

  /**
   * Snapshot of raw chunks from `fromOffset` (inclusive) up to the current end.
   * Returns the actual start (may be > fromOffset if older bytes were evicted
   * from the in-memory ring) and a flag indicating whether the start matches
   * the earliest data the server still retains.
   */
  getRawHistorySnapshot(fromOffset: number): {
    startOffset: number;
    endOffset: number;
    chunks: string[];
    reachedEarliest: boolean;
  } {
    const earliest = this._rawBytesEverWritten - this.rawBytes;
    const requested = Math.max(0, Math.floor(fromOffset));
    const startTarget = Math.max(earliest, requested);
    const chunks: string[] = [];
    let startOffset = this._rawBytesEverWritten;
    for (const evt of this.rawEvents) {
      const data = evt.data as RawOutputData;
      const offsetEnd = data.offsetEnd ?? 0;
      const size = Math.ceil(data.data.length * 3 / 4);
      const chunkStart = offsetEnd - size;
      if (offsetEnd <= startTarget) continue;
      if (chunks.length === 0) startOffset = Math.max(chunkStart, startTarget);
      chunks.push(data.data);
    }
    return {
      startOffset,
      endOffset: this._rawBytesEverWritten,
      chunks,
      reachedEarliest: startOffset <= earliest,
    };
  }

  /** Tail of rawEvents covering at most `maxBytes` from the end. */
  private _rawTailUpTo(maxBytes: number): NormalizedEvent[] {
    if (this.rawBytes <= maxBytes) return this.rawEvents.slice();
    const out: NormalizedEvent[] = [];
    let bytes = 0;
    for (let i = this.rawEvents.length - 1; i >= 0; i--) {
      const evt = this.rawEvents[i];
      const b64 = (evt.data as RawOutputData).data;
      const size = Math.ceil(b64.length * 3 / 4);
      if (bytes + size > maxBytes && out.length > 0) break;
      out.unshift(evt);
      bytes += size;
    }
    return out;
  }

  private handleEvent(event: NormalizedEvent): void {
    if (event.type === 'raw:output') {
      const rawData = event.data as RawOutputData;
      const b64 = rawData.data;
      const size = Math.ceil(b64.length * 3 / 4);
      this._rawBytesEverWritten += size;
      rawData.offsetEnd = this._rawBytesEverWritten;
      this.rawEvents.push(event);
      this.rawBytes += size;
      while (this.rawBytes > MAX_RAW_BYTES && this.rawEvents.length > 0) {
        const old = this.rawEvents.shift()!;
        const oldB64 = (old.data as RawOutputData).data;
        this.rawBytes -= Math.ceil(oldB64.length * 3 / 4);
      }
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
        this.clearAutoApproveTimer();
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
      case 'status:change': {
        const data = event.data as { from: SessionStatus; to: SessionStatus };
        if (data.to === 'waiting_input' && this.autoApprove) {
          this.scheduleAutoApprove();
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

  private scheduleAutoApprove(): void {
    if (this._autoApproveTimer) return;
    this._autoApproveTimer = setTimeout(() => {
      this._autoApproveTimer = null;
      if (this.autoApprove && this.adapter.status === 'waiting_input') {
        this.write('\r');
      }
    }, 1000);
  }

  private clearAutoApproveTimer(): void {
    if (this._autoApproveTimer) {
      clearTimeout(this._autoApproveTimer);
      this._autoApproveTimer = null;
    }
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
