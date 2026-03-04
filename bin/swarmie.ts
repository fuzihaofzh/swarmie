#!/usr/bin/env node

import { parseArgs } from '../src/cli/index.js';
import { createAdapter } from '../src/adapters/index.js';
import { nanoid } from 'nanoid';

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const { tool, swarmieOptions, toolArgs } = parsed;

  // Server-only mode: no tool specified
  if (!tool) {
    swarmieOptions.web = true;
    const dashHost = swarmieOptions.host === '0.0.0.0' ? 'localhost' : swarmieOptions.host;
    console.error(`[swarmie] Starting in server-only mode`);
    console.error(`[swarmie] Dashboard: http://${dashHost}:${swarmieOptions.port}`);

    const { startCoordinator } = await import('../src/coordinator.js');
    const coordinator = await startCoordinator(swarmieOptions);

    // Wait for SIGINT
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        console.error('\n[swarmie] Shutting down...');
        resolve();
      });
    });

    await coordinator.cleanup();
    process.exit(0);
    return;
  }

  // Tool mode: existing behavior
  const sessionId = nanoid(12);
  const sessionName = swarmieOptions.sessionName ?? `${tool}-${sessionId.slice(0, 6)}`;

  console.error(`[swarmie] Starting ${tool} session: ${sessionName}`);
  console.error(`[swarmie] Session ID: ${sessionId}`);

  if (swarmieOptions.server) {
    console.error(`[swarmie] Remote server: ${swarmieOptions.server}`);
  } else if (swarmieOptions.web) {
    const dashHost = swarmieOptions.host === '0.0.0.0' ? 'localhost' : swarmieOptions.host;
    console.error(`[swarmie] Dashboard: http://${dashHost}:${swarmieOptions.port}`);
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
  let coordinator: Awaited<ReturnType<typeof import('../src/coordinator.js').startCoordinator>> | undefined;

  if (swarmieOptions.web || swarmieOptions.server) {
    const { startCoordinator } = await import('../src/coordinator.js');
    coordinator = await startCoordinator(swarmieOptions, adapter, sessionId, sessionName);
  } else {
    // No web server and no remote — just start the adapter directly
    adapter.start();
  }

  // Wait for the adapter to finish
  const exitCode = await exitPromise;

  // Restore terminal
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();

  if (coordinator) {
    // If we're the coordinator and other sessions are still active, keep running
    if (coordinator.isCoordinator && coordinator.activeSessionCount() > 0) {
      const remaining = coordinator.activeSessionCount();
      console.error(`\n[swarmie] Local session ended. ${remaining} other session(s) still active.`);
      console.error(`[swarmie] Server still running at http://localhost:${swarmieOptions.port}`);
      console.error(`[swarmie] Press Ctrl+C to stop.\n`);

      // Wait for all sessions to end or SIGINT
      await Promise.race([
        coordinator.waitForAllDone(),
        new Promise<void>((resolve) => {
          process.once('SIGINT', () => {
            console.error('\n[swarmie] Shutting down...');
            resolve();
          });
        }),
      ]);
    }

    await coordinator.cleanup();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[swarmie] Fatal error:', err);
  process.exit(1);
});
