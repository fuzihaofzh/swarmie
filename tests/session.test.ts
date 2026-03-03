import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/session/session.js';
import { SessionManager } from '../src/session/manager.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import type { NormalizedEvent } from '../src/adapters/types.js';

function createMockAdapter(sessionId: string) {
  return new RemoteAdapter(
    { sessionId, toolArgs: [] },
    {
      name: 'claude',
      displayName: 'Claude Code',
      icon: '\u{1F916}',
      command: 'claude',
      supportsStructured: true,
    },
  );
}

describe('Session', () => {
  it('wraps an adapter and exposes info', () => {
    const adapter = createMockAdapter('sess-1');
    const session = new Session('sess-1', 'test-session', adapter);
    expect(session.id).toBe('sess-1');
    expect(session.name).toBe('test-session');
    expect(session.info.tool).toBe('claude');
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

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('raw:output');
    expect(session.getRecentEvents()).toHaveLength(1);
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

    expect(events).toHaveLength(1);
  });
});
