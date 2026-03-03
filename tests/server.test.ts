import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionManager } from '../src/session/manager.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import { createServer } from '../src/server/index.js';

let serverClose: () => Promise<void>;
let baseUrl: string;
let manager: SessionManager;

beforeAll(async () => {
  manager = new SessionManager();

  const adapter = new RemoteAdapter(
    { sessionId: 'test-sess', toolArgs: [] },
    {
      name: 'claude',
      displayName: 'Claude Code',
      icon: '\u{1F916}',
      command: 'claude',
      supportsStructured: true,
    },
  );

  const session = manager.addSession('test-sess', 'Test Session', adapter);
  session.start();

  // Push some events
  adapter.pushEvent({
    type: 'session:start',
    sessionId: 'test-sess',
    timestamp: Date.now(),
    data: { tool: 'claude', command: ['claude', '--help'], cwd: '/tmp' },
  });

  const server = await createServer(manager, { port: 0 }); // random port
  baseUrl = server.address;
  serverClose = server.close;
});

afterAll(async () => {
  await serverClose();
});

describe('REST API', () => {
  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.sessions).toBe(1);
  });

  it('GET /api/sessions returns session list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    const body = await res.json() as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('test-sess');
  });

  it('GET /api/sessions/:id returns session detail', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-sess`);
    const body = await res.json() as { id: string; tool: string };
    expect(body.id).toBe('test-sess');
    expect(body.tool).toBe('claude');
  });

  it('GET /api/sessions/:id returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent`);
    expect(res.status).toBe(404);
  });

  it('GET /api/sessions/:id/events returns events', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-sess/events`);
    const body = await res.json() as Array<{ type: string }>;
    expect(body.length).toBeGreaterThan(0);
    // First event is status:change (from start()) followed by session:start
    const types = body.map((e) => e.type);
    expect(types).toContain('session:start');
  });
});
