import { createWriteStream, mkdirSync, existsSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedEvent } from '../adapters/types.js';
import type { Session } from './session.js';

export class SessionRecorder {
  private stream: WriteStream;
  private startTime: number;
  readonly filePath: string;

  constructor(recordDir: string, session: Session) {
    if (!existsSync(recordDir)) {
      mkdirSync(recordDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${session.name}-${timestamp}.jsonl`;
    this.filePath = join(recordDir, filename);
    this.stream = createWriteStream(this.filePath, { flags: 'a' });
    this.startTime = Date.now();

    // Write header
    this.writeLine({
      _type: 'recording:header',
      version: 1,
      sessionId: session.id,
      sessionName: session.name,
      tool: session.info.tool,
      startTime: this.startTime,
      cwd: session.info.cwd,
    });

    // Subscribe to session events
    session.on('event', (event: NormalizedEvent) => {
      this.recordEvent(event);
    });
  }

  private recordEvent(event: NormalizedEvent): void {
    this.writeLine({
      _type: 'event',
      offset: event.timestamp - this.startTime,
      event,
    });
  }

  private writeLine(data: unknown): void {
    this.stream.write(JSON.stringify(data) + '\n');
  }

  close(): void {
    this.writeLine({
      _type: 'recording:footer',
      endTime: Date.now(),
      durationMs: Date.now() - this.startTime,
    });
    this.stream.end();
  }
}
