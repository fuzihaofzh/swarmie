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
});
