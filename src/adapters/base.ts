import { EventEmitter } from 'node:events';
import { readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname as osHostname } from 'node:os';
import type { NormalizedEvent, NormalizedEventType, EventData, AdapterInfo, SessionStatus, CwdChangeData } from './types.js';

const execFileAsync = promisify(execFile);

// Regexes that indicate the tool is waiting for user input.
// Use .{0,N} between words to tolerate Ink's cursor-based rendering
// which may insert unrelated characters between words of a single phrase.
const WAITING_INPUT_PATTERNS = [
  /Do.{0,5}you.{0,5}want.{0,5}to/,
  /Esc.{0,5}to.{0,5}cancel/,
  /Tab.{0,5}to.{0,5}amend/,
  /proceed\?/,
  /Yes,.{0,5}allow/,
  /\(y\/n\)/,
  /\(Y\/n\)/,
  /\(yes\/no\)/,
];

// Characters that are purely decorative / animation and should not
// pollute the detect buffer (Ink thinking spinners, bullet chars, etc.)
const ANIMATION_CHARS = /[⏺✶✸✹✺✻✼✽✾✿❀❁❂❃❄❅❆✢✣✤✥✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵·•●○◌◎◐◑◒◓◔◕⊙⊚⊛⊜⊝★☆]/g;

// Max chars to keep in the rolling stripped-text buffer for detection.
const DETECT_BUFFER_SIZE = 1000;

const ESC_CHAR = String.fromCharCode(0x1b);
const BEL_CHAR = String.fromCharCode(0x07);
const NUL_CHAR = String.fromCharCode(0x00);
const US_CHAR = String.fromCharCode(0x1f);

