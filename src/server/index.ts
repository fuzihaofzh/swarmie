import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import type { SessionManager } from '../session/manager.js';
import { setupRoutes } from './routes.js';
import { setupWebSocket } from './websocket.js';
import { setupStatic } from './static.js';
import { setupAuth } from './auth.js';

export interface ServerOptions {
  port: number;
  host?: string;
  password?: string;
}

export async function createServer(
  manager: SessionManager,
  options: ServerOptions,
): Promise<{ close: () => Promise<void>; address: string }> {
  const app = Fastify({ logger: false });

  // CORS must be registered BEFORE auth so that CORS headers appear on 401 responses too
  await app.register(cors, { origin: true, credentials: true });

  // Auth: always enabled. CLI --password overrides; otherwise uses stored password or prompts setup.
  setupAuth(app, options.password);

  // WebSocket support
  await app.register(websocket);

  // REST API routes
  setupRoutes(app, manager);

  // WebSocket handler
  const { broadcastShutdown } = setupWebSocket(app, manager);

  // Static files (web dashboard)
  await setupStatic(app);

  const host = options.host ?? '127.0.0.1';
  await app.listen({ port: options.port, host });
  const bound = app.server.address() as AddressInfo | null;
  const boundHost = bound?.address ?? host;
  const boundPort = bound?.port ?? options.port;
  const displayHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
  const address = `http://${displayHost}:${boundPort}`;

  return {
    address,
    close: async () => {
      broadcastShutdown();
      // Small delay to let the shutdown message reach clients
      await new Promise((r) => setTimeout(r, 100));
      await app.close();
    },
  };
}
