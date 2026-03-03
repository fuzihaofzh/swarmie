import { EventEmitter } from 'node:events';
import type { NormalizedEvent, NormalizedEventType, EventData, AdapterInfo, SessionStatus } from './types.js';

export interface AdapterOptions {
  sessionId: string;
  toolArgs: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

export abstract class BaseAdapter extends EventEmitter {
  readonly sessionId: string;
  protected toolArgs: string[];
  protected cwd: string;
  protected cols: number;
  protected rows: number;
  protected _status: SessionStatus = 'starting';
  protected _startTime: number = Date.now();

  abstract get info(): AdapterInfo;

  constructor(options: AdapterOptions) {
    super();
    this.sessionId = options.sessionId;
    this.toolArgs = options.toolArgs;
    this.cwd = options.cwd ?? process.cwd();
    this.cols = options.cols ?? (process.stdout.columns || 80);
    this.rows = options.rows ?? (process.stdout.rows || 24);
  }

  get status(): SessionStatus {
    return this._status;
  }

  get startTime(): number {
    return this._startTime;
  }

  /** Start the underlying tool process */
  abstract start(): void;

  /** Send input to the tool (for interactive mode) */
  abstract write(data: string): void;

  /** Resize the PTY */
  abstract resize(cols: number, rows: number): void;

  /** Kill the underlying process */
  abstract kill(signal?: string): void;

  /** Whether the process is still running */
  abstract get isRunning(): boolean;

  protected setStatus(newStatus: SessionStatus): void {
    const from = this._status;
    if (from === newStatus) return;
    this._status = newStatus;
    this.emitEvent('status:change', { from, to: newStatus });
  }

  protected emitEvent(type: NormalizedEventType, data: EventData): void {
    const event: NormalizedEvent = {
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      data,
    };
    this.emit('event', event);
  }
}
