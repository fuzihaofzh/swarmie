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

  // Do not use @fastify/compress globally here. On the EL9/Node 22 deployment
  // path it can return `content-encoding: gzip/br` with an empty body for
  // dynamic HTML routes such as /login, which makes mobile browsers show a
  // blank page. If we reintroduce compression, prefer precompressed static
  // assets or route-scoped compression with an integration test for /login.

  // Auth: always enabled. CLI --password overrides; otherwise uses stored password or prompts setup.
  setupAuth(app, options.password);

  // WebSocket support. Enable per-message deflate: terminal output is highly
  // compressible text (typically 5-10x), so compressing /ws frames is the
  // biggest lever for lag over a real network on long-running sessions. This is
  // the `ws` library's own per-message compression — it only touches WS frames,
  // NOT the HTTP/static/login responses that @fastify/compress broke on EL9
  // above, so it does not reintroduce that blank-page risk. Bounded memLevel +
  // concurrencyLimit keep ws's known perMessageDeflate memory growth in check.
  await app.register(websocket, {
    options: {
      perMessageDeflate: {
        threshold: 1024, // skip tiny frames — compression overhead isn't worth it
        concurrencyLimit: 10,
        zlibDeflateOptions: { level: 6, memLevel: 7 },
      },
    },
  });

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
