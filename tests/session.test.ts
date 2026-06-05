import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session/session.js';
import { SessionManager } from '../src/session/manager.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import type { NormalizedEvent } from '../src/adapters/types.js';
import { isAddressLikeHostname } from '../src/session/host.js';

function createMockAdapter(sessionId: string, tool = 'claude') {
  return new RemoteAdapter(
    { sessionId, toolArgs: [] },
    {
      name: tool,
      displayName: tool === 'codex' ? 'Codex' : 'Claude Code',
      icon: '\u{1F916}',
      command: tool,
      supportsStructured: true,
    },
  );
}

describe('Session', () => {
  it('detects IP-like hostnames for default tag fallback', () => {
    expect(isAddressLikeHostname('192.168.124.20')).toBe(true);
    expect(isAddressLikeHostname('192')).toBe(true);
    expect(isAddressLikeHostname('MacBook-M4-Pro')).toBe(false);
  });

  it('wraps an adapter and exposes info', () => {
    const adapter = createMockAdapter('sess-1');
    const session = new Session('sess-1', 'test-session', adapter);
    expect(session.id).toBe('sess-1');
    expect(session.name).toBe('test-session');
    expect(session.info.tool).toBe('claude');
  });

  it('defaults tags to the session hostname', () => {
    const adapter = createMockAdapter('sess-host');
    const session = new Session('sess-host', 'test-session', adapter, {
      hostname: 'worker-1',
    });

    expect(session.summary.tags).toEqual(['worker-1']);
  });

  it('tracks events pushed to the adapter', () => {
    const adapter = createMockAdapter('sess-2');
    const session = new Session('sess-2', 'test', adapter);
    const events: NormalizedEvent[] = [];
    session.on('event', (e: NormalizedEvent) => events.push(e));

    adapter.pushEvent({
      type: 'raw:output',
      sessionId: 'sess-2',
      timestamp: Date.now(),
      data: { data: Buffer.from('hello').toString('base64') },
    });

    expect(events.map((event) => event.type)).toEqual(['status:change', 'raw:output']);
    expect(session.getRecentEvents()).toHaveLength(2);
  });

  it('returns all retained raw events after an offset', () => {
    const adapter = createMockAdapter('sess-raw-since');
    const session = new Session('sess-raw-since', 'test', adapter);
    const chunks = ['one', 'two', 'three'];

    chunks.forEach((chunk, index) => {
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-raw-since',
        timestamp: Date.now() + index,
        data: { data: Buffer.from(chunk).toString('base64') },
      });
    });

    const allRaw = session.getRawEventsSince(0);
    const firstOffset = (allRaw[0].data as { offsetEnd?: number }).offsetEnd;
    expect(typeof firstOffset).toBe('number');

    const replayText = session.getRawEventsSince(firstOffset!)
      .map((event) => Buffer.from((event.data as { data: string }).data, 'base64').toString('utf-8'))
      .join('');

    expect(replayText).toBe('twothree');
  });

  it('coalesces a fragmented raw history snapshot into fewer chunks without losing bytes', () => {
    const adapter = createMockAdapter('sess-snapshot');
    const session = new Session('sess-snapshot', 'test', adapter);

    // Simulate a busy session: many tiny raw events (a redrawing statusline).
    const total = 5000;
    let expected = '';
    for (let i = 0; i < total; i++) {
      const text = `chunk-${i};`;
      expected += text;
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-snapshot',
        timestamp: Date.now() + i,
        data: { data: Buffer.from(text).toString('base64') },
      });
    }

    const snapshot = session.getRawHistorySnapshot(0);

    // Far fewer chunks than events — they were merged into large buckets.
    expect(snapshot.chunks.length).toBeLessThan(total);
    expect(snapshot.chunks.length).toBeGreaterThan(0);
    expect(snapshot.reachedEarliest).toBe(true);
    expect(snapshot.startOffset).toBe(0);
    expect(snapshot.endOffset).toBeGreaterThan(0);

    // The concatenation of the coalesced chunks must equal the original bytes.
    const joined = snapshot.chunks
      .map((c) => Buffer.from(c, 'base64').toString('utf-8'))
      .join('');
    expect(joined).toBe(expected);
  });

  it('tracks metadata accumulation', () => {
    const adapter = createMockAdapter('sess-3');
    const session = new Session('sess-3', 'test', adapter);

    adapter.pushEvent({
      type: 'metadata',
      sessionId: 'sess-3',
      timestamp: Date.now(),
      data: { costUsd: 0.01, durationMs: 1000 },
    });

    adapter.pushEvent({
      type: 'metadata',
      sessionId: 'sess-3',
      timestamp: Date.now(),
      data: { costUsd: 0.02, durationMs: 2000 },
    });

    expect(session.info.metadata.costUsd).toBeCloseTo(0.03);
    expect(session.info.metadata.durationMs).toBe(2000);
  });

  it('auto-approves immediately when enabled during waiting_input', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-4');
      const session = new Session('sess-4', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-4',
        timestamp: Date.now(),
        data: { from: 'running', to: 'waiting_input' },
      });

      session.setSettings({ autoApprove: true });
      // Initial dwell (750ms) + a tick to fire.
      await vi.advanceTimersByTimeAsync(1000);

      expect(onWrite).toHaveBeenCalledWith('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps auto-approve armed even when sub-agent output flicks status to running mid-prompt', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-livelock');
      const session = new Session('sess-livelock', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      // Real Claude prompt with sub-agents streaming. Push prompt text via
      // raw:output so the headless screen sees it (this is what RemoteAdapter
      // does in production).
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-livelock',
        timestamp: Date.now(),
        data: { data: Buffer.from('Do you want to proceed?\r\n  1. Yes\r\n  2. No\r\n').toString('base64') },
      });
      // Local detection should have set waiting_input from screen scan.
      expect(adapter.status).toBe('waiting_input');

      session.setSettings({ autoApprove: true });

      // While we're waiting for auto-approve to fire, a stream of sub-agent
      // output arrives. The remote forwards "running" status:change events —
      // RemoteAdapter must drop those (not just suppress the apply), so the
      // ticker still sees waiting_input + the prompt on screen.
      for (let i = 0; i < 5; i++) {
        adapter.pushEvent({
          type: 'status:change',
          sessionId: 'sess-livelock',
          timestamp: Date.now(),
          data: { from: 'waiting_input', to: 'running' },
        });
        await vi.advanceTimersByTimeAsync(100);
      }

      // After initial dwell + a tick, Enter should still be sent.
      await vi.advanceTimersByTimeAsync(1500);

      expect(onWrite).toHaveBeenCalledWith('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('presses Enter a few times fast, then backs off to a slow recovery rate', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-bound');
      const session = new Session('sess-bound', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-bound',
        timestamp: Date.now(),
        data: { data: Buffer.from('Do you want to proceed?').toString('base64') },
      });
      expect(adapter.status).toBe('waiting_input');

      session.setSettings({ autoApprove: true });

      // First 5 seconds: should see the "fast" budget burn (2 presses at
      // 1.5s cooldown), then stop.
      await vi.advanceTimersByTimeAsync(5_000);
      const fastEnters = onWrite.mock.calls.filter(c => c[0] === '\r').length;
      expect(fastEnters).toBe(2);

      // Now ride out the slow phase — 30s cooldown means at most 1 extra
      // press over the next 25s.
      await vi.advanceTimersByTimeAsync(25_000);
      const afterSlow = onWrite.mock.calls.filter(c => c[0] === '\r').length;
      expect(afterSlow).toBeGreaterThanOrEqual(2);
      expect(afterSlow).toBeLessThanOrEqual(3);

      // Continue another 35s — should add about one more press.
      await vi.advanceTimersByTimeAsync(35_000);
      const total = onWrite.mock.calls.filter(c => c[0] === '\r').length;
      expect(total).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not press Enter when auto-approve is enabled but no prompt is on screen', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-noprompt');
      const session = new Session('sess-noprompt', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-noprompt',
        timestamp: Date.now(),
        data: { data: Buffer.from('Just some streaming output, no prompt here.').toString('base64') },
      });
      session.setSettings({ autoApprove: true });
      await vi.advanceTimersByTimeAsync(5000);

      expect(onWrite.mock.calls.find(c => c[0] === '\r')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs repeat command after interval and clears first when requested', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-5');
      const session = new Session('sess-5', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setSettings({
        repeatEnabled: true,
        repeatCommand: 'date',
        repeatIntervalSeconds: 2,
        repeatClear: true,
      });
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-5',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });

      await vi.advanceTimersByTimeAsync(1999);
      expect(onWrite).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onWrite).toHaveBeenNthCalledWith(1, '/clear\n');
      expect(onWrite).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(2, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(3, '\r');

      await vi.advanceTimersByTimeAsync(500);
      expect(onWrite).toHaveBeenNthCalledWith(4, 'date\n');

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(5, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(6, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves spaces in repeat commands', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-repeat-spaces', 'codex');
      const session = new Session('sess-repeat-spaces', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setSettings({
        repeatEnabled: true,
        repeatCommand: 'run ls -la ',
        repeatIntervalSeconds: 1,
      });
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-repeat-spaces',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });

      expect(session.summary.repeatCommand).toBe('run ls -la ');
      await vi.advanceTimersByTimeAsync(1000);
      expect(onWrite).toHaveBeenNthCalledWith(1, 'run ls -la \n');

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(2, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(3, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends slash-clear before codex repeat when clear is requested', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-codex-repeat', 'codex');
      const session = new Session('sess-codex-repeat', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setSettings({
        repeatEnabled: true,
        repeatCommand: 'search Zihao',
        repeatIntervalSeconds: 1,
        repeatClear: true,
      });
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-codex-repeat',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(onWrite).toHaveBeenNthCalledWith(1, '/clear\n');

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(2, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(3, '\r');

      await vi.advanceTimersByTimeAsync(500);
      expect(onWrite).toHaveBeenNthCalledWith(4, 'search Zihao\n');

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(5, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(6, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the repeat prompt scheduled after clear-related status changes', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-repeat-clear-race', 'codex');
      const session = new Session('sess-repeat-clear-race', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setSettings({
        repeatEnabled: true,
        repeatCommand: 'search maple',
        repeatIntervalSeconds: 1,
        repeatClear: true,
      });
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-repeat-clear-race',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(onWrite).toHaveBeenNthCalledWith(1, '/clear\n');

      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-repeat-clear-race',
        timestamp: Date.now(),
        data: { from: 'idle', to: 'running' },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(onWrite).toHaveBeenNthCalledWith(4, 'search maple\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs repeat when the session is waiting for user input', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-repeat-waiting', 'codex');
      const session = new Session('sess-repeat-waiting', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setSettings({
        repeatEnabled: true,
        repeatCommand: 'run ls',
        repeatIntervalSeconds: 1,
      });
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-repeat-waiting',
        timestamp: Date.now(),
        data: { from: 'running', to: 'waiting_input' },
      });

      expect(session.summary.nextRepeatAt).toBeTypeOf('number');
      await vi.advanceTimersByTimeAsync(1000);

      expect(onWrite).toHaveBeenNthCalledWith(1, 'run ls\n');

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(2, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(3, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends slash-compact with an extra enter for slash command submission', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-auto-compact', 'claude');
      const session = new Session('sess-auto-compact', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-auto-compact',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });
      session.setAutoCompactMinutes(1);
      session.setSettings({ autoCompact: true });

      expect(session.summary.nextAutoCompactAt).toBeTypeOf('number');
      await vi.advanceTimersByTimeAsync(60 * 1000);

      expect(onWrite).toHaveBeenNthCalledWith(1, '/compact\n');

      await vi.advanceTimersByTimeAsync(200);
      expect(onWrite).toHaveBeenNthCalledWith(2, '\x0D\x0A');

      await vi.advanceTimersByTimeAsync(300);
      expect(onWrite).toHaveBeenNthCalledWith(3, '\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts auto-compact countdown only after the session becomes idle', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-auto-compact-idle', 'codex');
      const session = new Session('sess-auto-compact-idle', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setAutoCompactMinutes(1);
      session.setSettings({ autoCompact: true });

      expect(session.summary.nextAutoCompactAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onWrite).not.toHaveBeenCalled();

      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-auto-compact-idle',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });

      expect(session.summary.nextAutoCompactAt).toBeTypeOf('number');
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onWrite).toHaveBeenNthCalledWith(1, '/compact\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-compact again while the session stays idle after compacting', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-auto-compact-once', 'codex');
      const session = new Session('sess-auto-compact-once', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setAutoCompactMinutes(1);
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-auto-compact-once',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });
      session.setSettings({ autoCompact: true });

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onWrite).toHaveBeenNthCalledWith(1, '/compact\n');

      await vi.advanceTimersByTimeAsync(34 * 1000);
      expect(session.status).toBe('idle');
      expect(session.summary.nextAutoCompactAt).toBeUndefined();

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onWrite).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts auto-compact countdown after compacting only when later activity becomes busy then idle', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-auto-compact-after-busy', 'codex');
      const session = new Session('sess-auto-compact-after-busy', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      session.start();
      session.setAutoCompactMinutes(1);
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-auto-compact-after-busy',
        timestamp: Date.now(),
        data: { from: 'running', to: 'idle' },
      });
      session.setSettings({ autoCompact: true });

      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onWrite).toHaveBeenNthCalledWith(1, '/compact\n');
      await vi.advanceTimersByTimeAsync(34 * 1000);
      expect(session.summary.nextAutoCompactAt).toBeUndefined();

      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-auto-compact-after-busy',
        timestamp: Date.now(),
        data: { from: 'idle', to: 'thinking' },
      });
      adapter.pushEvent({
        type: 'status:change',
        sessionId: 'sess-auto-compact-after-busy',
        timestamp: Date.now(),
        data: { from: 'thinking', to: 'idle' },
      });

      expect(session.summary.nextAutoCompactAt).toBeTypeOf('number');
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(onWrite).toHaveBeenNthCalledWith(4, '/compact\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards resize to adapter', () => {
    const adapter = createMockAdapter('sess-resize');
    const onResize = vi.fn();
    adapter.onResize = onResize;
    const session = new Session('sess-resize', 'test', adapter);

    session.resize(120, 40);

    expect(onResize).toHaveBeenCalledWith(120, 40);
  });

  it('forwards resize even when isLocal is set (CLI is now treated as one more MIN-contributing viewer)', () => {
    const adapter = createMockAdapter('sess-resize-local');
    const onResize = vi.fn();
    adapter.onResize = onResize;
    const session = new Session('sess-resize-local', 'test', adapter);
    session.isLocal = true;

    session.resize(120, 40);

    expect(onResize).toHaveBeenCalledWith(120, 40);
  });
});

describe('SessionManager', () => {
  it('manages sessions lifecycle', () => {
    const manager = new SessionManager();
    const adapter = createMockAdapter('sess-a');
    const session = manager.addSession('sess-a', 'Session A', adapter);

    expect(manager.size).toBe(1);
    expect(manager.getSession('sess-a')).toBe(session);
    expect(manager.getSessionSummaries()).toHaveLength(1);

    manager.removeSession('sess-a');
    expect(manager.size).toBe(0);
  });

  it('emits session:added', () => {
    const manager = new SessionManager();
    const handler = vi.fn();
    manager.on('session:added', handler);

    const adapter = createMockAdapter('sess-b');
    manager.addSession('sess-b', 'Session B', adapter);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].id).toBe('sess-b');
  });

  it('forwards events from sessions', () => {
    const manager = new SessionManager();
    const adapter = createMockAdapter('sess-c');
    manager.addSession('sess-c', 'Session C', adapter);

    const events: NormalizedEvent[] = [];
    manager.on('event', (e: NormalizedEvent) => events.push(e));

    adapter.pushEvent({
      type: 'raw:output',
      sessionId: 'sess-c',
      timestamp: Date.now(),
      data: { data: 'aGVsbG8=' },
    });

    expect(events.map((event) => event.type)).toEqual(['status:change', 'raw:output']);
  });
});
