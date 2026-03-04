import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { SessionManager } from '../session/manager.js';
import type { NormalizedEvent } from '../adapters/types.js';
import type { SessionSummary } from '../session/types.js';
import { RemoteAdapter } from '../adapters/remote.js';
import type { BaseAdapter } from '../adapters/base.js';

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

/** Tracks a CLI client connected via WebSocket for remote session registration */
interface RemoteCLIClient {
  ws: WebSocket;
  sessionId: string;
}

export function setupWebSocket(app: FastifyInstance, manager: SessionManager): { broadcastShutdown: () => void } {
  const clients = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, Set<string>>(); // ws -> set of sessionIds

  /** Remote CLI clients indexed by sessionId */
  const remoteClients = new Map<string, RemoteCLIClient>();

  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    subscriptions.set(socket, new Set());

    // Don't send session list yet — if this is a CLI remote client,
    // it will send a 'register' message. If it's a browser, it will
    // get the list immediately (browser clients don't send 'register').
    // We send it on first non-register message or after a short delay.
    let sentSessionList = false;
    const ensureSessionList = () => {
      if (!sentSessionList) {
        sentSessionList = true;
        const sessionList: SessionSummary[] = manager.getSessionSummaries();
        send(socket, { type: 'session:list', sessions: sessionList });
      }
    };

    // Send session list immediately for browser clients.
    // CLI clients will send 'register' first, so we use a microtask delay.
    const listTimer = setTimeout(ensureSessionList, 50);

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as WSMessage;

        // Handle CLI remote registration
        if (msg.type === 'register') {
          clearTimeout(listTimer);
          sentSessionList = true; // CLI clients don't need the session list
          handleRemoteRegister(socket, msg, manager, remoteClients);
          return;
        }
        if (msg.type === 'event') {
          handleRemoteEvent(msg, manager, remoteClients);
          return;
        }
        if (msg.type === 'unregister') {
          // CLI client gracefully disconnecting — don't mark as disconnected
          const sessionId = msg.sessionId as string;
          remoteClients.delete(sessionId);
          return;
        }

        // Browser client messages
        ensureSessionList();
        handleMessage(socket, msg, manager, subscriptions);
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      clearTimeout(listTimer);
      clients.delete(socket);
      subscriptions.delete(socket);

      // Check if this was a remote CLI client and mark session as disconnected
      for (const [sessionId, client] of remoteClients) {
        if (client.ws === socket) {
          remoteClients.delete(sessionId);
          const session = manager.getSession(sessionId);
          if (session && !['completed', 'error'].includes(session.status)) {
            const remoteAdapter = getRemoteAdapter(manager, sessionId);
            remoteAdapter?.pushEvent({
              type: 'session:end',
              sessionId,
              timestamp: Date.now(),
              data: { exitCode: null, signal: 'disconnected' },
            });
          }
        }
      }
    });
  });

  // Broadcast new sessions
  manager.on('session:added', (summary: SessionSummary) => {
    broadcast(clients, { type: 'session:added', session: summary });
  });

  manager.on('session:removed', (sessionId: string) => {
    broadcast(clients, { type: 'session:removed', sessionId });
  });

  // Broadcast events to subscribed clients
  manager.on('event', (event: NormalizedEvent) => {
    for (const [ws, subs] of subscriptions) {
      // Send if subscribed to this session or subscribed to '*' (all)
      if (subs.has(event.sessionId) || subs.has('*')) {
        send(ws, { type: 'event', event });
      }
    }
  });

  return {
    broadcastShutdown: () => {
      broadcast(clients, { type: 'server:shutdown' });
    },
  };
}

