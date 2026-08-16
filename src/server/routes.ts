import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../session/manager.js';
import { loadRecording } from '../session/replayer.js';
import { loadConfig } from '../cli/config.js';
import { createAdapter, getAdapterNames } from '../adapters/registry.js';
import { nanoid } from 'nanoid';
import { logObservabilityEvent, resolveRequestId } from './observability.js';
import { stripAnsiToText } from '../adapters/ansi.js';
import type { Session } from '../session/session.js';

const WAITABLE_STATES = new Set([
  'starting',
  'running',
  'thinking',
  'tool_executing',
  'waiting_input',
  'idle',
  'done',
  'completed',
  'error',
  'working',
  'blocked',
  'unknown',
]);
const WAIT_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function matchWaitState(session: Session, requested: Set<string>, afterSeq?: number): string | null {
  if (afterSeq !== undefined && session.stateChangeSeq <= afterSeq) return null;
  const status = session.status;
  if (requested.has(status)) return status;
  const detectionState = session.adapter.getDetectionExplanation().state;
  if (requested.has(detectionState)) return detectionState;
  if (requested.has('blocked') && status === 'waiting_input') return 'blocked';
  if (requested.has('working')
      && (status === 'running' || status === 'thinking' || status === 'tool_executing')) {
    return 'working';
  }
  return null;
}

function resolveRecordingFilePath(recordDir: string, rawFilename: string): string | null {
  if (!rawFilename || rawFilename.includes('\0')) {
    return null;
  }

  const normalizedFilename = rawFilename.replace(/\\/g, '/');

  // Reject partially decoded traversal payloads (for example: ..%2Ffoo from double encoding).
  if (/%2e|%2f|%5c/i.test(normalizedFilename)) {
    return null;
  }

  if (normalizedFilename.startsWith('/') || /^[a-zA-Z]:\//.test(normalizedFilename)) {
    return null;
  }

  if (normalizedFilename.includes('/')) {
    return null;
  }

  if (normalizedFilename === '.' || normalizedFilename === '..') {
    return null;
  }

  const baseDir = resolve(recordDir);
  const resolvedPath = resolve(baseDir, normalizedFilename);
  const rel = relative(baseDir, resolvedPath);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }

  return resolvedPath;
}

