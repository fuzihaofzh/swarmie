import * as pty from 'node-pty';
import { BaseAdapter } from './base.js';
import type {
  AdapterInfo,
  RawOutputData,
  SessionStartData,
  SessionEndData,
  ToolDetectData,
} from './types.js';

const TOOL_SIGNATURES: { pattern: RegExp; tool: string; displayName: string }[] = [
  { pattern: /claude/i, tool: 'claude', displayName: 'Claude Code' },
  { pattern: /codex/i, tool: 'codex', displayName: 'Codex' },
  { pattern: /gemini/i, tool: 'gemini', displayName: 'Gemini' },
];

const ESC_CHAR = String.fromCharCode(0x1b);
const BEL_CHAR = String.fromCharCode(0x07);
const NUL_CHAR = String.fromCharCode(0x00);
const US_CHAR = String.fromCharCode(0x1f);
const OSC_PAYLOAD_RE = new RegExp(
  `${ESC_CHAR}\\]\\d+;([^${BEL_CHAR}${ESC_CHAR}]*?)(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`,
  'g',
);
const OSC_ANY_RE = new RegExp(`${ESC_CHAR}\\].*?(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`, 'g');
const CSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[A-Za-z~]`, 'g');
const ESC_OTHER_RE = new RegExp(`${ESC_CHAR}[^\\[].?`, 'g');
const CONTROL_CHARS_RE = new RegExp(`[${NUL_CHAR}-${US_CHAR}]`, 'g');

/**
 * Generic adapter — runs any command via PTY.
 * Used when the tool name doesn't match a registered adapter.
 */
export class GenericAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;
  private command: string;
  private _detectedTool: string | null = null;
  /** Rolling buffer of stripped text for tool detection after Enter */
  private _detectBuf = '';
  private _detectActive = false;

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
      env: process.env as Record<string, string>,
    });
    this.startCwdPolling(this.ptyProcess.pid);

    this.ptyProcess.onData((data: string) => {
      this.handleActivityDetection(data);
      this.parseOSC(data);
      this.detectTool(data);
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
    // On Enter, start scanning output for tool signatures
    if (data === '\r' || data === '\n') {
      this._detectActive = true;
      this._detectBuf = '';
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.ptyProcess?.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.ptyProcess?.kill(signal);
  }

  /** Scan stripped PTY output for tool names after user presses Enter */
  private detectTool(chunk: string): void {
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
