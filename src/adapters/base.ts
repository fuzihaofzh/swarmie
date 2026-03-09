import { EventEmitter } from 'node:events';
import { readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NormalizedEvent, NormalizedEventType, EventData, AdapterInfo, SessionStatus, CwdChangeData } from './types.js';

const execFileAsync = promisify(execFile);

// Plain substrings that indicate the tool is waiting for user input.
const WAITING_INPUT_SUBSTRINGS = [
  'Do you want to',
  'Esc to cancel',
  '(y/n)',
  '(Y/n)',
  '(yes/no)',
];

// Max chars to keep in the rolling stripped-text buffer for detection.
const DETECT_BUFFER_SIZE = 1000;

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
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _cwdTimer: ReturnType<typeof setInterval> | null = null;
  /** Rolling buffer of ANSI-stripped text for waiting_input detection */
  private _detectBuffer: string = '';

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

  /** Re-send current size to trigger SIGWINCH (forces ink apps to redraw) */
  redraw(): void {
    this.resize(this.cols, this.rows);
  }

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

  /**
   * Call from subclass onData handler to auto-detect idle / waiting_input.
   * Uses a rolling buffer of stripped text so that prompts split across
   * multiple PTY chunks are still detected.
   */
  protected handleActivityDetection(chunk: string): void {
    // Strip ANSI codes (replacing with space) and normalize whitespace.
    // Ink renders text with cursor positioning between words, so a single
    // prompt may arrive as many small chunks with embedded escape sequences.
    const stripped = chunk
      .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, ' ')       // OSC
      .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, ' ')         // CSI
      .replace(/\x1b[^\[].?/g, ' ')                      // other ESC
      .replace(/[\x00-\x1f]/g, ' ')                      // control chars
      .replace(/\s+/g, ' ');                              // normalize whitespace

    // Append to rolling buffer, trim to max size
    this._detectBuffer += stripped;
    if (this._detectBuffer.length > DETECT_BUFFER_SIZE) {
      this._detectBuffer = this._detectBuffer.slice(-DETECT_BUFFER_SIZE);
    }

    // Check for waiting-for-input prompts (from any active state).
    if (this._status !== 'waiting_input' && this._status !== 'completed' && this._status !== 'error') {
      for (const needle of WAITING_INPUT_SUBSTRINGS) {
        if (this._detectBuffer.includes(needle)) {
          this.setStatus('waiting_input');
          this.clearIdleTimer();
          this._detectBuffer = ''; // Reset so we don't re-trigger
          return;
        }
      }
    }

    // Any PTY output (even pure escape sequences) means the process is active.
    if (this._status !== 'waiting_input') {
      if (this._status === 'idle') {
        this.setStatus('running');
      }
      this.resetIdleTimer();
    }
  }

  /** Start polling the cwd of a child process by PID */
  protected startCwdPolling(pid: number): void {
    this.stopCwdPolling();
    this._cwdTimer = setInterval(() => this.pollCwd(pid), 5000);
  }

  protected stopCwdPolling(): void {
    if (this._cwdTimer) {
      clearInterval(this._cwdTimer);
      this._cwdTimer = null;
    }
  }

  private async pollCwd(pid: number): Promise<void> {
    try {
      let resolvedCwd: string;
      if (process.platform === 'linux') {
        resolvedCwd = await readlink(`/proc/${pid}/cwd`);
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
        const match = stdout.match(/\nn(.*)/);
        if (!match) return;
        resolvedCwd = match[1];
      } else {
        return; // unsupported platform
      }
      if (resolvedCwd && resolvedCwd !== this.cwd) {
        this.cwd = resolvedCwd;
        this.emitEvent('cwd:change', { cwd: resolvedCwd } satisfies CwdChangeData);
      }
    } catch {
      // Process may have exited, ignore
    }
  }

  /** Call from subclass write() to clear waiting state when user sends input */
  protected handleUserInput(): void {
    if (this._status === 'waiting_input') {
      this.setStatus('running');
    }
    // Clear detect buffer so old prompts don't re-trigger
    this._detectBuffer = '';
  }

  /** Call from subclass onExit to clean up timers */
  protected clearIdleTimer(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this.stopCwdPolling();
  }

  private resetIdleTimer(): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this._status === 'running' || this._status === 'tool_executing') {
        this.setStatus('idle');
      }
    }, 10000);
  }
}
