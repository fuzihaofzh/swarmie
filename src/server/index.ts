import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
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

export interface ServerHandle {
  close: () => Promise<void>;
  address: string;
  /** Register the owning CLI terminal's reported size so it counts in MIN. */
  setCliSize: (sessionId: string, cols: number, rows: number) => void;
  /** Drop the CLI's contribution for a session. */
  dropCliSize: (sessionId: string) => void;
}

export async function createServer(
  manager: SessionManager,
  options: ServerOptions,
): Promise<ServerHandle> {
  const app = Fastify({ logger: false });

  // CORS must be registered BEFORE auth so that CORS headers appear on 401 responses too
  await app.register(cors, { origin: true, credentials: true });

  // Gzip/Brotli responses. The web bundle is ~1MB uncompressed (JS 994KB +
  // CSS 78KB); over a remote/relayed tunnel that uncompressed transfer is the
  // dominant cost of a cold page load. Compression cuts it ~4-5x (JS → ~250KB
  // gzip / ~200KB brotli). global: true so @fastify/static responses are
  // compressed too; threshold skips tiny payloads where framing overhead wins.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'],
  });

  // Auth: always enabled. CLI --password overrides; otherwise uses stored password or prompts setup.
  setupAuth(app, options.password);

  // WebSocket support
  await app.register(websocket);

  // REST API routes
  setupRoutes(app, manager);

  // WebSocket handler
  const { broadcastShutdown, stop: stopWebSocket, setCliSize, dropCliSize } = setupWebSocket(app, manager);

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
    setCliSize,
    dropCliSize,
    close: async () => {
      broadcastShutdown();
      stopWebSocket();
      // Small delay to let the shutdown message reach clients
      await new Promise((r) => setTimeout(r, 100));
      await app.close();
    },
  };
}
