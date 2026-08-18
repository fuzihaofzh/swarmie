import * as pty from 'node-pty';
import { BaseAdapter, buildSpawnEnv, matchesAgentIdleScreen, matchesBusyScreen } from './base.js';
import type {
  AdapterInfo,
  RawOutputData,
  SessionStartData,
  SessionEndData,
  ToolDetectData,
} from './types.js';
import { ESC_CHAR, BEL_CHAR, OSC_ANY_RE, CSI_RE, ESC_OTHER_RE, CONTROL_CHARS_RE } from './ansi.js';
import * as PROF from '../server/profile.js';

// Match each tool by its startup *banner*, not a bare mention. A bare /claude/i
// or /codex/i also fires on a directory named "claude", an OSC title carrying the
// cwd, or an icon label — so detection has to key off text only the real CLI
// prints on launch:
//   Claude Code — "Claude Code v2.0.1" (product name + version)
//   Codex      — "OpenAI Codex (v0.144.6)" inside its startup box
//   Gemini CLI — the "Gemini CLI" footer/banner
const TOOL_SIGNATURES: { pattern: RegExp; tool: string; displayName: string }[] = [
  // \s* between every word: Claude's UI positions each word with a cursor-move
  // escape (\e[NG) rather than spaces, so once CSI is stripped the words fuse —
  // "Claude Code v2.1.212" arrives as "ClaudeCodev2.1.212". Verified against a
  // live PTY capture of the startup banner.
  { pattern: /Claude\s*Code\s*v\d/i, tool: 'claude', displayName: 'Claude Code' },
  { pattern: /OpenAI Codex\s*\(v/i, tool: 'codex', displayName: 'Codex' },
  { pattern: /Gemini CLI/i, tool: 'gemini', displayName: 'Gemini' },
];

const OSC_PAYLOAD_RE = new RegExp(
  `${ESC_CHAR}\\]\\d+;([^${BEL_CHAR}${ESC_CHAR}]*?)(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`,
  'g',
);
// Shell integrations emit OSC 133;A at the beginning of a prompt. OSC 7 is a
// less specific fallback, but in interactive shells it is likewise normally
// emitted by precmd just before the prompt. Seeing either after a detected
// agent has been running gives us a lifecycle boundary that plain rendered
// prompt text cannot provide reliably across arbitrary zsh/bash themes.
const OSC_SHELL_PROMPT_RE = new RegExp(
  `${ESC_CHAR}\\](?:133;A(?:;[^${BEL_CHAR}${ESC_CHAR}]*)?|7;file://[^${BEL_CHAR}${ESC_CHAR}]*)(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`,
);
const AGENT_CRUISE_EXIT_LINE = 'AgentCruise exited.';
const INTERACTIVE_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'tcsh', 'csh', 'ksh', 'dash']);

function basename(command: string): string {
  return command.split('/').filter(Boolean).pop() ?? command;
}

function isInteractiveShellCommand(command: string): boolean {
  return INTERACTIVE_SHELLS.has(basename(command));
}

/**
 * Generic adapter — runs any command via PTY.
 * Used when the tool name doesn't match a registered adapter.
 */