// OSC 7: file://hostname/path — shell reports cwd (+ hostname for SSH)
const OSC7_RE = new RegExp(
  `${ESC_CHAR}\\]7;file://([^/]*)(/[^${BEL_CHAR}${ESC_CHAR}]*?)(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`,
  'g',
);
// OSC 0/2: window title, often "user@host:path" or "host:path"
const OSC_TITLE_RE = new RegExp(
  `${ESC_CHAR}\\][02];([^${BEL_CHAR}${ESC_CHAR}]*?)(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`,
  'g',
);
const OSC_ANY_RE = new RegExp(`${ESC_CHAR}\\].*?(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`, 'g');
const CSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[A-Za-z~]`, 'g');
const ESC_OTHER_RE = new RegExp(`${ESC_CHAR}[^\\[].?`, 'g');
const CONTROL_CHARS_RE = new RegExp(`[${NUL_CHAR}-${US_CHAR}]`, 'g');

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
  protected hostname: string;
  private _initialHostname: string;
  protected cols: number;
  protected rows: number;
  protected _status: SessionStatus = 'starting';
  protected _startTime: number = Date.now();
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _cwdTimer: ReturnType<typeof setInterval> | null = null;
  /** Rolling buffer of ANSI-stripped text for waiting_input detection */
  private _detectBuffer: string = '';
  /** Expose detect buffer for debugging */
  get detectBuffer(): string { return this._detectBuffer; }
  /** True when cwd is being tracked via OSC sequences (e.g. SSH session) */
  private _oscCwdActive: boolean = false;

  abstract get info(): AdapterInfo;

  constructor(options: AdapterOptions) {
    super();
    this.sessionId = options.sessionId;
    this.toolArgs = options.toolArgs;
    this.cwd = options.cwd ?? process.cwd();
    this.hostname = osHostname();
    this._initialHostname = this.hostname;
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
      .replace(OSC_ANY_RE, ' ')                          // OSC
      .replace(CSI_RE, ' ')                              // CSI
      .replace(ESC_OTHER_RE, ' ')                        // other ESC
      .replace(CONTROL_CHARS_RE, ' ')                    // control chars
      .replace(ANIMATION_CHARS, ' ')                      // thinking spinners
      .replace(/\s+/g, ' ');                              // normalize whitespace

    // Append to rolling buffer, trim to max size
    this._detectBuffer += stripped;
    if (this._detectBuffer.length > DETECT_BUFFER_SIZE) {
      this._detectBuffer = this._detectBuffer.slice(-DETECT_BUFFER_SIZE);
    }

    // Check for waiting-for-input prompts (from any active state).
    if (this._status !== 'waiting_input' && this._status !== 'completed' && this._status !== 'error') {
      for (const pattern of WAITING_INPUT_PATTERNS) {
        if (pattern.test(this._detectBuffer)) {
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

  /**
   * Parse OSC escape sequences for cwd and hostname changes.
   * OSC 7: file://hostname/path — shell reports cwd (works across SSH).
   * OSC 0/2: window title, often "user@host:path" — fallback for SSH.
   */
  protected parseOSC(chunk: string): void {
    let match: RegExpExecArray | null;

    // OSC 7: authoritative cwd + hostname
    OSC7_RE.lastIndex = 0;
    while ((match = OSC7_RE.exec(chunk)) !== null) {
      const host = match[1] || this.hostname;
      const newCwd = decodeURIComponent(match[2]);
      const changed = (newCwd && newCwd !== this.cwd) || (host !== this.hostname);
      if (changed) {
        if (newCwd) this.cwd = newCwd;
        this.hostname = host;
        this._oscCwdActive = true;
        this.emitEvent('cwd:change', { cwd: this.cwd, hostname: this.hostname } satisfies CwdChangeData);
      }
    }

    // OSC 0/2: fallback — only extract cwd path, not hostname
    // (hostname in title can be unreliable, e.g. conda sets it to arch name)
    OSC_TITLE_RE.lastIndex = 0;
    while ((match = OSC_TITLE_RE.exec(chunk)) !== null) {
      const title = match[1].trim();
      // Match "user@host:path" or "host:path"
      const titleMatch = title.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
      if (!titleMatch) continue;
      const path = titleMatch[2].trim();
      // Only use if path looks absolute
      if (!path.startsWith('/') && !path.startsWith('~')) continue;
      if (path !== this.cwd) {
        if (path !== '~') this.cwd = path;
        this._oscCwdActive = true;
        this.emitEvent('cwd:change', { cwd: this.cwd, hostname: this.hostname } satisfies CwdChangeData);
      }
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
    // Skip polling when OSC sequences are actively tracking cwd (e.g. SSH)
    if (this._oscCwdActive) return;
    try {
      // Find the deepest descendant process — that's the actual shell/agent
      const leafPid = await this.findLeafChild(pid);
      let resolvedCwd: string;
      if (process.platform === 'linux') {
        resolvedCwd = await readlink(`/proc/${leafPid}/cwd`);
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(leafPid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
        const match = stdout.match(/\nn(.*)/);
        if (!match) return;
        resolvedCwd = match[1];
      } else {
        return;
      }
      if (resolvedCwd && resolvedCwd !== this.cwd) {
        this.cwd = resolvedCwd;
        this.emitEvent('cwd:change', { cwd: resolvedCwd, hostname: this.hostname } satisfies CwdChangeData);
      }
    } catch {
      // Process may have exited, ignore
    }
  }

  /** Walk process tree to find the deepest child (leaf) process */
  private async findLeafChild(pid: number): Promise<number> {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 2000 });
      const children = stdout.trim().split('\n').filter(Boolean).map(Number);
      if (children.length === 0) return pid;
      // Recurse into the last child (most likely the foreground process)
      return this.findLeafChild(children[children.length - 1]);
    } catch {
      return pid; // no children or pgrep failed
    }
  }

  /** Call from subclass write() to clear waiting state when user sends input */
  protected handleUserInput(): void {
    if (this._status === 'waiting_input') {
      this.setStatus('running');
      // Only clear buffer on state transition so new prompt text
      // arriving concurrently isn't lost
      this._detectBuffer = '';
    }
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
