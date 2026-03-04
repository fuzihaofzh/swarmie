import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function setupStatic(app: FastifyInstance): Promise<void> {
  // In production, serve built web assets from dist/web
  // In development, Vite dev server handles this
  // __dirname at runtime is dist/src/server/, go up 3 levels to project root
  const webRoot = resolve(__dirname, '../../../dist/web');

  if (!existsSync(webRoot)) {
    // No built web assets — serve a minimal placeholder
    app.get('/', async (_request, reply) => {
      reply.type('text/html').send(placeholderHtml());
    });
    return;
  }

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
  });

  // SPA fallback — serve index.html for non-API, non-WS routes
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

function placeholderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>swarmie</title>
  <style>
    body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .container { text-align: center; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { color: #8b949e; }
    code { background: #161b22; padding: 2px 8px; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>swarmie</h1>
    <p>Dashboard not built yet. Run <code>npm run build:web</code> to build it.</p>
    <p>WebSocket endpoint available at <code>/ws</code></p>
    <p>REST API available at <code>/api/sessions</code></p>
  </div>
</body>
</html>`;
}