export function setupRoutes(app: FastifyInstance, manager: SessionManager): void {
  // List all sessions
  app.get('/api/sessions', async () => {
    return manager.getSessionSummaries();
  });

  // Get session detail
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const requestId = resolveRequestId(request);
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'SESSION_NOT_FOUND',
      });
    }
    return session.info;
  });

  // Explain the agent state classifier's latest decision. Terminal text is
  // excluded unless explicitly requested because prompts can contain secrets.
  app.get<{ Params: { id: string }; Querystring: { includeText?: string } }>(
    '/api/sessions/:id/detection',
    async (request, reply) => {
      const requestId = resolveRequestId(request);
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          request_id: requestId,
          session_id: request.params.id,
          error_code: 'SESSION_NOT_FOUND',
        });
      }
      return session.adapter.getDetectionExplanation(request.query.includeText === '1');
    },
  );

  // Wait until either the published session status or the internal lifecycle
  // classifier reaches one of the requested states.
  app.get<{
    Params: { id: string };
    Querystring: { state?: string; timeoutMs?: string; afterSeq?: string };
  }>('/api/sessions/:id/wait', async (request, reply) => {
    const requestId = resolveRequestId(request);
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'SESSION_NOT_FOUND',
      });
    }

    const states = (request.query.state ?? 'idle,done,blocked,completed,error')
      .split(',')
      .map((state) => state.trim())
      .filter(Boolean);
    if (states.length === 0 || states.some((state) => !WAITABLE_STATES.has(state))) {
      return reply.status(400).send({
        error: 'Invalid wait state',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'INVALID_WAIT_STATE',
        allowed: Array.from(WAITABLE_STATES),
      });
    }

    const parsedTimeout = Number(request.query.timeoutMs ?? '30000');
    if (!Number.isFinite(parsedTimeout) || parsedTimeout < 0) {
      return reply.status(400).send({
        error: 'Invalid timeoutMs',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'INVALID_WAIT_TIMEOUT',
      });
    }
    const timeoutMs = Math.min(WAIT_MAX_TIMEOUT_MS, Math.floor(parsedTimeout));
    const parsedAfterSeq = request.query.afterSeq === undefined
      ? undefined
      : Number(request.query.afterSeq);
    if (parsedAfterSeq !== undefined
        && (!Number.isSafeInteger(parsedAfterSeq) || parsedAfterSeq < 0)) {
      return reply.status(400).send({
        error: 'Invalid afterSeq',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'INVALID_WAIT_SEQUENCE',
      });
    }
    const requested = new Set(states);
    const startedAt = Date.now();

    const immediate = matchWaitState(session, requested, parsedAfterSeq);
    if (immediate) {
      return {
        reached: true,
        matched: immediate,
        status: session.status,
        stateChangeSeq: session.stateChangeSeq,
        detectionState: session.adapter.getDetectionExplanation().state,
        elapsedMs: 0,
      };
    }

    const outcome = await new Promise<{ reached: boolean; matched: string | null; reason: string }>((resolveWait) => {
      let settled = false;
      const finish = (reached: boolean, matched: string | null, reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off('event', onEvent);
        manager.off('session:removed', onSessionRemoved);
        request.raw.off('aborted', onAborted);
        resolveWait({ reached, matched, reason });
      };
      const onEvent = (event?: { type?: string }): void => {
        const matched = matchWaitState(session, requested, parsedAfterSeq);
        if (matched) {
          finish(true, matched, 'state_reached');
        } else if (event?.type === 'session:end') {
          finish(false, null, 'session_ended');
        }
      };
      const onSessionRemoved = (removedId: string): void => {
        if (removedId === session.id) finish(false, null, 'session_removed');
      };
      const onAborted = (): void => finish(false, null, 'request_aborted');

      session.on('event', onEvent);
      manager.on('session:removed', onSessionRemoved);
      request.raw.once('aborted', onAborted);
      const timer = setTimeout(() => finish(false, null, 'timeout'), timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      // Close the check/listener race: the state may have changed between the
      // immediate check above and listener registration.
      onEvent();
    });

    return {
      ...outcome,
      status: session.status,
      stateChangeSeq: session.stateChangeSeq,
      detectionState: session.adapter.getDetectionExplanation().state,
      elapsedMs: Date.now() - startedAt,
    };
  });

  // A visible dashboard acknowledges attention-worthy states. Completion is
  // sticky (`done`) until seen, then returns to ordinary idle.
  app.post<{ Params: { id: string } }>('/api/sessions/:id/seen', async (request, reply) => {
    const requestId = resolveRequestId(request);
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({
        error: 'Session not found',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'SESSION_NOT_FOUND',
      });
    }
    session.markSeen();
    return {
      ok: true,
      status: session.status,
      seen: session.seen,
      stateChangeSeq: session.stateChangeSeq,
    };
  });

  // Get session events
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/sessions/:id/events',
    async (request, reply) => {
      const requestId = resolveRequestId(request);
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          request_id: requestId,
          session_id: request.params.id,
          error_code: 'SESSION_NOT_FOUND',
        });
      }
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : undefined;
      const events = session.getRecentEvents();
      return limit ? events.slice(-limit) : events;
    },
  );

  // Send input to session
  app.post<{ Params: { id: string }; Body: { data: string } }>(
    '/api/sessions/:id/input',
    async (request, reply) => {
      const requestId = resolveRequestId(request);
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          request_id: requestId,
          session_id: request.params.id,
          error_code: 'SESSION_NOT_FOUND',
        });
      }
      session.write(request.body.data);
      return { ok: true };
    },
  );

  // Resize session PTY
  app.post<{ Params: { id: string }; Body: { cols: number; rows: number } }>(
    '/api/sessions/:id/resize',
    async (request, reply) => {
      const requestId = resolveRequestId(request);
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({
          error: 'Session not found',
          request_id: requestId,
          session_id: request.params.id,
          error_code: 'SESSION_NOT_FOUND',
        });
      }
      session.resize(request.body.cols, request.body.rows);
      return { ok: true };
    },
  );

  // Kill session
  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (request, reply) => {
    const requestId = resolveRequestId(request);
    const session = manager.getSession(request.params.id);
    if (!session) {
      logObservabilityEvent('session.kill.failed', {
        level: 'warn',
        requestId,
        sessionId: request.params.id,
        errorCode: 'SESSION_NOT_FOUND',
      });
      return reply.status(404).send({
        error: 'Session not found',
        request_id: requestId,
        session_id: request.params.id,
        error_code: 'SESSION_NOT_FOUND',
      });
    }
    session.kill();
    manager.removeSession(request.params.id);
    logObservabilityEvent('session.kill.success', {
      requestId,
      sessionId: request.params.id,
      errorCode: null,
    });
    return { ok: true };
  });

  // List recordings
  app.get('/api/recordings', async () => {
    const config = loadConfig();
    try {
      const files = readdirSync(config.recordDir).filter((f) => f.endsWith('.jsonl'));
      return files.map((f) => ({
        filename: f,
        path: join(config.recordDir, f),
      }));
    } catch {
      return [];
    }
  });

  // Load a recording
  app.get<{ Params: { filename: string } }>('/api/recordings/:filename', async (request, reply) => {
    const config = loadConfig();
    const filePath = resolveRecordingFilePath(config.recordDir, request.params.filename);
    if (!filePath) {
      return reply.status(404).send({ error: 'Recording not found' });
    }
    try {
      const recording = loadRecording(filePath);
      return recording;
    } catch {
      return reply.status(404).send({ error: 'Recording not found' });
    }
  });

  // Create a new session from web UI
  app.post<{
    Body: {
      tool?: string;
      args?: string[];
      cwd?: string;
      sessionName?: string;
      cols?: number;
      rows?: number;
    };
  }>('/api/sessions', async (request, reply) => {
    const requestId = resolveRequestId(request);
    const { tool: rawTool, args, cwd, sessionName, cols, rows } = request.body;
    const tool = rawTool || process.env.SHELL || 'bash';
    const sessionCwd = cwd || homedir();

    const sessionId = nanoid(12);
    const name = sessionName || `${tool}-${sessionId.slice(0, 6)}`;

    try {
      const cwdStat = statSync(sessionCwd);
      if (!cwdStat.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${sessionCwd}`);
      }

      const adapter = createAdapter(tool, {
        sessionId,
        toolArgs: args ?? [],
        cols: cols ?? 120,
        rows: rows ?? 30,
        cwd: sessionCwd,
      });

      const session = manager.addSession(sessionId, name, adapter, { cwd: sessionCwd });
      session.isLocal = false;
      session.start();

      logObservabilityEvent('session.create.success', {
        requestId,
        sessionId,
        errorCode: null,
        details: { tool },
      });

      return { id: sessionId, name, tool, status: session.status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logObservabilityEvent('session.create.failed', {
        level: 'error',
        requestId,
        sessionId,
        errorCode: 'ADAPTER_START_FAILED',
        details: {
          tool,
          cwd: sessionCwd,
          path: process.env.PATH ?? null,
          error: message,
        },
      });
      return reply.status(500).send({
        error: message,
        request_id: requestId,
        session_id: sessionId,
        error_code: 'ADAPTER_START_FAILED',
      });
    }
  });

  // List available tools
  app.get('/api/tools', async () => {
    return getAdapterNames();
  });

  // Open native folder picker dialog
  app.post('/api/pick-folder', async (_request, reply) => {
    const os = platform();
    try {
      const folder = await new Promise<string>((resolve, reject) => {
        if (os === 'darwin') {
          execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select Working Directory")'], (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim().replace(/\/$/, ''));
          });
        } else if (os === 'linux') {
          execFile('zenity', ['--file-selection', '--directory', '--title=Select Working Directory'], (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim());
          });
        } else if (os === 'win32') {
          const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}`;
          execFile('powershell', ['-NoProfile', '-Command', ps], (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim());
          });
        } else {
          reject(new Error('Unsupported platform'));
        }
      });
      if (!folder) return reply.status(204).send();
      return { path: folder };
    } catch {
      return reply.status(204).send();
    }
  });

  // Browse directories
  app.get<{ Querystring: { path?: string } }>('/api/browse', async (request) => {
    const target = resolve(request.query.path || homedir());
    const parent = dirname(target);
    const dirs: string[] = [];
    try {
      for (const entry of readdirSync(target)) {
        if (entry.startsWith('.')) continue;
        try {
          const full = join(target, entry);
          if (statSync(full).isDirectory()) dirs.push(entry);
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // target not readable
    }
    dirs.sort((a, b) => a.localeCompare(b));
    return { current: target, parent: parent !== target ? parent : null, dirs };
  });

  // Get recent working directories from sessions
  app.get('/api/recent-dirs', async () => {
    const summaries = manager.getSessionSummaries();
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const s of summaries) {
      if (s.cwd && !seen.has(s.cwd)) {
        seen.add(s.cwd);
        dirs.push(s.cwd);
      }
    }
    // Also include server cwd
    const serverCwd = process.cwd();
    if (!seen.has(serverCwd)) {
      dirs.unshift(serverCwd);
    }
    return dirs.slice(0, 10);
  });

  // Health check
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      sessions: manager.size,
      uptime: process.uptime(),
    };
  });

  // Buffer stats per session
  app.get('/api/stats', async () => {
    return manager.getAllSessions().map((s) => {
      const events = s.getRecentEvents();
      let rawBytes = 0;
      let rawCount = 0;
      let structuredCount = 0;
      for (const e of events) {
        if (e.type === 'raw:output') {
          rawCount++;
          rawBytes += Math.ceil(((e.data as { data: string }).data.length) * 3 / 4);
        } else {
          structuredCount++;
        }
      }
      return { id: s.id, name: s.name, rawCount, rawBytes, structuredCount, totalEvents: events.length };
    });
  });

  // Debug: auto-approve state for all sessions
  app.get('/api/debug/auto-approve', async () => {
    return manager.getAllSessions().map((s) => {
      const events = s.getRecentEvents();
      const statusEvents = events.filter((e) => e.type === 'status:change');
      // Last few raw outputs decoded to text for context
      const rawEvents = events.filter((e) => e.type === 'raw:output');
      const recentRaw = rawEvents.slice(-5).map((e) => {
        const b64 = (e.data as { data: string }).data;
        try {
          const text = stripAnsiToText(Buffer.from(b64, 'base64').toString('utf-8'));
          return { time: new Date(e.timestamp).toISOString(), text: text.slice(-200) };
        } catch {
          return { time: new Date(e.timestamp).toISOString(), text: '(decode error)' };
        }
      });
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        autoApprove: s.autoApprove,
        autoCompact: s.autoCompact,
        repeatEnabled: s.repeatEnabled,
        repeatCommand: s.repeatCommand,
        repeatIntervalSeconds: s.repeatIntervalSeconds,
        repeatClear: s.repeatClear,
        tags: s.tags,
        isLocal: s.isLocal,
        detectBuffer: s.adapter.detectBuffer.slice(-500),
        autoApproveDebug: s.getAutoApproveDebug(),
        recentStatusChanges: statusEvents.slice(-5).map((e) => ({
          ...e.data,
          time: new Date(e.timestamp).toISOString(),
        })),
        recentOutput: recentRaw,
      };
    });
  });

  // Debug endpoint - shows server environment for troubleshooting
  app.get('/api/debug', async () => {
    const { execSync } = await import('node:child_process');
    let whichClaude = '';
    try {
      whichClaude = execSync('which claude', { env: process.env, timeout: 3000 }).toString().trim();
    } catch { whichClaude = 'not found'; }
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      cwd: process.cwd(),
      whichClaude,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  });
}
