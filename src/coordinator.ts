import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import type { SwarmieOptions } from './cli/index.js';
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
import { WSRemoteClient, parseServerAddress } from './ipc/ws-client.js';

export interface CoordinatorHandle {
  cleanup: () => Promise<void>;
  /** Number of sessions still running (excluding completed/error) */
  activeSessionCount: () => number;
  /** Resolves when all sessions reach a terminal status */
  waitForAllDone: () => Promise<void>;
  /** Whether this process is the coordinator (has the web/IPC server) */
  isCoordinator: boolean;
  /** Session manager (only available on coordinator) */
  manager?: SessionManager;
}

/**
 * Try to become the coordinator. If another coordinator is already running,
 * connect to it as a client instead.
 *
 * If `options.server` is set, connect to a remote coordinator via WebSocket
 * instead of trying local IPC.
 */
export async function startCoordinator(
  options: SwarmieOptions,
  adapter?: BaseAdapter,
  sessionId?: string,
  sessionName?: string,
): Promise<CoordinatorHandle> {
  // Remote server mode — connect to a remote coordinator via WebSocket
  if (options.server) {
    if (!adapter || !sessionId || !sessionName) {
      throw new Error('Remote mode requires adapter, sessionId, and sessionName');
    }
    return startAsRemoteClient(options.server, adapter, sessionId, sessionName);
  }

  ensureConfigDir();
  const socketPath = getSocketPath();
  const lockPath = getLockPath();

  // Check if a coordinator is already running
  if (existsSync(socketPath) && existsSync(lockPath)) {
    const pid = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    if (isProcessRunning(pid)) {
      if (!adapter || !sessionId || !sessionName) {
        throw new Error('Another coordinator is already running; client mode requires adapter, sessionId, and sessionName');
      }
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
  options: SwarmieOptions,
  adapter: BaseAdapter | undefined,
  sessionId: string | undefined,
  sessionName: string | undefined,
  socketPath: string,
  lockPath: string,
): Promise<CoordinatorHandle> {
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

  // Register the local session (only if an adapter was provided)
  let recorder: SessionRecorder | undefined;
  if (adapter && sessionId && sessionName) {
    const session = manager.addSession(sessionId, sessionName, adapter);
    session.isLocal = true;
    session.start();

    // Start recording if requested
    if (options.record) {
      const config = loadConfig();
      recorder = new SessionRecorder(config.recordDir, session);
      console.error(`[swarmie] Recording to ${recorder.filePath}`);
    }
  }

  // Start web server
  const server = await createServer(manager, { port: options.port, host: options.host, password: options.password });
  console.error(`[swarmie] Web server listening at ${server.address}`);
  console.error(`[swarmie] IPC server listening at ${socketPath}`);

  return {
    isCoordinator: true,
    manager,
    cleanup: async () => {
      recorder?.close();
      // Kill all still-running sessions
      for (const s of manager.getAllSessions()) {
        if (!['completed', 'error'].includes(s.status)) {
          try { s.kill(); } catch { /* ignore */ }
        }
      }
      await ipcServer.close();
      await server.close();
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    },
    activeSessionCount: () => {
      return manager.getAllSessions().filter(
        (s) => !['completed', 'error'].includes(s.status),
      ).length;
    },
    waitForAllDone: () => {
      return new Promise<void>((resolve) => {
        // Check immediately
        const allDone = () =>
          manager.getAllSessions().every((s) => ['completed', 'error'].includes(s.status));
        if (allDone()) { resolve(); return; }
        // Listen for status changes
        const check = () => {
          if (allDone()) {
            manager.removeListener('event', check);
            resolve();
          }
        };
        manager.on('event', check);
      });
    },
  };
}

async function startAsClient(
  socketPath: string,
  adapter: BaseAdapter,
  sessionId: string,
  sessionName: string,
): Promise<CoordinatorHandle> {
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

  console.error(`[swarmie] Connected to coordinator via IPC`);

  return {
    isCoordinator: false,
    cleanup: async () => { client.close(); },
    activeSessionCount: () => 0, // Client only knows about its own session
    waitForAllDone: () => Promise.resolve(), // Client doesn't wait for others
  };
}

async function startAsRemoteClient(
  serverAddr: string,
  adapter: BaseAdapter,
  sessionId: string,
  sessionName: string,
): Promise<CoordinatorHandle> {
  const wsUrl = parseServerAddress(serverAddr);
  const client = new WSRemoteClient(wsUrl, sessionId);

  await client.connect();

  // Register this session with the remote coordinator
  client.register({
    name: sessionName,
    tool: adapter.info.name,
    adapterInfo: adapter.info,
    cwd: process.cwd(),
    hostname: (await import('node:os')).hostname(),
    command: [],
  });

  // Forward adapter events to the remote coordinator
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

  console.error(`[swarmie] Connected to remote coordinator at ${serverAddr}`);

  return {
    isCoordinator: false,
    cleanup: async () => { client.close(); },
    activeSessionCount: () => 0,
    waitForAllDone: () => Promise.resolve(),
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
