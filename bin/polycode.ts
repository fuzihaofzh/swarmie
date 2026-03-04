#!/usr/bin/env node

import { parseArgs } from '../src/cli/index.js';
import { createAdapter } from '../src/adapters/index.js';
import { nanoid } from 'nanoid';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const { tool, polycodeOptions, toolArgs } = parsed;

  const sessionId = nanoid(12);
  const sessionName = polycodeOptions.sessionName ?? `${tool}-${sessionId.slice(0, 6)}`;

  console.error(`[polycode] Starting ${tool} session: ${sessionName}`);
  console.error(`[polycode] Session ID: ${sessionId}`);

  if (polycodeOptions.web) {
    console.error(`[polycode] Dashboard: http://localhost:${polycodeOptions.port}`);
  }

  // Create the adapter
  const adapter = createAdapter(tool, {
    sessionId,
    toolArgs,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });

  // Set up exit promise BEFORE starting — fast commands (--version, --help)
  // can exit before we'd otherwise register the listener
  const exitPromise = new Promise<number>((resolve) => {
    adapter.on('event', (event) => {
      if (event.type === 'session:end') {
        resolve(event.data.exitCode ?? 1);
      }
    });
  });

  // Pipe raw PTY output to stdout
  adapter.on('event', (event) => {
    if (event.type === 'raw:output') {
      const buf = Buffer.from(event.data.data, 'base64');
      process.stdout.write(buf);
    }
  });

  // Handle terminal resize
  if (process.stdout.isTTY) {
    process.stdout.on('resize', () => {
      adapter.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    });
  }

  // Pipe stdin to the adapter
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (data: Buffer) => {
    adapter.write(data.toString());
  });

  // Start coordinator (session manager + web server + adapter.start)
  let cleanup: (() => Promise<void>) | undefined;

  if (polycodeOptions.web) {
    const { startCoordinator } = await import('../src/coordinator.js');
    cleanup = await startCoordinator(polycodeOptions, adapter, sessionId, sessionName);
  } else {
    // No web server — just start the adapter directly
    adapter.start();
  }

  // Wait for the adapter to finish
  const exitCode = await exitPromise;

  // Cleanup
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  if (cleanup) {
    await cleanup();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[polycode] Fatal error:', err);
  process.exit(1);
});
