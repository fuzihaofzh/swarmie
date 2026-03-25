import * as pty from 'node-pty';
import { BaseAdapter } from './base.js';
import type {
  AdapterInfo,
  RawOutputData,
  SessionStartData,
  SessionEndData,
} from './types.js';

export class GeminiAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;

  get info(): AdapterInfo {
    return {
      name: 'gemini',
      displayName: 'Gemini CLI',
      icon: '\u2728',
      command: 'gemini',
      supportsStructured: true,
    };
  }

  get isRunning(): boolean {
    return this.ptyProcess !== null && this._status !== 'completed' && this._status !== 'error';
  }

  start(): void {
    this._startTime = Date.now();
    const command = 'gemini';
    const args = this.toolArgs;

    this.emitEvent('session:start', {
      tool: 'gemini',
      command: [command, ...args],
      cwd: this.cwd,
    } satisfies SessionStartData);

    this.setStatus('running');

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: process.env as Record<string, string>,
    });
    this.startCwdPolling(this.ptyProcess.pid);

    this.ptyProcess.onData((data: string) => {
      this.handleActivityDetection(data);
      this.parseOSC(data);
      this.emitEvent('raw:output', {
        data: Buffer.from(data).toString('base64'),
      } satisfies RawOutputData);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.setStatus(exitCode === 0 ? 'completed' : 'error');
      this.emitEvent('session:end', {
        exitCode,
        signal: signal !== undefined ? String(signal) : null,
      } satisfies SessionEndData);
      this.ptyProcess = null;
    });
  }

  write(data: string): void {
    this.handleUserInput();
    this.ptyProcess?.write(data);
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
