import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeLocalStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
    clear: () => items.clear(),
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

describe('ServerConnection session settings sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeWebSocket.instances = [];
    vi.stubGlobal('localStorage', makeLocalStorage());
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:3200' },
      close: vi.fn(),
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('flushes auto-approve toggles made while the dashboard socket is connecting', async () => {
    const { ServerConnection } = await import('../src/web/hooks/useWebSocket.js');
    const conn = new ServerConnection('');

    conn.connect();
    conn.sendAutoApprove('sess-1', true);

    const socket = FakeWebSocket.instances[0];
    expect(socket.sent).toEqual([]);

    socket.open();

    expect(socket.sent.map((msg) => JSON.parse(msg))).toEqual([
      { type: 'subscribe:all' },
      { type: 'set:autoApprove', sessionId: 'sess-1', value: true },
    ]);

    conn.disconnect();
  });

  it('hydrates legacy idle timestamps once across REST and WS lists, preserving unread Done', async () => {
    const { ServerConnection } = await import('../src/web/hooks/useWebSocket.js');
    const { useSessionStore } = await import('../src/web/hooks/useSessions.js');
    const idle = { id: 'legacy', status: 'idle', stateChangeSeq: 3 };
    const sessions = [idle, { id: 'unread', status: 'done', stateChangeSeq: 4 }];
    const since = Date.now() - 7200000;
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () =>
      url.endsWith('/legacy') ? { ...idle, recentEvents: [
        { type: 'status:change', timestamp: since, data: { from: 'done', to: 'idle' } },
      ] } : sessions,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const conn = new ServerConnection('');
    conn.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.onmessage?.({ data: JSON.stringify({ type: 'session:list', sessions }) });
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0].statusChangedAt).toBe(since));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/legacy'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/unread'))).toBe(false);
    expect(useSessionStore.getState().sessions[1].status).toBe('done');
    socket.onmessage?.({ data: JSON.stringify({ type: 'session:list', sessions }) });
    expect(useSessionStore.getState().sessions[0].statusChangedAt).toBe(since);
    conn.disconnect();
  });

  it('does not apply a late legacy history response after the agent resumes work', async () => {
    const { ServerConnection } = await import('../src/web/hooks/useWebSocket.js');
    const { useSessionStore } = await import('../src/web/hooks/useSessions.js');
    const idle = { id: 'legacy', status: 'idle', stateChangeSeq: 3 };
    let resolveHistory!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise((resolve) => { resolveHistory = resolve; }) })));
    const conn = new ServerConnection('');
    conn.connect();
    const socket = FakeWebSocket.instances[0];
    socket.onmessage?.({ data: JSON.stringify({ type: 'session:list', sessions: [idle] }) });
    await vi.waitFor(() => expect(resolveHistory).toBeTypeOf('function'));
    useSessionStore.getState().updateSessionStatus('legacy', 'running');
    useSessionStore.getState().updateSessionStatus('legacy', 'idle');
    const current = useSessionStore.getState().sessions[0].statusChangedAt;
    resolveHistory({ ...idle, recentEvents: [
      { type: 'status:change', timestamp: 1, data: { from: 'done', to: 'idle' } },
    ] });
    await vi.advanceTimersByTimeAsync(1);
    expect(useSessionStore.getState().sessions[0].statusChangedAt).toBe(current);
    conn.disconnect();
  });
});
