import * as pty from 'node-pty';
import { BaseAdapter, buildSpawnEnv, matchesAgentIdleScreen, matchesBusyScreen } from './base.js';
import type { AdapterInfo, RawOutputData, SessionStartData, SessionEndData } from './types.js';

/**
 * Base for tools that just need a PTY plus raw-output forwarding and the
 * shared activity/OSC handling (Codex, Gemini). Subclasses only declare their
 * AdapterInfo; `info.command` is the binary that gets spawned.
 */
export abstract class SimplePtyAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;

  abstract get info(): AdapterInfo;

  get isRunning(): boolean {
    return this.ptyProcess !== null && this._status !== 'completed' && this._status !== 'error';
  }

  start(): void {
    this._startTime = Date.now();
    const command = this.info.command;
    const args = this.toolArgs;

    this.emitEvent('session:start', {
      tool: this.info.name,
      command: [command, ...args],
      cwd: this.cwd,
    } satisfies SessionStartData);

    this.setStatus('running');

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: buildSpawnEnv(),
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
      this.clearIdleTimer();
      this.setStatus(exitCode === 0 ? 'completed' : 'error');
      this.emitEvent('session:end', {
        exitCode,
        signal: signal !== undefined ? String(signal) : null,
      } satisfies SessionEndData);
      this.ptyProcess = null;
      this.disposeScreen();
    });
  }

  write(data: string): void {
    this.handleUserInput(data);
    this.ptyProcess?.write(data);
  }

  protected applyResize(cols: number, rows: number): void {
    this.ptyProcess?.resize(cols, rows);
  }

  protected shouldSettleVisibleOutputToIdle(screenText: string): boolean {
    if (matchesBusyScreen(screenText)) return false;
    return matchesAgentIdleScreen(screenText);
  }

  kill(signal?: string): void {
    this.ptyProcess?.kill(signal);
  }
}
