import { EventEmitter } from 'node:events';
import { readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname as osHostname } from 'node:os';
import type { NormalizedEvent, NormalizedEventType, EventData, AdapterInfo, SessionStatus, CwdChangeData } from './types.js';
import { ESC_CHAR, BEL_CHAR } from './ansi.js';
import { HeadlessScreen } from './screen.js';
import * as PROF from '../server/profile.js';

const execFileAsync = promisify(execFile);

const COMMAND_IDLE_TIMEOUT_MS = 30_000;
const ACTIVITY_CHECK_INTERVAL_MS = 2_000;
const USER_INPUT_ACTIVE_MS = 3_000;
const SCREEN_MOVEMENT_REPEAT_WINDOW_MS = 10_000;
const SCREEN_MOVEMENT_BUSY_TTL_MS = 5_000;
// How long a completely unchanged screen may keep a session marked busy. Agent
// CLIs repaint their status line about once a second while they work, so a
// screen frozen this long means the work ended (or the process died) with a
// busy-looking frame left on it.
const SCREEN_FROZEN_TIMEOUT_MS = 45_000;

// Patterns that indicate a tool is waiting for user input. Matched against
// the rendered screen text from the headless terminal — not against the raw
// PTY stream — so cursor-positioned redraws, animations, kitty/modifyOtherKeys
// sequences, and chunk fragmentation all wash out before we look.
// How many logical lines at the bottom of the screen count as the "status
// region". Agent CLIs draw their spinner and their approval box there; the
// rows above are transcript prose. Matching status patterns against the prose
// is what made an assistant sentence like "Do you want me to also update the
// tests?" ring the waiting-for-input bell, so detection only reads the tail.
const STATUS_REGION_LINES = 14;

// Patterns that indicate a tool is waiting for user input. These deliberately
// key off *structure* (a numbered choice list, a keybinding hint) rather than
// question wording: wording appears in ordinary output, structure does not.
const WAITING_INPUT_PATTERNS = [
  // Approval boxes render a numbered choice list — "❯ 1. Yes" / "  2. No" —
  // optionally inside a box-drawing border. Far more stable than the prompt
  // sentence printed above it, which every CLI words differently. Left
  // unanchored because redraw artifacts (spinner glyphs, box edges) can share
  // the row; the "N. Yes/No" shape is the signal.
  /\d+\.[^\S\n]+(?:Yes|No)\b/i,
  /\bEsc\b[^\n]{0,40}\bto\b[^\n]{0,40}\bcancel\b/i,
  /\bTab\b[^\n]{0,40}\bto\b[^\n]{0,40}\bamend\b/i,
  /\bPress\b[^\n]{0,40}\benter\b[^\n]{0,40}\bto\b[^\n]{0,40}\bconfirm\b/i,
  // Anchored to end-of-line so a "(y/n)" inside a diff or a source line the
  // agent happens to be printing does not count as a live shell prompt.
  /\(y\/n\)[^\S\n]*$/im,
  /\(yes\/no\)[^\S\n]*$/im,
];
const WAITING_PROMPT_TOOL_NAMES = new Set(['claude', 'codex', 'gemini']);

