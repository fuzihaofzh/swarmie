import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { SessionManager } from '../session/manager.js';
import type { NormalizedEvent } from '../adapters/types.js';
import type { SessionSummary } from '../session/types.js';

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export function setupWebSocket(app: FastifyInstance, manager: SessionManager): { broadcastShutdown: () => void } {
  const clients = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, Set<string>>(); // ws -> set of sessionIds

  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    subscriptions.set(socket, new Set());

    // Send current session list
    const sessionList: SessionSummary[] = manager.getSessionSummaries();
    send(socket, { type: 'session:list', sessions: sessionList });

    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as WSMessage;
        handleMessage(socket, msg, manager, subscriptions);
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      subscriptions.delete(socket);
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
