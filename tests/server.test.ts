import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getConfigDir, loadConfig } from '../src/cli/config.js';
import { SessionManager } from '../src/session/manager.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import { createServer } from '../src/server/index.js';

const TEST_PASSWORD = 'test-secret';
const AUTH_TOKEN = createHash('sha256').update(TEST_PASSWORD).digest('hex');
const AUTH_COOKIE = `swarmie-auth=${AUTH_TOKEN}`;
const RECORDING_FIXTURE_ID = `recording-${Date.now()}`;
const LEGIT_RECORDING_FILENAME = `${RECORDING_FIXTURE_ID}.jsonl`;
const OUTSIDE_RECORDING_FILENAME = `outside-${RECORDING_FIXTURE_ID}.jsonl`;

let serverClose: () => Promise<void>;
let baseUrl: string;
let manager: SessionManager;
let legitRecordingPath: string;
let outsideRecordingPath: string;

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

  const server = await createServer(manager, { port: 0, password: TEST_PASSWORD }); // random port
  baseUrl = server.address;
  serverClose = server.close;

  const config = loadConfig();
  const configDir = getConfigDir();
  legitRecordingPath = join(config.recordDir, LEGIT_RECORDING_FILENAME);
  outsideRecordingPath = join(configDir, OUTSIDE_RECORDING_FILENAME);

  mkdirSync(config.recordDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const recordingFixture = `${JSON.stringify({
    _type: 'recording:header',
    version: 1,
    sessionId: 'recording-fixture',
    sessionName: 'Recording Fixture',
    tool: 'test',
    startTime: Date.now(),
    cwd: '/tmp',
  })}\n`;

  writeFileSync(legitRecordingPath, recordingFixture, 'utf-8');
  writeFileSync(outsideRecordingPath, recordingFixture, 'utf-8');
});

afterAll(async () => {
  rmSync(legitRecordingPath, { force: true });
  rmSync(outsideRecordingPath, { force: true });
  await serverClose();
});

function authHeaders(): HeadersInit {
  return { Cookie: AUTH_COOKIE };
}

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

