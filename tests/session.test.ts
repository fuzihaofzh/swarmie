import { describe, it, expect, vi } from 'vitest';
import { networkInterfaces } from 'node:os';
import { Session } from '../src/session/session.js';
import { SessionManager } from '../src/session/manager.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import type { NormalizedEvent } from '../src/adapters/types.js';
import {
  getSystemDisplayHostname,
  isAddressLikeHostname,
  isLocalHostname,
  normalizeHostnameIdentity,
} from '../src/session/host.js';

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

  it('normalizes harmless local hostname spelling variants', () => {
    expect(normalizeHostnameIdentity('MacBook-M4-Pro.local')).toBe('macbook-m4-pro');
    expect(normalizeHostnameIdentity('MACBOOK-M4-PRO.')).toBe('macbook-m4-pro');
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname(`${getSystemDisplayHostname()}.local`)).toBe(true);
    const interfaceAddress = Object.values(networkInterfaces()).flat().find((entry) => entry?.address)?.address;
    expect(interfaceAddress && isLocalHostname(interfaceAddress)).toBe(true);
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

  it('publishes an unread done state after a real work cycle until it is seen', () => {
    const adapter = createMockAdapter('sess-done');
    const session = new Session('sess-done', 'test', adapter);
    session.start();

    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now(),
      data: { from: 'running', to: 'idle' },
    });
    expect(session.summary).toMatchObject({ status: 'idle', seen: true });
    const readySeq = session.stateChangeSeq;

    adapter.pushEvent({
      type: 'user:input',
      sessionId: session.id,
      timestamp: Date.now(),
      data: { text: '' },
    });
    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now() + 1,
      data: { from: 'idle', to: 'running' },
    });
    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now() + 2,
      data: { from: 'running', to: 'idle' },
    });

    expect(session.summary).toMatchObject({ status: 'done', seen: false });
    expect(session.stateChangeSeq).toBeGreaterThan(readySeq);

    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now() + 3,
      data: { from: 'idle', to: 'idle' },
    });
    expect(session.summary).toMatchObject({ status: 'done', seen: false });

    session.markSeen();
    expect(session.summary).toMatchObject({ status: 'idle', seen: true });
  });

  it('does not report background startup work as a completed user task', () => {
    const adapter = createMockAdapter('sess-background-startup');
    const session = new Session('sess-background-startup', 'test', adapter);
    session.start();
    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now(),
      data: { from: 'running', to: 'idle' },
    });
    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now() + 1,
      data: { from: 'idle', to: 'running' },
    });
    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now() + 2,
      data: { from: 'running', to: 'idle' },
    });

    expect(session.summary).toMatchObject({ status: 'idle', seen: true });
  });

  it('tracks seen state for a blocker without changing its lifecycle state', () => {
    const adapter = createMockAdapter('sess-seen-blocker');
    const session = new Session('sess-seen-blocker', 'test', adapter);
    session.start();

    adapter.pushEvent({
      type: 'status:change',
      sessionId: session.id,
      timestamp: Date.now(),
      data: { from: 'running', to: 'waiting_input' },
    });
    expect(session.summary).toMatchObject({ status: 'waiting_input', seen: false });
    const blockedSeq = session.stateChangeSeq;

    session.markSeen();
    expect(session.summary).toMatchObject({ status: 'waiting_input', seen: true });
    expect(session.stateChangeSeq).toBe(blockedSeq);
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

  it('keeps raw offsets equal to true byte counts regardless of base64 padding', () => {
    const adapter = createMockAdapter('sess-offsets');
    const session = new Session('sess-offsets', 'test', adapter);

    // Lengths 1..3 mod 3 produce base64 with 2, 1 and 0 padding chars. Offsets
    // must track real bytes for all of them — a per-event over-count is what
    // made offsets drift ~36KB across a full ring and broke byte arithmetic.
    let expectedBytes = 0;
    for (let len = 1; len <= 60; len++) {
      const payload = Buffer.alloc(len, 65);
      expectedBytes += len;
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-offsets',
        timestamp: Date.now() + len,
        data: { data: payload.toString('base64') },
      });
    }

    const snapshot = session.getRawHistorySnapshot(0);
    const decodedBytes = snapshot.chunks
      .reduce((sum, c) => sum + Buffer.from(c, 'base64').length, 0);

    expect(decodedBytes).toBe(expectedBytes);
    // The offset span must equal the bytes actually returned — not one byte more.
    expect(snapshot.endOffset - snapshot.startOffset).toBe(expectedBytes);
    expect(snapshot.startOffset).toBe(0);
  });

  it('returns only the requested range when toOffset is given', () => {
    const adapter = createMockAdapter('sess-range');
    const session = new Session('sess-range', 'test', adapter);

    // Offsets are derived from base64 length (Math.ceil(len * 3 / 4)), which is
    // only exact when the payload is a multiple of 3 bytes — otherwise padding
    // makes the ring over-count. Keep every chunk at 12 bytes so the offsets in
    // this test are true byte counts.
    const texts: string[] = [];
    for (let i = 0; i < 500; i++) {
      const text = `chunk-${String(i).padStart(5, '0')};`;
      expect(text.length).toBe(12);
      texts.push(text);
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-range',
        timestamp: Date.now() + i,
        data: { data: Buffer.from(text).toString('base64') },
      });
    }
    const all = texts.join('');
    const decode = (s: { chunks: string[] }) =>
      s.chunks.map((c) => Buffer.from(c, 'base64').toString('utf-8')).join('');

    const full = session.getRawHistorySnapshot(0);
    expect(full.endOffset).toBe(all.length);

    // Ask only for the older half — the newer half must NOT be sent. This is
    // what lets a client that already holds the tail page back in bounded
    // chunks instead of re-fetching everything up to the live end.
    const mid = texts.slice(0, 250).join('').length;
    const older = session.getRawHistorySnapshot(0, mid);
    expect(older.startOffset).toBe(0);
    expect(older.endOffset).toBe(mid);
    expect(decode(older)).toBe(all.slice(0, mid));
    expect(older.reachedEarliest).toBe(true);

    // The two halves must stitch back into the whole with no gap or overlap.
    const newer = session.getRawHistorySnapshot(mid);
    expect(newer.startOffset).toBe(mid);
    expect(newer.endOffset).toBe(all.length);
    expect(decode(older) + decode(newer)).toBe(all);

    // A window in the middle.
    const loOff = texts.slice(0, 100).join('').length;
    const hiOff = texts.slice(0, 300).join('').length;
    const window = session.getRawHistorySnapshot(loOff, hiOff);
    expect(window.startOffset).toBe(loOff);
    expect(window.endOffset).toBe(hiOff);
    expect(decode(window)).toBe(all.slice(loOff, hiOff));
    expect(window.reachedEarliest).toBe(false);

    // The single invariant every caller relies on: the bytes returned are
    // exactly [startOffset, endOffset). Chunks come back whole at both ends, so
    // the reported bounds must describe what was actually sent — never less.
    for (const [f, t] of [[0, mid], [loOff, hiOff], [loOff + 3, hiOff - 5], [7, 9], [0, undefined]] as const) {
      const s = session.getRawHistorySnapshot(f, t);
      expect(decode(s).length).toBe(s.endOffset - s.startOffset);
      expect(decode(s)).toBe(all.slice(s.startOffset, s.endOffset));
    }

    // A toOffset that falls INSIDE a chunk must not silently drop it — that
    // would leave a hole between this page and what the caller already holds.
    // The straddler comes back whole and endOffset reports the overshoot, so
    // the caller can trim by byte count.
    const straddle = hiOff - 5; // mid-chunk
    const s = session.getRawHistorySnapshot(loOff, straddle);
    expect(s.endOffset).toBeGreaterThanOrEqual(straddle);
    expect(s.startOffset).toBe(loOff);
    // No hole: what came back covers [loOff, endOffset) exactly.
    expect(decode(s)).toBe(all.slice(loOff, s.endOffset));
    // And trimming the overshoot reproduces the requested window exactly.
    const overshoot = s.endOffset - straddle;
    expect(decode(s).slice(0, decode(s).length - overshoot)).toBe(all.slice(loOff, straddle));

    // Degenerate bounds must not throw or over-return.
    expect(decode(session.getRawHistorySnapshot(0, 0))).toBe('');
    expect(session.getRawHistorySnapshot(0, 0).endOffset).toBe(0);
    expect(decode(session.getRawHistorySnapshot(mid, mid))).toBe('');
    // toOffset below fromOffset is clamped up to fromOffset (empty), not inverted.
    expect(decode(session.getRawHistorySnapshot(hiOff, loOff))).toBe('');
    // toOffset past the end behaves like no bound at all.
    expect(decode(session.getRawHistorySnapshot(0, all.length + 9999))).toBe(all);
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

  it('does not trust waiting_input without a visible verified prompt', async () => {
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

      expect(onWrite).not.toHaveBeenCalled();
      expect(session.getAutoApproveDebug().eligibility).toBe('unverified_prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-approves a tall card whose remember-choice command wraps over many rows', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-tall-approval');
      const session = new Session('sess-tall-approval', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;
      const card = [
        '\x1b[2J\x1b[H',
        'This command requires approval\r\n',
        'Do you want to proceed?\r\n',
        '❯ 1. Yes\r\n',
        '  2. Yes, and don’t ask again for: timeout 90 ssh host\r\n',
        // Taller than viewport + the normal 20-row detection lookback. The
        // approval footer should trigger the bounded deep-card fallback.
        ...Array.from({ length: 80 }, (_, i) => `     command continuation ${i}\r\n`),
        '  3. No\r\n',
        'Esc to cancel · Tab to amend · ctrl+e to explain\r\n',
      ].join('');
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-tall-approval',
        timestamp: Date.now(),
        data: { data: Buffer.from(card).toString('base64') },
      });

      session.setSettings({ autoApprove: true });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onWrite).toHaveBeenCalledWith('\r');
      expect(session.getAutoApproveDebug()).toMatchObject({
        eligibility: 'eligible',
        ruleId: 'selected-approval',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-approves a Claude card inside a bannerless zsh/tmux session', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-tmux-approval', '/bin/zsh');
      const session = new Session('sess-tmux-approval', 'tmux', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;
      session.start();
      session.setSettings({ autoApprove: true });

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: session.id,
        timestamp: Date.now(),
        data: {
          data: Buffer.from([
            'This command requires approval',
            'Do you want to proceed?',
            '❯ 1. Yes',
            '  2. Yes, and don’t ask again for: timeout 60 ssh host',
            '  3. No',
            'Esc to cancel · Tab to amend · ctrl+e to explain',
            'server  1:zsh 8:claude',
          ].join('\r\n')).toString('base64'),
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(onWrite).toHaveBeenCalledWith('\r');
      expect(session.getAutoApproveDebug()).toMatchObject({
        eligibility: 'eligible',
        ruleId: 'selected-approval',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-approves a Claude edit card inside a bannerless zsh/tmux session', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-tmux-edit-approval', '/bin/zsh');
      const session = new Session('sess-tmux-edit-approval', 'tmux', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;
      session.start();
      session.setSettings({ autoApprove: true });

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: session.id,
        timestamp: Date.now(),
        data: {
          data: Buffer.from([
            'Do you want to make this edit to slurm-vllm-model?',
            '› 1. Yes',
            '  2. Yes, allow all edits during this session (shift+tab)',
            '  3. No',
            'Esc to cancel · Tab to amend',
            'server  1:zsh 8:claude',
          ].join('\r\n')).toString('base64'),
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(onWrite).toHaveBeenCalledWith('\r');
      expect(session.getAutoApproveDebug()).toMatchObject({
        eligibility: 'eligible',
        ruleId: 'selected-approval',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not publish a bell for a verified prompt handled during the auto-approve grace period', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-quiet-auto-approve');
      const session = new Session('sess-quiet-auto-approve', 'test', adapter);
      const events: NormalizedEvent[] = [];
      adapter.onWrite = vi.fn();
      session.on('event', (event: NormalizedEvent) => events.push(event));
      session.start();
      session.setSettings({ autoApprove: true });

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: session.id,
        timestamp: Date.now(),
        data: {
          data: Buffer.from([
            'Do you want to proceed?',
            '❯ 1. Yes',
            '  2. No',
            'Esc to cancel · Tab to amend',
          ].join('\r\n')).toString('base64'),
        },
      });

      expect(adapter.status).toBe('waiting_input');
      expect(session.status).toBe('running');
      expect(events.some((event) => event.type === 'status:change'
        && (event.data as { to?: string }).to === 'waiting_input')).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: session.id,
        timestamp: Date.now(),
        data: {
          data: Buffer.from('\x1b[2J\x1b[H• Working (1s · esc to interrupt)').toString('base64'),
        },
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(session.status).toBe('running');
      expect(events.some((event) => event.type === 'status:change'
        && (event.data as { to?: string }).to === 'waiting_input')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes a verified auto-approve prompt when it remains stuck past the grace period', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-stuck-auto-approve');
      const session = new Session('sess-stuck-auto-approve', 'test', adapter);
      adapter.onWrite = vi.fn();
      session.start();
      session.setSettings({ autoApprove: true });
      adapter.pushEvent({
        type: 'raw:output',
        sessionId: session.id,
        timestamp: Date.now(),
        data: {
          data: Buffer.from('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend').toString('base64'),
        },
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(session.status).toBe('running');
      await vi.advanceTimersByTimeAsync(1);
      expect(session.summary).toMatchObject({ status: 'waiting_input', seen: false });
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
        data: { data: Buffer.from('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend\r\n').toString('base64') },
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
        data: { data: Buffer.from('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend\r\n').toString('base64') },
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

  it('alternates CR and LF when a remote approval prompt does not clear', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-enter-encoding');
      const session = new Session('sess-enter-encoding', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-enter-encoding',
        timestamp: Date.now(),
        data: { data: Buffer.from('Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend\r\n').toString('base64') },
      });
      session.setSettings({ autoApprove: true });

      await vi.advanceTimersByTimeAsync(35_000);

      expect(onWrite.mock.calls.filter(c => c[0] === '\r' || c[0] === '\n').map(c => c[0]))
        .toEqual(['\r', '\r', '\n']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives back-to-back sub-agent approval cards a fresh fast-press budget', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-approval-queue');
      const session = new Session('sess-approval-queue', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;

      const approval = (command: string) => [
        '\x1b[2J\x1b[H',
        'Bash command · from the general-purpose agent\r\n',
        `  ${command}\r\n`,
        '  Run the requested check\r\n\r\n',
        'Contains shell syntax that cannot be statically analyzed\r\n\r\n',
        'Do you want to proceed?\r\n',
        '❯ 1. Yes\r\n',
        '  2. No\r\n',
        'Esc to cancel · Tab to amend\r\n',
      ].join('');
      const pushApproval = (command: string) => adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-approval-queue',
        timestamp: Date.now(),
        data: { data: Buffer.from(approval(command)).toString('base64') },
      });

      pushApproval('pdflatex paper.tex');
      session.setSettings({ autoApprove: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onWrite.mock.calls.filter(c => c[0] === '\r')).toHaveLength(1);

      // The next agent's card replaces the first without an intervening blank
      // frame. It should be approved after the normal dwell, not the 30s
      // recovery cooldown assigned to repeated presses on one stuck card.
      pushApproval('grep -n error paper.log');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onWrite.mock.calls.filter(c => c[0] === '\r')).toHaveLength(2);

      pushApproval('pdftotext paper.pdf -');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onWrite.mock.calls.filter(c => c[0] === '\r')).toHaveLength(3);
      const actions = session.getRecentEvents().filter((event) => event.type === 'automation:action');
      expect(actions).toHaveLength(3);
      expect(actions[0].data).toMatchObject({
        policy: 'verified_prompt',
        ruleId: 'selected-approval',
        key: 'cr',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset auto-approve backoff for a redraw of the same card', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-approval-redraw');
      const session = new Session('sess-approval-redraw', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;
      const card = [
        '\x1b[2J\x1b[H',
        'Bash command\r\n',
        '  npm test\r\n\r\n',
        'Do you want to proceed?\r\n',
        '❯ 1. Yes\r\n',
        '  2. No\r\n',
        'Esc to cancel · Tab to amend\r\n',
      ].join('');
      const redraw = () => adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-approval-redraw',
        timestamp: Date.now(),
        data: { data: Buffer.from(card).toString('base64') },
      });

      redraw();
      session.setSettings({ autoApprove: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onWrite.mock.calls.filter(c => c[0] === '\r')).toHaveLength(2);

      redraw();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(onWrite.mock.calls.filter(c => c[0] === '\r')).toHaveLength(2);
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

  it('does not auto-approve when the current selection is No', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createMockAdapter('sess-selected-no');
      const session = new Session('sess-selected-no', 'test', adapter);
      const onWrite = vi.fn();
      adapter.onWrite = onWrite;
      session.start();
      session.setSettings({ autoApprove: true });

      adapter.pushEvent({
        type: 'raw:output',
        sessionId: 'sess-selected-no',
        timestamp: Date.now(),
        data: {
          data: Buffer.from([
            'Do you want to proceed?',
            '  1. Yes',
            '❯ 2. No',
            'Esc to cancel · Tab to amend',
          ].join('\r\n')).toString('base64'),
        },
      });
      expect(session.summary).toMatchObject({ status: 'waiting_input', seen: false });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(onWrite).not.toHaveBeenCalled();
      expect(session.getAutoApproveDebug()).toMatchObject({
        eligibility: 'unverified_prompt',
        ruleId: 'numbered-approval',
      });
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
