import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import type { PolycodeOptions } from './cli/index.js';
import { ensureConfigDir, getSocketPath, getLockPath } from './cli/config.js';
import type { BaseAdapter } from './adapters/index.js';
import type { NormalizedEvent } from './adapters/types.js';
import { RemoteAdapter } from './adapters/remote.js';
import { SessionManager } from './session/manager.js';
import { createServer } from './server/index.js';
import { SessionRecorder } from './session/recorder.js';
import { loadConfig } from './cli/config.js';
import { IPCServer } from './ipc/server.js';
import { IPCClient } from './ipc/client.js';

/**
 * Try to become the coordinator. If another coordinator is already running,
 * connect to it as a client instead.
 */
export async function startCoordinator(
  options: PolycodeOptions,
  adapter: BaseAdapter,
  sessionId: string,
  sessionName: string,
): Promise<() => Promise<void>> {
  ensureConfigDir();
  const socketPath = getSocketPath();
  const lockPath = getLockPath();

  // Check if a coordinator is already running
  if (existsSync(socketPath) && existsSync(lockPath)) {
    const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      // Connect as IPC client
      return startAsClient(socketPath, adapter, sessionId, sessionName);
    }
    // Stale lock — clean up
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  // Become the coordinator
  return startAsCoordinator(options, adapter, sessionId, sessionName, socketPath, lockPath);
}

async function startAsCoordinator(
  options: PolycodeOptions,
  adapter: BaseAdapter,
  sessionId: string,
  sessionName: string,
  socketPath: string,
  lockPath: string,
): Promise<() => Promise<void>> {
  // Write lock file
  writeFileSync(lockPath, String(process.pid), 'utf-8');

  const manager = new SessionManager();

  // Start IPC server
  const ipcServer = new IPCServer(socketPath);
  await ipcServer.start();

  // Handle remote sessions registering via IPC
  ipcServer.on('session:registered', (info: {
    id: string;
    name: string;
    tool: string;
    adapterInfo: BaseAdapter['info'];
    cwd: string;
    hostname: string;
    command: string[];
  }) => {
    const remoteAdapter = new RemoteAdapter(
      { sessionId: info.id, toolArgs: [], cwd: info.cwd },
      info.adapterInfo,
    );
    // Forward input/resize/kill from web dashboard to the remote process via IPC
    remoteAdapter.onWrite = (data) => {
      ipcServer.sendToSession(info.id, { type: 'input', sessionId: info.id, data });
    };
    remoteAdapter.onResize = (cols, rows) => {
      ipcServer.sendToSession(info.id, { type: 'resize', sessionId: info.id, cols, rows });
    };
    remoteAdapter.onKill = (signal) => {
      ipcServer.sendToSession(info.id, { type: 'kill', sessionId: info.id, signal });
    };

    const session = manager.addSession(info.id, info.name, remoteAdapter, {
      cwd: info.cwd,
      hostname: info.hostname,
    });
    session.start();
  });

  // Handle events from remote sessions
  ipcServer.on('session:event', (event: NormalizedEvent) => {
    const session = manager.getSession(event.sessionId);
    if (session) {
      // Push event into the remote adapter
      const info = session.info;
      // Get the underlying adapter — we know it's a RemoteAdapter for IPC sessions
      // For simplicity, re-emit via the session manager
      const remoteAdapter = getRemoteAdapter(manager, event.sessionId);
      remoteAdapter?.pushEvent(event);
    }
  });

  ipcServer.on('session:disconnected', (sessionIdDisc: string) => {
    // Keep the session in the list but mark as completed if still running
    const session = manager.getSession(sessionIdDisc);
    if (session && !['completed', 'error'].includes(session.status)) {
      const remoteAdapter = getRemoteAdapter(manager, sessionIdDisc);
      remoteAdapter?.pushEvent({
        type: 'session:end',
        sessionId: sessionIdDisc,
        timestamp: Date.now(),
        data: { exitCode: null, signal: 'disconnected' },
      });
    }
  });

  // Register the local session
  const session = manager.addSession(sessionId, sessionName, adapter);
  session.isLocal = true;
  session.start();

  // Start recording if requested
  let recorder: SessionRecorder | undefined;
  if (options.record) {
    const config = loadConfig();
    recorder = new SessionRecorder(config.recordDir, session);
    console.error(`[polycode] Recording to ${recorder.filePath}`);
  }

  // Start web server
  const server = await createServer(manager, { port: options.port });
  console.error(`[polycode] Web server listening at ${server.address}`);
  console.error(`[polycode] IPC server listening at ${socketPath}`);

  return async () => {
    recorder?.close();
    await ipcServer.close();
    await server.close();
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  };
}

async function startAsClient(
  socketPath: string,
  adapter: BaseAdapter,
  sessionId: string,
  sessionName: string,
): Promise<() => Promise<void>> {
  const client = new IPCClient(socketPath, sessionId);
  await client.connect();

  // Register this session with the coordinator
  client.register({
    name: sessionName,
    tool: adapter.info.name,
    adapterInfo: adapter.info,
    cwd: process.cwd(),
    hostname: (await import('node:os')).hostname(),
    command: [],
  });

  // Forward adapter events to the coordinator
  adapter.on('event', (event: NormalizedEvent) => {
    client.sendEvent(event);
  });

  // Handle commands from coordinator (input/resize/kill from web dashboard)
  client.on('input', (data: string) => {
    adapter.write(data);
  });
  client.on('resize', (cols: number, rows: number) => {
    adapter.resize(cols, rows);
  });
  client.on('kill', (signal?: string) => {
    adapter.kill(signal);
  });

  // Start the adapter
  adapter.start();

  console.error(`[polycode] Connected to coordinator via IPC`);

  return async () => {
    client.close();
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRemoteAdapter(manager: SessionManager, sessionId: string): RemoteAdapter | null {
  const session = manager.getSession(sessionId);
  if (!session) return null;
  const adapter = session.adapter;
  if (adapter instanceof RemoteAdapter) return adapter;
  return null;
}