function handleMessage(
  socket: WebSocket,
  msg: WSMessage,
  manager: SessionManager,
  subscriptions: Map<WebSocket, Set<string>>,
): void {
  const subs = subscriptions.get(socket);
  if (!subs) return;

  switch (msg.type) {
    case 'subscribe': {
      const sessionId = msg.sessionId as string;
      if (sessionId) {
        subs.add(sessionId);
        // Send recent events for this session
        const session = manager.getSession(sessionId);
        if (session) {
          const events = session.getRecentEvents();
          send(socket, { type: 'event:batch', sessionId, events });
        }
      }
      break;
    }
    case 'subscribe:all': {
      subs.add('*');
      // Send recent events for all existing sessions
      for (const session of manager.getAllSessions()) {
        const events = session.getRecentEvents();
        if (events.length > 0) {
          send(socket, { type: 'event:batch', sessionId: session.id, events });
        }
      }
      break;
    }
    case 'unsubscribe': {
      const sessionId = msg.sessionId as string;
      if (sessionId) subs.delete(sessionId);
      break;
    }
    case 'input': {
      const sessionId = msg.sessionId as string;
      const data = msg.data as string;
      if (sessionId && data) {
        const session = manager.getSession(sessionId);
        session?.write(data);
      }
      break;
    }
    case 'resize': {
      const sessionId = msg.sessionId as string;
      const cols = msg.cols as number;
      const rows = msg.rows as number;
      if (sessionId && cols && rows) {
        const session = manager.getSession(sessionId);
        // Don't resize local sessions — their PTY size is controlled by the CLI terminal
        if (session && !session.isLocal) {
          session.resize(cols, rows);
        }
      }
      break;
    }
  }
}

function send(ws: WebSocket, data: unknown): void {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(data));
  }
}

function broadcast(clients: Set<WebSocket>, data: unknown): void {
  const payload = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

function handleRemoteRegister(
  socket: WebSocket,
  msg: WSMessage,
  manager: SessionManager,
  remoteClients: Map<string, RemoteCLIClient>,
): void {
  const sessionId = msg.sessionId as string;
  const name = msg.name as string;
  const tool = msg.tool as string;
  const adapterInfo = msg.adapterInfo as BaseAdapter['info'];
  const cwd = (msg.cwd as string) || process.cwd();
  const hostname = (msg.hostname as string) || 'remote';

  if (!sessionId || !name || !adapterInfo) return;

  // If this sessionId already exists (reconnect), remove old session first
  const existing = remoteClients.get(sessionId);
  if (existing) {
    remoteClients.delete(sessionId);
    manager.removeSession(sessionId);
  }

  // Track the remote client
  remoteClients.set(sessionId, { ws: socket, sessionId });

  // Create a RemoteAdapter for this session
  const remoteAdapter = new RemoteAdapter(
    { sessionId, toolArgs: [], cwd },
    adapterInfo,
  );

  // Forward dashboard commands to the remote CLI via WebSocket
  remoteAdapter.onWrite = (data) => {
    send(socket, { type: 'input', sessionId, data });
  };
  remoteAdapter.onResize = (cols, rows) => {
    send(socket, { type: 'resize', sessionId, cols, rows });
  };
  remoteAdapter.onKill = (signal) => {
    send(socket, { type: 'kill', sessionId, signal });
  };

  const session = manager.addSession(sessionId, name, remoteAdapter, {
    cwd,
    hostname,
  });
  session.start();

  // Acknowledge registration
  send(socket, { type: 'registered', sessionId });
}

function handleRemoteEvent(
  msg: WSMessage,
  manager: SessionManager,
  _remoteClients: Map<string, RemoteCLIClient>,
): void {
  const event = msg.event as NormalizedEvent;
  if (!event || !event.sessionId) return;

  const remoteAdapter = getRemoteAdapter(manager, event.sessionId);
  remoteAdapter?.pushEvent(event);
}

function getRemoteAdapter(manager: SessionManager, sessionId: string): RemoteAdapter | null {
  const session = manager.getSession(sessionId);
  if (!session) return null;
  const adapter = session.adapter;
  if (adapter instanceof RemoteAdapter) return adapter;
  return null;
}