describe('REST API', () => {
  it('createServer with port=0 returns a concrete bound port', () => {
    expect(new URL(baseUrl).port).not.toBe('0');
  });

  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: authHeaders() });
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.sessions).toBe(1);
  });

  it('GET /api/sessions returns session list', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { headers: authHeaders() });
    const body = await res.json() as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('test-sess');
  });

  it('GET /api/sessions/:id returns session detail', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-sess`, { headers: authHeaders() });
    const body = await res.json() as { id: string; tool: string };
    expect(body.id).toBe('test-sess');
    expect(body.tool).toBe('claude');
  });

  it('GET /api/sessions/:id returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/nonexistent`, { headers: authHeaders() });
    const body = await res.json() as {
      error: string;
      request_id: string;
      session_id: string;
      error_code: string;
    };
    expect(res.status).toBe(404);
    expect(body.error).toBe('Session not found');
    expect(body.error_code).toBe('SESSION_NOT_FOUND');
    expect(body.session_id).toBe('nonexistent');
    expect(typeof body.request_id).toBe('string');
  });

  it('GET /api/sessions/:id/events returns events', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-sess/events`, { headers: authHeaders() });
    const body = await res.json() as Array<{ type: string }>;
    expect(body.length).toBeGreaterThan(0);
    // First event is status:change (from start()) followed by session:start
    const types = body.map((e) => e.type);
    expect(types).toContain('session:start');
  });

  it('returns 401 without auth cookie and emits observability fields', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = await res.json() as {
        error: string;
        request_id: string;
        session_id: null;
        error_code: string;
      };
      expect(res.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
      expect(body.error_code).toBe('AUTH_UNAUTHORIZED');
      expect(body.session_id).toBeNull();
      expect(typeof body.request_id).toBe('string');

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const authFailedLog = logs.find((log) => log.event === 'auth.failed');
      expect(authFailedLog).toBeDefined();
      expect(authFailedLog?.error_code).toBe('AUTH_UNAUTHORIZED');
      expect(typeof authFailedLog?.request_id).toBe('string');
      expect(authFailedLog?.session_id).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns 401 when query token is provided without cookie/header', async () => {
    const res = await fetch(`${baseUrl}/api/health?token=${AUTH_TOKEN}`);
    const body = await res.json() as {
      error: string;
      request_id: string;
      session_id: null;
      error_code: string;
    };
    expect(res.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    expect(body.error_code).toBe('AUTH_UNAUTHORIZED');
    expect(body.session_id).toBeNull();
    expect(typeof body.request_id).toBe('string');
  });

  it('returns 401 for websocket path when only URL query token is provided', async () => {
    const res = await fetch(`${baseUrl}/ws?token=${AUTH_TOKEN}`);
    const body = await res.json() as {
      error: string;
      request_id: string;
      session_id: null;
      error_code: string;
    };
    expect(res.status).toBe(401);
    expect(body.error).toBe('Unauthorized');
    expect(body.error_code).toBe('AUTH_UNAUTHORIZED');
    expect(body.session_id).toBeNull();
    expect(typeof body.request_id).toBe('string');
  });

  it('GET /api/recordings/:filename allows loading recording within recordDir', async () => {
    const res = await fetch(`${baseUrl}/api/recordings/${LEGIT_RECORDING_FILENAME}`, { headers: authHeaders() });
    const body = await res.json() as {
      header: { sessionId: string; sessionName: string };
      events: unknown[];
    };
    expect(res.status).toBe(200);
    expect(body.header.sessionId).toBe('recording-fixture');
    expect(body.header.sessionName).toBe('Recording Fixture');
    expect(body.events).toEqual([]);
  });

  it('GET /api/recordings/:filename blocks traversal and absolute path payloads with 404', async () => {
    const traversalPayloads = [
      `..%2F${OUTSIDE_RECORDING_FILENAME}`,
      `..%5C${OUTSIDE_RECORDING_FILENAME}`,
      `..%252F${OUTSIDE_RECORDING_FILENAME}`,
      encodeURIComponent(outsideRecordingPath),
    ];

    for (const payload of traversalPayloads) {
      const res = await fetch(`${baseUrl}/api/recordings/${payload}`, { headers: authHeaders() });
      const body = await res.json() as { error: string };
      expect(res.status).toBe(404);
      expect(body.error).toBe('Recording not found');
    }
  });

  it('logs required fields for adapter start failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tool: 'bash',
          cwd: `/tmp/swarmie-missing-${Date.now()}`,
        }),
      });
      const body = await res.json() as {
        error: string;
        request_id: string;
        session_id: string;
        error_code: string;
      };
      expect(res.status).toBe(500);
      expect(body.error_code).toBe('ADAPTER_START_FAILED');
      expect(typeof body.request_id).toBe('string');
      expect(typeof body.session_id).toBe('string');

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const createFailedLog = logs.find((log) => log.event === 'session.create.failed');
      expect(createFailedLog).toBeDefined();
      expect(createFailedLog?.error_code).toBe('ADAPTER_START_FAILED');
      expect(createFailedLog?.request_id).toBe(body.request_id);
      expect(createFailedLog?.session_id).toBe(body.session_id);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs required fields for session kill', async () => {
    const killSessionId = `kill-${Date.now()}`;
    const adapter = new RemoteAdapter(
      { sessionId: killSessionId, toolArgs: [] },
      {
        name: 'claude',
        displayName: 'Claude Code',
        icon: '\u{1F916}',
        command: 'claude',
        supportsStructured: true,
      },
    );
    const session = manager.addSession(killSessionId, 'Kill Session', adapter);
    session.start();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}/api/sessions/${killSessionId}/kill`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const body = await res.json() as { ok: boolean };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);

      const logs = parseObservabilityLogs(errorSpy.mock.calls as unknown[][]);
      const killLog = logs.find((log) => log.event === 'session.kill.success');
      expect(killLog).toBeDefined();
      expect(killLog?.session_id).toBe(killSessionId);
      expect(typeof killLog?.request_id).toBe('string');
      expect(killLog?.error_code).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('redirects to /login for non-API routes without auth', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });
});
