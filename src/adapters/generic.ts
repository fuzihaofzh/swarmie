import * as pty from 'node-pty';
import { BaseAdapter } from './base.js';
import type {
  AdapterInfo,
  RawOutputData,
  SessionStartData,
  SessionEndData,
  ToolDetectData,
  CwdChangeData,
} from './types.js';

const TOOL_SIGNATURES: { pattern: RegExp; tool: string; displayName: string }[] = [
  { pattern: /claude/i, tool: 'claude', displayName: 'Claude Code' },
  { pattern: /codex/i, tool: 'codex', displayName: 'Codex' },
  { pattern: /gemini/i, tool: 'gemini', displayName: 'Gemini' },
];

// OSC 7: \x1b]7;file://host/path BEL — shell reports cwd
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

/**
 * Generic adapter — runs any command via PTY.
 * Used when the tool name doesn't match a registered adapter.
 */
export class GenericAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;
  private command: string;
  private _detectedTool: string | null = null;
  private _lastCwd: string = '';
  /** Rolling buffer of stripped text for tool detection after Enter */
  private _detectBuf = '';
  private _detectActive = false;

  constructor(command: string, options: ConstructorParameters<typeof BaseAdapter>[0]) {
    super(options);
    this.command = command;
    this._lastCwd = this.cwd;
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

  private parseOSC(chunk: string): void {
    let match: RegExpExecArray | null;
    OSC7_RE.lastIndex = 0;
    while ((match = OSC7_RE.exec(chunk)) !== null) {
      const newCwd = decodeURIComponent(match[1]);
      if (newCwd && newCwd !== this._lastCwd) {
        this._lastCwd = newCwd;
        this.cwd = newCwd;
        this.emitEvent('cwd:change', { cwd: newCwd } satisfies CwdChangeData);
      }
    }
  }

  /** Scan stripped PTY output for tool names after user presses Enter */
  private detectTool(chunk: string): void {
    if (!this._detectActive) return;

    // Extract ALL text: OSC content + visible text
    const allText: string[] = [];

    // Extract OSC payload text (titles etc.)
    const oscPayloadRe = /\x1b\]\d+;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    while ((m = oscPayloadRe.exec(chunk)) !== null) {
      allText.push(m[1]);
    }

    // Strip ANSI/control to get visible text
    const stripped = chunk
      .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
      .replace(/\x1b[^\[].?/g, '')
      .replace(/[\x00-\x1f]/g, ' ');
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
