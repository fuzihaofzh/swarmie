import { EventEmitter } from 'node:events';
import { hostname as osHostname } from 'node:os';
import type { BaseAdapter } from '../adapters/base.js';
import type { NormalizedEvent, MetadataData } from '../adapters/types.js';
import type { SessionInfo, SessionSummary } from './types.js';

const _hostname = osHostname();

const MAX_RECENT_EVENTS = 1000;

export class Session extends EventEmitter {
  readonly id: string;
  readonly name: string;
  /** @internal exposed for coordinator IPC forwarding */
  readonly adapter: BaseAdapter;
  /** Local sessions have their PTY size controlled by the CLI terminal, not web */
  isLocal = false;
  private events: NormalizedEvent[] = [];
  private _endTime?: number;
  private _metadata: SessionInfo['metadata'] = {};
  private _command: string[] = [];
  private _cwd: string;
  private _hostname: string;

  constructor(id: string, name: string, adapter: BaseAdapter, opts?: { cwd?: string; hostname?: string }) {
    super();
    this.id = id;
    this.name = name;
    this.adapter = adapter;
    this._cwd = opts?.cwd ?? process.cwd();
    this._hostname = opts?.hostname ?? _hostname;

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

  getRecentEvents(): NormalizedEvent[] {
    return this.events.slice(-MAX_RECENT_EVENTS);
  }

  private handleEvent(event: NormalizedEvent): void {
    this.events.push(event);

    // Trim old events to prevent memory growth
    if (this.events.length > MAX_RECENT_EVENTS * 2) {
      this.events = this.events.slice(-MAX_RECENT_EVENTS);
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
        break;
      }
      case 'cwd:change': {
        const data = event.data as { cwd: string };
        this._cwd = data.cwd;
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
}
