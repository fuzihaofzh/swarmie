// Pre-compress built web assets into .gz and .br siblings so the server can
// serve them statically via @fastify/static { preCompressed: true }.
//
// Why static pre-compression instead of @fastify/compress: on the EL9/Node 22
// deployment path, runtime compression intermittently emitted a
// `content-encoding` header with an empty body (blank page). Pre-compressed
// files are plain static bytes — no runtime compression step, no empty-body
// failure mode — while still cutting the ~900KB JS bundle to ~1/4 on the wire.

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '../dist/web');

// Only compress text-based assets; binary (png/woff2/…) is already compressed.
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.map', '.txt', '.ico', '.webmanifest']);
// Below this, gzip/brotli framing overhead outweighs the savings.
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function main() {
  try {
    await stat(webRoot);
  } catch {
    console.warn(`[precompress] ${webRoot} not found — run "vite build" first. Skipping.`);
    return;
  }

  let files = 0;
  let rawTotal = 0;
  let brTotal = 0;

  for await (const file of walk(webRoot)) {
    const ext = extname(file);
    if (!COMPRESSIBLE.has(ext)) continue;
    // Don't recompress our own outputs.
    if (file.endsWith('.gz') || file.endsWith('.br')) continue;

    const data = await readFile(file);
    if (data.length < MIN_BYTES) continue;

    const gz = gzipSync(data, { level: 9 });
    const br = brotliCompressSync(data, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });

    await writeFile(`${file}.gz`, gz);
    await writeFile(`${file}.br`, br);

    files++;
    rawTotal += data.length;
    brTotal += br.length;
  }

  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  console.log(
    `[precompress] ${files} files: ${kb(rawTotal)} → ${kb(brTotal)} brotli ` +
    `(${rawTotal ? Math.round((1 - brTotal / rawTotal) * 100) : 0}% smaller)`,
  );
}

main().catch((err) => {
  console.error('[precompress] failed:', err);
  process.exit(1);
});
