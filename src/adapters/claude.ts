import * as pty from 'node-pty';
import { BaseAdapter, type AdapterOptions } from './base.js';
import type {
  AdapterInfo,
  RawOutputData,
  SessionStartData,
  SessionEndData,
  AssistantMessageData,
  AssistantMessageDeltaData,
  ToolUseData,
  ToolResultData,
  MetadataData,
} from './types.js';

export class ClaudeAdapter extends BaseAdapter {
  private ptyProcess: pty.IPty | null = null;
  private structuredMode: boolean;
  private jsonBuffer: string = '';

  get info(): AdapterInfo {
    return {
      name: 'claude',
      displayName: 'Claude Code',
      icon: '🤖',
      command: 'claude',
      supportsStructured: true,
    };
  }

  constructor(options: AdapterOptions) {
    super(options);
    // Detect structured mode: if -p/--print flag is present, we can use stream-json
    this.structuredMode = this.toolArgs.some((a) => a === '-p' || a === '--print');
  }

  get isRunning(): boolean {
    return this.ptyProcess !== null && this._status !== 'completed' && this._status !== 'error';
  }

  start(): void {
    this._startTime = Date.now();

    const args = this.buildArgs();
    const command = 'claude';

    this.emitEvent('session:start', {
      tool: 'claude',
      command: [command, ...args],
      cwd: this.cwd,
    } satisfies SessionStartData);

    this.setStatus('running');

    // Spawn PTY — remove CLAUDECODE env to avoid nested detection
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'CLAUDECODE' && v !== undefined) {
        env[k] = v;
      }
    }

    this.ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    });
    this.startCwdPolling(this.ptyProcess.pid);

    this.ptyProcess.onData((data: string) => {
      if (this.structuredMode) {
        this.handleStructuredOutput(data);
      }

      this.handleActivityDetection(data);
      this.parseOSC(data);

      // Always emit raw output for terminal rendering
      this.emitEvent('raw:output', {
        data: Buffer.from(data).toString('base64'),
      } satisfies RawOutputData);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.clearIdleTimer();
      // Flush any remaining structured buffer
      if (this.structuredMode && this.jsonBuffer.trim()) {
        this.processJsonLine(this.jsonBuffer.trim());
        this.jsonBuffer = '';
      }

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
    if (this.ptyProcess) {
      // node-pty kill takes a signal string
      this.ptyProcess.kill(signal);
    }
  }

  private buildArgs(): string[] {
    if (this.structuredMode) {
      const args = [...this.toolArgs];
      // Add stream-json format if not already specified
      if (!args.includes('--output-format')) {
        args.push('--output-format', 'stream-json');
      }
      return args;
    }
    return this.toolArgs;
  }

  /** Parse JSONL stream from `claude -p --output-format stream-json` */
  private handleStructuredOutput(data: string): void {
    this.jsonBuffer += data;

    const lines = this.jsonBuffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.jsonBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.processJsonLine(trimmed);
    }
  }

  private processJsonLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      this.handleParsedEvent(parsed);
    } catch {
      // Not valid JSON — ignore (common with PTY escape sequences mixed in)
    }
  }

  private handleParsedEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    if (type === 'assistant') {
      const message = event.message as { role: string; content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> };
      if (!message?.content) return;

      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          if (event.stop_reason) {
            // Final message
            this.emitEvent('assistant:message', {
              text: block.text,
            } satisfies AssistantMessageData);
          } else {
            // Partial/streaming delta
            this.emitEvent('assistant:message:delta', {
              delta: block.text,
            } satisfies AssistantMessageDeltaData);
          }
        } else if (block.type === 'tool_use' && block.id && block.name) {
          this.setStatus('tool_executing');
          this.emitEvent('tool:use', {
            toolId: block.id,
            toolName: block.name,
            input: block.input ?? {},
          } satisfies ToolUseData);
        } else if (block.type === 'tool_result' && block.id) {
          this.emitEvent('tool:result', {
            toolId: block.id,
            toolName: block.name ?? 'unknown',
            output: block.text ?? '',
          } satisfies ToolResultData);
          this.setStatus('thinking');
        }
      }
    } else if (type === 'result') {
      this.emitEvent('metadata', {
        costUsd: event.cost_usd as number | undefined,
        durationMs: event.duration_ms as number | undefined,
        inputTokens: event.input_tokens as number | undefined,
        outputTokens: event.output_tokens as number | undefined,
      } satisfies MetadataData);
    }
  }
}
