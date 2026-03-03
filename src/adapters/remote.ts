import { BaseAdapter, type AdapterOptions } from './base.js';
import type { AdapterInfo, NormalizedEvent } from './types.js';

/**
 * A virtual adapter that represents a session from a remote polycode instance.
 * Events are pushed in via `pushEvent()` rather than spawning a process.
 */
export class RemoteAdapter extends BaseAdapter {
  private _info: AdapterInfo;
  private _isRunning = true;

  constructor(
    options: AdapterOptions,
    info: AdapterInfo,
  ) {
    super(options);
    this._info = info;
  }

  get info(): AdapterInfo {
    return this._info;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    this.setStatus('running');
  }

  /** Push an event from the IPC server into this adapter */
  pushEvent(event: NormalizedEvent): void {
    if (event.type === 'session:end') {
      this._isRunning = false;
    }
    if (event.type === 'status:change') {
      const data = event.data as { to: string };
      this._status = data.to as typeof this._status;
    }
    this.emit('event', event);
  }

  /** Set by coordinator to forward input via IPC */
  onWrite?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onKill?: (signal?: string) => void;

  write(data: string): void {
    this.onWrite?.(data);
  }

  resize(cols: number, rows: number): void {
    this.onResize?.(cols, rows);
  }

  kill(signal?: string): void {
    this.onKill?.(signal);
  }
}