export class GenericAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;
  private command: string;
  private _detectedTool: string | null = null;
  /** Rolling buffer of stripped text scanned for a tool's startup banner. */
  private _detectBuf = '';
  /** Small cross-chunk tails for shell-return markers (PTY reads may split at
   *  any byte, including in the middle of an OSC sequence or exit line). */
  private _shellReturnRawTail = '';
  private _shellReturnTextTail = '';
  /**
   * Whether we're still scanning output for a startup banner. Active from launch
   * (a wrapper that boots straight into the tool prints its banner before any
   * keystroke) and re-armed on each Enter (a shell wrapper only launches the tool
   * after the user types its name). Latches off for that tool's lifetime, so a
   * Claude session that later prints "OpenAI Codex" can't flip its identity;
   * a verified return to the parent shell resets it for the next command.
   */
  private _detectActive = true;

  constructor(command: string, options: ConstructorParameters<typeof BaseAdapter>[0]) {
    super(options);
    this.command = command;
  }

  get info(): AdapterInfo {
    const sig = TOOL_SIGNATURES.find((s) => s.tool === this._detectedTool);
    return {
      name: this._detectedTool ?? this.command,
      displayName: sig?.displayName ?? this.command,
      icon: this._detectedTool ? '' : '\u{1F527}',
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
      env: buildSpawnEnv(),
    });
    this.startCwdPolling(this.ptyProcess.pid);

    this.ptyProcess.onData((data: string) => this.handlePtyData(data));

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
    this.ptyProcess?.write(data);
    this.handleUserInput(data);
    // On Enter, re-arm banner scanning for the command about to run — but never
    // after a tool is already locked in, so its own output can't re-trigger detection.
    if (!this._detectedTool && (data.includes('\r') || data.includes('\n'))) {
      this._detectActive = true;
      this._detectBuf = '';
    }
  }

  protected applyResize(cols: number, rows: number): void {
    this.ptyProcess?.resize(cols, rows);
  }

  protected shouldSettleVisibleOutputToIdle(screenText: string): boolean {
    if (this._detectedTool) {
      if (matchesBusyScreen(screenText)) return false;
      return matchesAgentIdleScreen(screenText);
    }
    return isInteractiveShellCommand(this.command);
  }

  protected shouldTrackOscCwd(): boolean {
    return this._detectedTool === null;
  }

  kill(signal?: string): void {
    this.ptyProcess?.kill(signal);
  }

  /** Process one PTY output chunk. Kept as one unit so lifecycle boundaries
   *  are evaluated in the same order as screen and OSC state. */
  private handlePtyData(data: string): void {
    const tChunk = PROF.profiling ? PROF.nowNs() : 0n;
    const hadDetectedTool = this._detectedTool !== null;
    this.detectTool(data);
    if (PROF.profiling) PROF.mark('pty.detectTool', tChunk, data.length, this.sessionId);

    const tAct = PROF.profiling ? PROF.nowNs() : 0n;
    this.handleActivityDetection(data);
    if (PROF.profiling) PROF.mark('pty.activityDetect', tAct, data.length, this.sessionId);

    const tOsc = PROF.profiling ? PROF.nowNs() : 0n;
    this.parseOSC(data);
    if (PROF.profiling) PROF.mark('pty.parseOSC', tOsc, data.length, this.sessionId);

    // A GenericAdapter often owns a long-lived shell which launches an agent
    // as a child. The child exiting does not fire node-pty's onExit; only the
    // outer shell would do that. Detect the return to the shell explicitly so
    // the session does not retain the agent's running state and identity.
    if (hadDetectedTool && this.didReturnToShell(data)) {
      this.resetDetectedToolAtShellPrompt();
    }

    const tEmit = PROF.profiling ? PROF.nowNs() : 0n;
    this.emitEvent('raw:output', {
      data: Buffer.from(data).toString('base64'),
    } satisfies RawOutputData);
    if (PROF.profiling) {
      PROF.mark('pty.emit+base64', tEmit, data.length, this.sessionId);
      PROF.mark('pty.chunkTotal', tChunk, data.length, this.sessionId);
    }
  }

  private didReturnToShell(data: string): boolean {
    const rawCandidate = this._shellReturnRawTail + data;
    const shellPromptSignal = OSC_SHELL_PROMPT_RE.test(rawCandidate);
    // A complete signal is consumed now even if the busy-screen safety check
    // rejects it, so a nested tool shell cannot trigger a later false return.
    this._shellReturnRawTail = shellPromptSignal ? '' : rawCandidate.slice(-256);

    const visibleChunk = data
      .replace(OSC_ANY_RE, '')
      .replace(CSI_RE, '')
      .replace(ESC_OTHER_RE, '')
      .replace(/\r/g, '');
    this._shellReturnTextTail = (this._shellReturnTextTail + visibleChunk).slice(-512);
    const explicitWrapperExit = this._shellReturnTextTail
      .split('\n')
      .some((line) => line.trim() === AGENT_CRUISE_EXIT_LINE);
    if (explicitWrapperExit) return true;
    if (!shellPromptSignal) return false;

    // An interactive tool command can itself start a shell which emits OSC 7.
    // Do not treat that as the parent prompt while the live screen still has
    // an agent busy line or an approval card.
    const screen = this.getScreenSnapshot();
    return !screen.promptVisible && !matchesBusyScreen(screen.recent);
  }

  private resetDetectedToolAtShellPrompt(): void {
    if (!this._detectedTool) return;
    this._detectedTool = null;
    // Stay quiescent at the returned prompt. write() re-arms detection on the
    // next submitted command; scanning passive shell redraws here could latch
    // onto an old banner repainted from terminal history.
    this._detectActive = false;
    this._detectBuf = '';
    this._shellReturnRawTail = '';
    this._shellReturnTextTail = '';
    this.setStatus('idle');
    this.emitEvent('tool:detect', {
      tool: this.command,
      displayName: this.command,
    } satisfies ToolDetectData);
  }

  /** Scan stripped PTY output for a tool's startup banner (see _detectActive). */
  private detectTool(chunk: string): void {
    if (this._detectedTool) return;
    if (!this._detectActive) return;

    // Extract ALL text: OSC content + visible text
    const allText: string[] = [];

    // Extract OSC payload text (titles etc.)
    let m: RegExpExecArray | null;
    OSC_PAYLOAD_RE.lastIndex = 0;
    while ((m = OSC_PAYLOAD_RE.exec(chunk)) !== null) {
      allText.push(m[1]);
    }

    // Strip ANSI/control to get visible text
    const stripped = chunk
      .replace(OSC_ANY_RE, '')
      .replace(CSI_RE, '')
      .replace(ESC_OTHER_RE, '')
      .replace(CONTROL_CHARS_RE, ' ');
    allText.push(stripped);

    this._detectBuf += allText.join(' ');

    // Cap buffer
    if (this._detectBuf.length > 8000) {
      this._detectActive = false;
      return;
    }

    for (const sig of TOOL_SIGNATURES) {
      if (sig.pattern.test(this._detectBuf)) {
        if (this._detectedTool !== sig.tool) {
          this._detectedTool = sig.tool;
          this.emitEvent('tool:detect', {
            tool: sig.tool,
            displayName: sig.displayName,
          } satisfies ToolDetectData);
        }
        this._detectActive = false;
        return;
      }
    }
  }
}
