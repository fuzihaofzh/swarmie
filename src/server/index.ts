import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { SessionManager } from '../session/manager.js';
import { setupRoutes } from './routes.js';
import { setupWebSocket } from './websocket.js';
import { setupStatic } from './static.js';

export interface ServerOptions {
  port: number;
  host?: string;
}

export async function createServer(
  manager: SessionManager,
  options: ServerOptions,
): Promise<{ close: () => Promise<void>; address: string }> {
  const app = Fastify({ logger: false });

  // WebSocket support
  await app.register(websocket);

  // REST API routes
  setupRoutes(app, manager);

  // WebSocket handler
  setupWebSocket(app, manager);

  // Static files (web dashboard)
  await setupStatic(app);

  const host = options.host ?? '127.0.0.1';
  const address = await app.listen({ port: options.port, host });

  return {
    address,
    close: async () => {
      await app.close();
    },
  };
}
