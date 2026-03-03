import { readFileSync } from 'node:fs';
import type { NormalizedEvent } from '../adapters/types.js';

export interface RecordingHeader {
  _type: 'recording:header';
  version: number;
  sessionId: string;
  sessionName: string;
  tool: string;
  startTime: number;
  cwd: string;
}

export interface RecordingEntry {
  _type: 'event';
  offset: number;
  event: NormalizedEvent;
}

export interface RecordingFooter {
  _type: 'recording:footer';
  endTime: number;
  durationMs: number;
}

export type RecordingLine = RecordingHeader | RecordingEntry | RecordingFooter;

export interface Recording {
  header: RecordingHeader;
  events: RecordingEntry[];
  footer?: RecordingFooter;
}

/** Load a recording from a JSONL file */
export function loadRecording(filePath: string): Recording {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  let header: RecordingHeader | null = null;
  const events: RecordingEntry[] = [];
  let footer: RecordingFooter | undefined;

  for (const line of lines) {
    const parsed = JSON.parse(line) as RecordingLine;
    switch (parsed._type) {
      case 'recording:header':
        header = parsed;
        break;
      case 'event':
        events.push(parsed);
        break;
      case 'recording:footer':
        footer = parsed;
        break;
    }
  }

  if (!header) {
    throw new Error('Invalid recording file: missing header');
  }

  return { header, events, footer };
}

/**
 * Replay a recording with timing.
 * Calls `onEvent` for each event, respecting relative timing.
 * Set `speed` > 1 for faster replay.
 */
export async function replayRecording(
  recording: Recording,
  onEvent: (event: NormalizedEvent) => void,
  options?: { speed?: number; signal?: AbortSignal },
): Promise<void> {
  const speed = options?.speed ?? 1;

  for (let i = 0; i < recording.events.length; i++) {
    if (options?.signal?.aborted) break;

    const entry = recording.events[i];
    const nextEntry = recording.events[i + 1];

    onEvent(entry.event);

    if (options?.signal?.aborted) break;

    if (nextEntry) {
      const delay = (nextEntry.offset - entry.offset) / speed;
      if (delay > 0) {
        const aborted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), delay);
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(true);
          }, { once: true });
        });
        if (aborted) break;
      }
    }
  }
}
