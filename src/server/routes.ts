import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../session/manager.js';
import { loadRecording } from '../session/replayer.js';
import { loadConfig } from '../cli/config.js';

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

  // Health check
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      sessions: manager.size,
      uptime: process.uptime(),
    };
  });
}
