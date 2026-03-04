import * as pty from 'node-pty';
import { BaseAdapter } from './base.js';
import type {
  AdapterInfo,
  RawOutputData,
  SessionStartData,
  SessionEndData,
} from './types.js';

/**
 * Generic adapter — runs any command via PTY.
 * Used when the tool name doesn't match a registered adapter.
 */
export class GenericAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;
  private command: string;

  constructor(command: string, options: ConstructorParameters<typeof BaseAdapter>[0]) {
    super(options);
    this.command = command;
  }

  get info(): AdapterInfo {
    return {
      name: this.command,
      displayName: this.command,
      icon: '\u{1F527}',
      command: this.command,
      supportsStructured: false,
    };
  }

  get isRunning(): boolean {
    return this.ptyProcess !== null && this._status !== 'completed' && this._status !== 'error';
  }

  start(): void {
    this._startTime = Date.now();
    const args = this.toolArgs;

    this.emitEvent('session:start', {
      tool: this.command,
      command: [this.command, ...args],
      cwd: this.cwd,
    } satisfies SessionStartData);

    this.setStatus('running');

    this.ptyProcess = pty.spawn(this.command, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: process.env as Record<string, string>,
    });

    this.ptyProcess.onData((data: string) => {
      this.handleActivityDetection(data);
      this.emitEvent('raw:output', {
        data: Buffer.from(data).toString('base64'),
      } satisfies RawOutputData);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.clearIdleTimer();
      this.setStatus(exitCode === 0 ? 'completed' : 'error');
      this.emitEvent('session:end', {
        exitCode,
        signal: signal !== undefined ? String(signal) : null,
      } satisfies SessionEndData);
      this.ptyProcess = null;
    });
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
    this.handleUserInput();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.ptyProcess?.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.ptyProcess?.kill(signal);
  }
}
