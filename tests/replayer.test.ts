import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRecording, replayRecording } from '../src/session/replayer.js';
import type { NormalizedEvent } from '../src/adapters/types.js';

const testDir = join(tmpdir(), 'swarmie-test-replay');
const testFile = join(testDir, 'test.jsonl');

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });

  const lines = [
    JSON.stringify({
      _type: 'recording:header',
      version: 1,
      sessionId: 'sess-1',
      sessionName: 'test-session',
      tool: 'claude',
      startTime: 1000,
      cwd: '/tmp',
    }),
    JSON.stringify({
      _type: 'event',
      offset: 0,
      event: {
        type: 'session:start',
        sessionId: 'sess-1',
        timestamp: 1000,
        data: { tool: 'claude', command: ['claude', '--help'], cwd: '/tmp' },
      },
    }),
    JSON.stringify({
      _type: 'event',
      offset: 100,
      event: {
        type: 'raw:output',
        sessionId: 'sess-1',
        timestamp: 1100,
        data: { data: 'aGVsbG8=' },
      },
    }),
    JSON.stringify({
      _type: 'event',
      offset: 200,
      event: {
        type: 'session:end',
        sessionId: 'sess-1',
        timestamp: 1200,
        data: { exitCode: 0, signal: null },
      },
    }),
    JSON.stringify({
      _type: 'recording:footer',
      endTime: 1200,
      durationMs: 200,
    }),
  ];

  writeFileSync(testFile, lines.join('\n') + '\n');
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('loadRecording', () => {
  it('loads a JSONL recording file', () => {
    const recording = loadRecording(testFile);
    expect(recording.header.sessionId).toBe('sess-1');
    expect(recording.header.tool).toBe('claude');
    expect(recording.events).toHaveLength(3);
    expect(recording.footer?.durationMs).toBe(200);
  });

  it('has correct event order', () => {
    const recording = loadRecording(testFile);
    expect(recording.events[0].event.type).toBe('session:start');
    expect(recording.events[1].event.type).toBe('raw:output');
    expect(recording.events[2].event.type).toBe('session:end');
  });
});

describe('replayRecording', () => {
  it('replays events in order', async () => {
    const recording = loadRecording(testFile);
    const replayed: NormalizedEvent[] = [];

    await replayRecording(
      recording,
      (event) => replayed.push(event),
      { speed: 100 }, // 100x speed for fast test
    );

    expect(replayed).toHaveLength(3);
    expect(replayed[0].type).toBe('session:start');
    expect(replayed[2].type).toBe('session:end');
  });

  it('supports abort', async () => {
    const recording = loadRecording(testFile);
    const replayed: NormalizedEvent[] = [];
    const controller = new AbortController();

    // Abort after first event
    const promise = replayRecording(
      recording,
      (event) => {
        replayed.push(event);
        if (replayed.length === 1) controller.abort();
      },
      { speed: 1, signal: controller.signal },
    );

    await promise;
    // Should have stopped after 1-2 events instead of all 3
    expect(replayed.length).toBeLessThanOrEqual(2);
  });
});
