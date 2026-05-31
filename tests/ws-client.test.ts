import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { parseServerAddress } from '../src/ipc/ws-client.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import { SessionManager } from '../src/session/manager.js';
import { createServer } from '../src/server/index.js';

const TEST_PASSWORD = 'ws-test-secret';
const WS_TOKEN = createHash('sha256').update(TEST_PASSWORD).digest('hex');
const WS_PROTOCOL = `swarmie-token.${WS_TOKEN}`;

function parseObservabilityLogs(calls: unknown[][]): Array<Record<string, unknown>> {
  const parsed: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    const line = call
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      const payload = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
      if ('event' in payload && 'request_id' in payload && 'session_id' in payload && 'error_code' in payload) {
        parsed.push(payload);
      }
    } catch {
      // Ignore non-JSON logs
    }
  }
  return parsed;
}

async function waitForSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 3000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('parseServerAddress', () => {
  it('parses host:port', () => {
    expect(parseServerAddress('192.168.1.10:3200')).toBe('ws://192.168.1.10:3200/ws');
  });

  it('parses localhost:port', () => {
    expect(parseServerAddress('localhost:3200')).toBe('ws://localhost:3200/ws');
  });

  it('parses ws:// URL', () => {
    expect(parseServerAddress('ws://example.com:3200')).toBe('ws://example.com:3200/ws');
  });

  it('parses ws:// URL with existing path', () => {
    expect(parseServerAddress('ws://example.com:3200/custom')).toBe('ws://example.com:3200/custom');
  });

  it('parses http:// URL and converts to ws://', () => {
    expect(parseServerAddress('http://example.com:3200')).toBe('ws://example.com:3200/ws');
  });

  it('parses https:// URL and converts to wss://', () => {
    expect(parseServerAddress('https://example.com:3200')).toBe('wss://example.com:3200/ws');
  });

  it('parses wss:// URL', () => {
    // Port 443 is the default for wss, so URL normalizes it away
    expect(parseServerAddress('wss://example.com:443')).toBe('wss://example.com/ws');
    expect(parseServerAddress('wss://example.com:4443')).toBe('wss://example.com:4443/ws');
  });
});

