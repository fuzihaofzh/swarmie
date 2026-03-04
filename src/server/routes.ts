import { readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFile } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../session/manager.js';
import { loadRecording } from '../session/replayer.js';
import { loadConfig } from '../cli/config.js';
import { createAdapter, getAdapterNames } from '../adapters/registry.js';
import { nanoid } from 'nanoid';

export function setupRoutes(app: FastifyInstance, manager: SessionManager): void {
  // List all sessions
  app.get('/api/sessions', async () => {
    return manager.getSessionSummaries();
  });

  // Get session detail
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    return session.info;
  });

  // Get session events
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/sessions/:id/events',
    async (request, reply) => {
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
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
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      session.write(request.body.data);
      return { ok: true };
    },
  );

  // Resize session PTY
  app.post<{ Params: { id: string }; Body: { cols: number; rows: number } }>(
    '/api/sessions/:id/resize',
    async (request, reply) => {
      const session = manager.getSession(request.params.id);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      session.resize(request.body.cols, request.body.rows);
      return { ok: true };
    },
  );

  // Kill session
  app.post<{ Params: { id: string } }>('/api/sessions/:id/kill', async (request, reply) => {
    const session = manager.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    session.kill();
    manager.removeSession(request.params.id);
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
    const filePath = join(config.recordDir, request.params.filename);
    try {
      const recording = loadRecording(filePath);
      return recording;
    } catch (err) {
      return reply.status(404).send({ error: 'Recording not found' });
    }
  });

  // Create a new session from web UI
  app.post<{
    Body: {
      tool: string;
      args?: string[];
      cwd?: string;
      sessionName?: string;
      cols?: number;
      rows?: number;
    };
  }>('/api/sessions', async (request, reply) => {
    const { tool, args, cwd, sessionName, cols, rows } = request.body;
    if (!tool) {
      return reply.status(400).send({ error: 'tool is required' });
    }

    const sessionId = nanoid(12);
    const name = sessionName || `${tool}-${sessionId.slice(0, 6)}`;

    try {
      const adapter = createAdapter(tool, {
        sessionId,
        toolArgs: args ?? [],
        cols: cols ?? 120,
        rows: rows ?? 30,
        cwd: cwd || undefined,
      });

      const session = manager.addSession(sessionId, name, adapter);
      session.isLocal = false;
      session.start();

      return { id: sessionId, name, tool, status: session.status };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
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
}