// Busy state lines rendered by current agent CLIs. These are sampled from the
// headless screen, so matching them is more reliable than relying only on
// recent keypress/output timing; long-running agent calls can be quiet for
// more than COMMAND_IDLE_TIMEOUT_MS while the visible status line still says
// they are working.
const BUSY_SCREEN_PATTERNS = [
  // The interrupt affordance is the one thing agent CLIs keep on screen for
  // the whole time they work, and unlike the spinner verb it is not
  // randomized. This replaces a hardcoded list of Claude Code's spinner words
  // ("Baking", "Cogitating", …) that could never keep up with the real set.
  /\besc\b[^\n]{0,20}\bto\b[^\n]{0,20}\binterrupt\b/i,
  // Elapsed-time counter in a status line: "(12s ·", "(1m 4s ·".
  /\(\s*(?:\d+m\s*)?\d+s\s*[·•]/,
  /\b(?:streaming response|tool executing|running tool|running command)\b/i,
  /\b(?:Working|Thinking)\b[^\n]{0,80}\b(?:context left|tokens?)\b/i,
  /\b(?:Claude|Codex|Gemini)\b[^\n]{0,80}\b(?:streaming response|working|thinking)\b/i,
];

// Agent idle/input prompt text. This is distinct from approval prompts above:
// the app is alive but waiting for the user's next task, so the tab should be
// idle rather than busy.
const AGENT_IDLE_SCREEN_PATTERNS = [
  /\bnew task\?\s*\/clear\b/i,
  /\?\s*for shortcuts\b/i,
  /\btab to queue message\b/i,
  /(?:^|\n)\s*[›❯]\s*(?:\n|$)/,
];

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
const SGR_MOUSE_INPUT_RE = new RegExp(`^${ESC_CHAR}\\[<\\d+;\\d+;\\d+[mM]`);
const X10_MOUSE_INPUT_RE = new RegExp(`^${ESC_CHAR}\\[M[\\s\\S]{3}`);
const URXVT_MOUSE_INPUT_RE = new RegExp(`^${ESC_CHAR}\\[\\d+;\\d+;\\d+M`);

/**
 * Minimum gap between full screen samples in the detection pipeline.
 *
 * Sampling builds two whole-screen strings and runs ~20 regexes, so its cost
 * tracks chunk *count*, not chunk size. A redrawing spinner emits dozens of
 * chunks a second, which turned that into dozens of full-screen scans a second
 * on the event loop — enough to show up as keystroke latency. Bursts now
 * collapse into a leading sample plus a trailing one, so a settled screen is
 * still always evaluated.
 */
const DETECT_SAMPLE_INTERVAL_MS = Number(process.env.SWARMIE_DETECT_INTERVAL_MS ?? '80');

function isSubmittedInput(data: string): boolean {
  return data.includes('\r') || data.includes('\n');
}

function isInactiveStatus(status: SessionStatus): boolean {
  return status === 'idle' || status === 'waiting_input' || status === 'completed' || status === 'error';
}

function isBusyStatus(status: SessionStatus): boolean {
  return status === 'running' || status === 'thinking' || status === 'tool_executing';
}

function passiveInputTokenLength(data: string): number {
  if (data.startsWith(`${ESC_CHAR}[I`) || data.startsWith(`${ESC_CHAR}[O`)) return 3;
  for (const pattern of [SGR_MOUSE_INPUT_RE, X10_MOUSE_INPUT_RE, URXVT_MOUSE_INPUT_RE]) {
    const match = pattern.exec(data);
    if (match) return match[0].length;
  }
  return 0;
}

function stripPassiveTerminalInput(data: string): string {
  let rest = data;
  let meaningful = '';
  while (rest.length > 0) {
    const len = passiveInputTokenLength(rest);
    if (len > 0) {
      rest = rest.slice(len);
      continue;
    }
    meaningful += rest[0];
    rest = rest.slice(1);
  }
  return meaningful;
}

export interface AdapterOptions {
  sessionId: string;
  toolArgs: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

/**
 * Build a spawn env that strips COLUMNS/LINES so children query the PTY
 * via ioctl (TIOCGWINSZ) instead of reading a stale value inherited from
 * the swarmie process's own launch terminal. Python's
 * shutil.get_terminal_size() — and therefore tqdm — prefers $COLUMNS when
 * set, so without this scrub a narrowed PTY still produces wide progress
 * bars and viewers re-wrap them.
 */
export function buildSpawnEnv(extraExclude: string[] = []): Record<string, string> {
  const exclude = new Set(['COLUMNS', 'LINES', ...extraExclude]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (exclude.has(k)) continue;
    env[k] = v;
  }
  return env;
}

/** Snapshot of detection-relevant state, for diagnostics + the Session-level poller. */
export interface ScreenSnapshot {
  /** Text currently visible in the viewport. */
  viewport: string;
  /** Viewport + a small scrollback window. */
  recent: string;
  /** Whether any waiting-input pattern matches recent screen text right now. */
  promptVisible: boolean;
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
  private _activityCheckInterval: ReturnType<typeof setInterval> | null = null;
  private _userInputTimer: ReturnType<typeof setTimeout> | null = null;
  private _screenMovementTimer: ReturnType<typeof setTimeout> | null = null;
  private _userInputActive = false;
  private _commandExecuting = false;
  private _lastActivity = Date.now();
  private _lastScreenFrame = '';
  private _lastScreenChangeAt = 0;
  private _cwdTimer: ReturnType<typeof setInterval> | null = null;
  /** Headless terminal that mirrors the rendered screen. */
  private _screen: HeadlessScreen;
  /**
   * Throttle window for screen sampling. Overridable so tests can assert the
   * classification logic directly without driving timers; see the throttle's
   * own coverage in tests/activity-detection.test.ts.
   */
  protected detectSampleIntervalMs: number = DETECT_SAMPLE_INTERVAL_MS;
  /** Timestamp of the last full screen sample (see DETECT_SAMPLE_INTERVAL_MS). */
  private _lastDetectAt: number = 0;
  /** Pending trailing sample for chunks that arrived inside the throttle window. */
  private _detectTrailingTimer: ReturnType<typeof setTimeout> | null = null;
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
    this._screen = new HeadlessScreen(this.cols, this.rows);
  }

  get status(): SessionStatus {
    return this._status;
  }

  get startTime(): number {
    return this._startTime;
  }

  /**
   * Current screen text — what the user would see. Used by the Session-level
   * auto-approve poller and by debug endpoints.
   */
  getScreenSnapshot(): ScreenSnapshot {
    const recent = this._screen.getRecentText(20);
    const viewport = this._screen.getViewportText();
    const promptVisible = this.shouldDetectWaitingPrompt() && matchesWaitingPrompt(recent);
    return { viewport, recent, promptVisible };
  }

  /**
   * Back-compat alias. The old detectBuffer was a rolling stripped-text buffer;
   * callers (server /api/debug/auto-approve and getBufferStats) only ever read
   * its `.length` and last 500 chars for diagnostics, so returning the current
   * screen text is a strictly better substitute.
   */
  get detectBuffer(): string {
    return this._screen.getRecentText(20);
  }

  protected shouldDetectWaitingPrompt(): boolean {
    return WAITING_PROMPT_TOOL_NAMES.has(this.info.name);
  }

  /**
   * Whether visible output with no submitted-command context should be treated
   * as the app having reached an idle prompt. Interactive shells override this
   * behavior through their adapter; direct long-running commands should keep
   * running until they exit instead of turning gray after their first output.
   */
  protected shouldSettleVisibleOutputToIdle(_screenText: string): boolean {
    return true;
  }

  /** Whether the currently rendered screen explicitly says the tool is busy. */
  protected shouldTreatScreenAsBusy(screenText: string): boolean {
    return matchesBusyScreen(screenText);
  }

  /** Whether repeated visible screen changes should count as agent activity. */
  protected shouldTreatScreenMovementAsBusy(_screenText: string): boolean {
    return WAITING_PROMPT_TOOL_NAMES.has(this.info.name);
  }

  /** Start the underlying tool process */
  abstract start(): void;

  /** Send input to the tool (for interactive mode) */
  abstract write(data: string): void;

  /**
   * Send keystrokes WITHOUT marking the session as a user-submitted command.
   * Used by auto-approve: routing its Enter through write() runs the
   * user-input state machine, which for a remote session locally flips status
   * to "running" even though the remote prompt may not have been accepted —
   * masking that we're still waiting and defeating retries. Defaults to
   * write(); RemoteAdapter overrides to forward without touching input state.
   */
  forwardKeys(data: string): void {
    this.write(data);
  }

  /**
   * Centralized resize: keeps the headless screen in sync with whatever the
   * subclass does to the real (or virtual) PTY. Subclasses implement
   * applyResize for tool-specific behavior.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this._screen.resize(cols, rows);
    this._lastScreenFrame = normalizeScreenForMovement(this._screen.getViewportText());
    this._lastScreenChangeAt = 0;
    this.applyResize(cols, rows);
  }

  protected abstract applyResize(cols: number, rows: number): void;

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
    if (isInactiveStatus(newStatus)) {
      this.stopCommandTracking();
      this.stopUserInputTracking();
      this.stopScreenMovementTimer();
    } else if (isBusyStatus(newStatus) && !this._activityCheckInterval) {
      // Every route into a busy status arms the idle watchdog, not just
      // submitted commands — otherwise a session marked busy by a screen
      // pattern has nothing left to walk it back down.
      this.startCommandTimeout();
    }
    this.emitEvent('status:change', { from, to: newStatus });
  }

  protected get isCommandExecuting(): boolean {
    return this._commandExecuting;
  }

  protected applyExternalStatus(newStatus: SessionStatus): void {
    this._status = newStatus;
    if (isInactiveStatus(newStatus)) {
      this.stopCommandTracking();
      this.stopUserInputTracking();
    }
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
   * Feed a PTY chunk through the detection pipeline. Writes to the headless
   * screen, then samples the rendered screen to decide between
   * waiting_input / idle. Synchronous because the headless terminal supports
   * a synchronous write path — chunks are reflected on the screen before we
   * read it.
   */
  protected handleActivityDetection(chunk: string): void {
    // Apply ANSI / cursor moves / alt-buffer toggles to the virtual screen.
    // Never throttled: skipping a write would desync the screen from the PTY.
    const tScreen = PROF.profiling ? PROF.nowNs() : 0n;
    this._screen.write(chunk);
    if (PROF.profiling) PROF.mark('act.screenWrite', tScreen, chunk.length, this.sessionId);

    // Any output is activity, including pure ANSI redraws — that's what keeps
    // long-running work marked busy. This is not gated on commandExecuting:
    // the idle sweep now watches every busy session, not just submitted
    // commands, so a session streaming output must refresh its timer whether
    // or not the user pressed Enter to start it.
    this._lastActivity = Date.now();

    if (this._status === 'completed' || this._status === 'error') return;

    const now = Date.now();
    const sinceLast = now - this._lastDetectAt;
    if (sinceLast >= this.detectSampleIntervalMs) {
      this._lastDetectAt = now;
      this.evaluateScreenState();
      return;
    }

    // Inside the throttle window. Defer to a trailing sample so the screen as
    // it finally settles is still classified — dropping it outright would let
    // a status stick at 'running' after the output stops.
    if (!this._detectTrailingTimer) {
      this._detectTrailingTimer = setTimeout(() => {
        this._detectTrailingTimer = null;
        if (this._status === 'completed' || this._status === 'error') return;
        this._lastDetectAt = Date.now();
        this.evaluateScreenState();
      }, this.detectSampleIntervalMs - sinceLast);
      (this._detectTrailingTimer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Sample the rendered screen and pick a status. Split out of
   * handleActivityDetection so it can be throttled independently of the
   * screen write, which must happen for every chunk.
   */
  private evaluateScreenState(): void {
    const tEval = PROF.profiling ? PROF.nowNs() : 0n;
    const tRead = PROF.profiling ? PROF.nowNs() : 0n;
    const screen = this._screen.getRecentText(20);
    if (PROF.profiling) PROF.mark('act.getRecentText', tRead, screen.length, this.sessionId);
    const screenMoved = this.noteMeaningfulScreenMovement();
    const tRe = PROF.profiling ? PROF.nowNs() : 0n;
    const promptVisible = this.shouldDetectWaitingPrompt() && matchesWaitingPrompt(screen);
    const busyVisible = this.shouldTreatScreenAsBusy(screen);
    if (PROF.profiling) {
      PROF.mark('act.promptRegex', tRe, screen.length, this.sessionId);
      PROF.mark('act.evaluateTotal', tEval, screen.length, this.sessionId);
    }

    if (promptVisible) {
      if (this._status !== 'waiting_input') {
        this.setStatus('waiting_input');
      }
      return;
    }

    if (busyVisible) {
      this._lastActivity = Date.now();
      if (this._status !== 'running' && this._status !== 'thinking' && this._status !== 'tool_executing') {
        this.setStatus('running');
      }
      return;
    }

    if (screenMoved && this.shouldTreatScreenMovementAsBusy(screen)) {
      this._lastActivity = Date.now();
      this.markScreenMovementBusy();
      return;
    }

    // No prompt on screen. If we were in waiting_input, the prompt was
    // dismissed (by Enter we sent, by the user, or by the app moving on).
    if (this._status === 'waiting_input') {
      if (this._commandExecuting) {
        this.setStatus('running');
      } else {
        this.setStatus('idle');
      }
      return;
    }

    // Idle settling: in starting/running with no submitted command and no
    // active user typing, some apps are just drawing an idle prompt. Direct
    // commands are the opposite: their output is the command running, so keep
    // them busy until the process exits.
    if (!this._commandExecuting && !this._userInputActive
        && (this._status === 'starting' || this._status === 'running' || this._status === 'idle')) {
      if (hasVisibleText(screen)) {
        if (this.shouldSettleVisibleOutputToIdle(screen)) {
          if (this._status !== 'idle') this.setStatus('idle');
        } else if (this._status !== 'running') {
          this.setStatus('running');
        }
      }
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

  /** Call from subclass write() to mark a submitted command as executing */
  protected handleUserInput(data = ''): void {
    const meaningfulInput = stripPassiveTerminalInput(data);
    if (!meaningfulInput) return;
    if (this._status === 'completed' || this._status === 'error') return;

    if (!isSubmittedInput(meaningfulInput)) {
      this.markUserInputActive();
      return;
    }

    this.stopUserInputTracking();
    this._commandExecuting = true;
    this._lastActivity = Date.now();
    this.setStatus('running');
    this.startCommandTimeout();
  }

  /** Call from subclass onExit to clean up timers + dispose screen */
  protected clearIdleTimer(): void {
    this.stopCommandTracking();
    this.stopUserInputTracking();
    this.stopScreenMovementTimer();
    this.stopCwdPolling();
    this.stopDetectTrailingTimer();
  }

  private stopDetectTrailingTimer(): void {
    if (this._detectTrailingTimer) {
      clearTimeout(this._detectTrailingTimer);
      this._detectTrailingTimer = null;
    }
  }

  protected disposeScreen(): void {
    try { this._screen.dispose(); } catch { /* terminate is best-effort */ }
  }

  private markUserInputActive(): void {
    this._userInputActive = true;
    this.setStatus('running');
    this.stopUserInputTimer();
    this._userInputTimer = setTimeout(() => {
      this._userInputActive = false;
      this._userInputTimer = null;
      if (!this._commandExecuting && (this._status === 'running' || this._status === 'thinking' || this._status === 'tool_executing')) {
        this.setStatus('idle');
      }
    }, USER_INPUT_ACTIVE_MS);
    (this._userInputTimer as { unref?: () => void }).unref?.();
  }

  private startCommandTimeout(): void {
    this.stopCommandActivityInterval();
    this._activityCheckInterval = setInterval(() => {
      // Runs for as long as the session is busy, however it got there. It used
      // to run only for submitted commands, which left a session marked busy
      // by a screen pattern with no timer at all: once output stopped, nothing
      // re-evaluated it and it stayed busy forever.
      if (!isBusyStatus(this._status)) {
        this.stopCommandActivityInterval();
        return;
      }

      const now = Date.now();
      if (now - this._lastActivity <= COMMAND_IDLE_TIMEOUT_MS) return;

      // A working agent repaints — its elapsed-time counter ticks every
      // second. So a screen that has not changed at all for this long is a
      // dead session, whatever text is frozen on it. Without this check a
      // leftover "esc to interrupt" pinned the session busy permanently: the
      // branch below pushed _lastActivity forward on every tick, so the idle
      // timeout could never be reached.
      const screenFrozen = now - this._lastScreenChangeAt > SCREEN_FROZEN_TIMEOUT_MS;

      if (!screenFrozen && this.shouldTreatScreenAsBusy(this._screen.getRecentText(20))) {
        this._lastActivity = now;
        return;
      }

      this.stopCommandTracking();
      this.setStatus('idle');
    }, ACTIVITY_CHECK_INTERVAL_MS);
    (this._activityCheckInterval as { unref?: () => void }).unref?.();
  }

  private stopCommandTracking(): void {
    this._commandExecuting = false;
    this.stopCommandActivityInterval();
  }

  private stopUserInputTracking(): void {
    this._userInputActive = false;
    this.stopUserInputTimer();
  }

  private stopUserInputTimer(): void {
    if (this._userInputTimer) {
      clearTimeout(this._userInputTimer);
      this._userInputTimer = null;
    }
  }

  private markScreenMovementBusy(): void {
    if (this._status !== 'running' && this._status !== 'thinking' && this._status !== 'tool_executing') {
      this.setStatus('running');
    }
    this.stopScreenMovementTimer();
    this._screenMovementTimer = setTimeout(() => {
      this._screenMovementTimer = null;
      if (this._commandExecuting || this._userInputActive) return;
      if (this._status !== 'running' && this._status !== 'thinking' && this._status !== 'tool_executing') return;
      const screen = this._screen.getRecentText(20);
      if (this.shouldSettleVisibleOutputToIdle(screen)) {
        this.setStatus('idle');
      }
    }, SCREEN_MOVEMENT_BUSY_TTL_MS);
    (this._screenMovementTimer as { unref?: () => void }).unref?.();
  }

  private stopScreenMovementTimer(): void {
    if (this._screenMovementTimer) {
      clearTimeout(this._screenMovementTimer);
      this._screenMovementTimer = null;
    }
  }

  private stopCommandActivityInterval(): void {
    if (this._activityCheckInterval) {
      clearInterval(this._activityCheckInterval);
      this._activityCheckInterval = null;
    }
  }

  private noteMeaningfulScreenMovement(): boolean {
    const now = Date.now();
    const frame = normalizeScreenForMovement(this._screen.getViewportText());
    if (frame === this._lastScreenFrame) return false;

    const hadPreviousFrame = hasVisibleText(this._lastScreenFrame);
    const repeated =
      hadPreviousFrame &&
      this._lastScreenChangeAt > 0 &&
      now - this._lastScreenChangeAt <= SCREEN_MOVEMENT_REPEAT_WINDOW_MS;

    this._lastScreenFrame = frame;
    this._lastScreenChangeAt = hasVisibleText(frame) ? now : 0;
    return repeated && hasVisibleText(frame);
  }
}

/** Exposed so the Session-level auto-approve poller can share the same logic. */
export function matchesWaitingPrompt(screenText: string): boolean {
  const region = statusRegion(screenText);
  for (const pattern of WAITING_INPUT_PATTERNS) {
    if (pattern.test(region)) return true;
  }
  return false;
}

export function matchesBusyScreen(screenText: string): boolean {
  const region = statusRegion(screenText);
  for (const pattern of BUSY_SCREEN_PATTERNS) {
    if (pattern.test(region)) return true;
  }
  return false;
}

/**
 * The bottom slice of the screen, ignoring trailing blank rows — where agent
 * CLIs pin their spinner and their approval box. Restricting status matching
 * to this window keeps transcript prose from being read as a live prompt.
 */
function statusRegion(screenText: string): string {
  const lines = screenText.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(Math.max(0, end - STATUS_REGION_LINES), end).join('\n');
}

export function matchesAgentIdleScreen(screenText: string): boolean {
  for (const pattern of AGENT_IDLE_SCREEN_PATTERNS) {
    if (pattern.test(screenText)) return true;
  }
  return false;
}

function hasVisibleText(screenText: string): boolean {
  return screenText.replace(/\s+/g, '').length > 0;
}

function normalizeScreenForMovement(screenText: string): string {
  return screenText
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}