describe('WebSocket observability', () => {
  let serverClose: () => Promise<void>;
  let wsUrl: string;
  let manager: SessionManager;
  const sockets = new Set<WebSocket>();

  const trackSocket = (ws: WebSocket): WebSocket => {
    sockets.add(ws);
    ws.once('close', () => {
      sockets.delete(ws);
    });
    return ws;
  };

  beforeAll(async () => {
    manager = new SessionManager();
    const server = await createServer(manager, { port: 0, password: TEST_PASSWORD });
    wsUrl = `${server.address.replace(/^http/, 'ws')}/ws`;
    serverClose = server.close;
  });

  afterAll(async () => {
    const remaining = [...sockets];
    for (const ws of remaining) {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
    }
    await Promise.all(
      remaining.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            ws.once('close', () => resolve());
          }),
      ),
    );
    await serverClose();
  });

  it('logs ws connect/disconnect with required fields', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ws = trackSocket(new WebSocket(wsUrl, [WS_PROTOCOL]));
      await waitForSocketOpen(ws);

      ws.close();
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const connectLog = logs.find((log) => log.event === 'ws.connect');
      const disconnectLog = logs.find((log) => log.event === 'ws.disconnect');

      expect(connectLog).toBeDefined();
      expect(disconnectLog).toBeDefined();
      expect(typeof connectLog?.request_id).toBe('string');
      expect(typeof disconnectLog?.request_id).toBe('string');
      expect(connectLog?.error_code).toBeNull();
      expect(disconnectLog?.error_code).toBeNull();
      expect(connectLog?.session_id).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs WS_CLIENT_DISCONNECTED on remote CLI abnormal disconnect', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sessionId = `remote-${Date.now()}`;
    try {
      const ws = trackSocket(new WebSocket(wsUrl, [WS_PROTOCOL]));
      await waitForSocketOpen(ws);

      ws.send(JSON.stringify({
        type: 'register',
        sessionId,
        name: 'Remote Test Session',
        tool: 'codex',
        adapterInfo: {
          name: 'codex',
          displayName: 'Codex',
          icon: 'C',
          command: 'codex',
          supportsStructured: true,
        },
        cwd: '/tmp',
        hostname: 'test-host',
      }));

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Remote register timeout')), 3000);
        const onMessage = (raw: WebSocket.RawData) => {
          try {
            const payload = JSON.parse(raw.toString()) as { type?: string; sessionId?: string };
            if (payload.type === 'registered' && payload.sessionId === sessionId) {
              clearTimeout(timer);
              ws.off('message', onMessage);
              resolve();
            }
          } catch {
            // Ignore non-JSON payloads
          }
        };
        ws.on('message', onMessage);
        ws.once('error', (err) => {
          clearTimeout(timer);
          ws.off('message', onMessage);
          reject(err);
        });
      });

      ws.terminate();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const disconnectLog = [...logs]
        .reverse()
        .find((log) => log.event === 'ws.disconnect' && log.session_id === sessionId);
      expect(disconnectLog).toBeDefined();
      expect(disconnectLog?.error_code).toBe('WS_CLIENT_DISCONNECTED');
      expect(disconnectLog?.session_id).toBe(sessionId);
      expect(typeof disconnectLog?.request_id).toBe('string');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs WS_INVALID_MESSAGE for malformed and unsupported websocket messages', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ws = trackSocket(new WebSocket(wsUrl, [WS_PROTOCOL]));
      await waitForSocketOpen(ws);

      ws.send('{invalid-json');
      ws.send(JSON.stringify({ type: 'unsupported:message:type' }));
      await new Promise((resolve) => setTimeout(resolve, 30));

      ws.close();
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const invalidLogs = logs.filter((log) => log.event === 'ws.invalid_message');
      expect(invalidLogs.length).toBeGreaterThanOrEqual(2);
      for (const invalidLog of invalidLogs) {
        expect(invalidLog.error_code).toBe('WS_INVALID_MESSAGE');
        expect(invalidLog.session_id).toBeNull();
        expect(typeof invalidLog.request_id).toBe('string');
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not send raw terminal output to subscribe:all clients', async () => {
    const sessionId = `raw-filter-${Date.now()}`;
    const adapter = new RemoteAdapter(
      { sessionId, toolArgs: [], cwd: '/tmp' },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: 'C',
        command: 'codex',
        supportsStructured: true,
      },
    );
    manager.addSession(sessionId, 'Raw Filter Session', adapter, { cwd: '/tmp', hostname: 'test-host' });

    const ws = trackSocket(new WebSocket(wsUrl, [WS_PROTOCOL]));
    const rawMessages: unknown[] = [];
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString()) as { type?: string; event?: { type?: string; sessionId?: string } };
        if (payload.type === 'event' && payload.event?.type === 'raw:output' && payload.event.sessionId === sessionId) {
          rawMessages.push(payload);
        }
      } catch {
        // Ignore non-JSON payloads
      }
    });

    await waitForSocketOpen(ws);
    ws.send(JSON.stringify({ type: 'subscribe:all' }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    adapter.pushEvent({
      type: 'raw:output',
      sessionId,
      timestamp: Date.now(),
      data: { data: Buffer.from('background output\n').toString('base64') },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rawMessages).toHaveLength(0);

    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    adapter.pushEvent({
      type: 'raw:output',
      sessionId,
      timestamp: Date.now(),
      data: { data: Buffer.from('visible output\n').toString('base64') },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rawMessages.length).toBeGreaterThan(0);
    const receivedAfterSubscribe = rawMessages.length;

    ws.send(JSON.stringify({ type: 'unsubscribe', sessionId }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    adapter.pushEvent({
      type: 'raw:output',
      sessionId,
      timestamp: Date.now(),
      data: { data: Buffer.from('unsubscribed output\n').toString('base64') },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rawMessages).toHaveLength(receivedAfterSubscribe);
    ws.close();
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });
  });

  it('filters subscribe replay by raw output offset', async () => {
    const sessionId = `raw-offset-${Date.now()}`;
    const adapter = new RemoteAdapter(
      { sessionId, toolArgs: [], cwd: '/tmp' },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: 'C',
        command: 'codex',
        supportsStructured: true,
      },
    );
    manager.addSession(sessionId, 'Raw Offset Session', adapter, { cwd: '/tmp', hostname: 'test-host' });

    adapter.pushEvent({
      type: 'raw:output',
      sessionId,
      timestamp: Date.now(),
      data: { data: Buffer.from('already rendered\n').toString('base64') },
    });
    adapter.pushEvent({
      type: 'raw:output',
      sessionId,
      timestamp: Date.now() + 1,
      data: { data: Buffer.from('catch up only\n').toString('base64') },
    });

    const session = manager.getSession(sessionId);
    const rawEvents = session?.getRecentEvents().filter((event) => event.type === 'raw:output') ?? [];
    const firstOffset = (rawEvents[0]?.data as { offsetEnd?: number } | undefined)?.offsetEnd;
    expect(typeof firstOffset).toBe('number');

    const ws = trackSocket(new WebSocket(wsUrl, [WS_PROTOCOL]));
    const batchPromise = new Promise<{ events: Array<{ type: string; data: { data: string } }> }>((resolve) => {
      ws.on('message', (raw: WebSocket.RawData) => {
        const payload = JSON.parse(raw.toString()) as {
          type?: string;
          sessionId?: string;
          events?: Array<{ type: string; data: { data: string } }>;
        };
        if (payload.type === 'event:batch' && payload.sessionId === sessionId) {
          resolve({ events: payload.events ?? [] });
        }
      });
    });

    await waitForSocketOpen(ws);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId, fromOffset: firstOffset }));
    const batch = await batchPromise;
    const replayText = batch.events
      .filter((event) => event.type === 'raw:output')
      .map((event) => Buffer.from(event.data.data, 'base64').toString('utf-8'))
      .join('');

    expect(replayText).not.toContain('already rendered');
    expect(replayText).toContain('catch up only');
    ws.close();
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });
  });

  it('accepts dashboard ping heartbeats without invalid-message logs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ws = trackSocket(new WebSocket(wsUrl, [WS_PROTOCOL]));
      await waitForSocketOpen(ws);

      ws.send(JSON.stringify({ type: 'subscribe:all' }));
      ws.send(JSON.stringify({ type: 'ping' }));
      await new Promise((resolve) => setTimeout(resolve, 30));

      ws.close();
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const invalidLogs = logs.filter((log) => log.event === 'ws.invalid_message');
      expect(invalidLogs).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
