import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { SessionManager } from '../session/manager.js';
import type { NormalizedEvent } from '../adapters/types.js';
import type { SessionSummary } from '../session/types.js';
import { RemoteAdapter, getRemoteAdapter } from '../adapters/remote.js';
import type { BaseAdapter } from '../adapters/base.js';
import { logObservabilityEvent, resolveRequestId } from './observability.js';

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

const BROWSER_MESSAGE_TYPES = new Set([
  'subscribe',
  'subscribe:all',
  'unsubscribe',
  'input',
  'resize',
  'redraw',
  'history:load',
  'set:autoApprove',
  'set:autoCompact',
  'set:repeat',
  'set:tags',
  'set:autoCompactMinutes',
]);

/** Tracks a CLI client connected via WebSocket for remote session registration */
interface RemoteCLIClient {
  ws: WebSocket;
  sessionId: string;
}

export interface WebSocketHandle {
  broadcastShutdown: () => void;
  stop: () => void;
  /** Register the owning CLI terminal's size as a virtual client for MIN calculation */
  setCliSize: (sessionId: string, cols: number, rows: number) => void;
  /** Drop the CLI's contribution for a session (e.g., when the session ends) */
  dropCliSize: (sessionId: string) => void;
}

/** Sentinel key for the local CLI terminal's reported size in clientSizes. */
const CLI_SIZE_KEY: unique symbol = Symbol('cli-size');

export function setupWebSocket(app: FastifyInstance, manager: SessionManager): WebSocketHandle {
  const clients = new Set<WebSocket>();
  const subscriptions = new Map<WebSocket, Set<string>>(); // ws -> set of sessionIds
  const socketRequestIds = new Map<WebSocket, string>();
  // Per-(client, sessionId) reported viewport size. Clients are WebSockets,
  // plus a single CLI_SIZE_KEY entry for the owning local terminal (if any).
  // The PTY runs at MIN across all clients (tmux-style) so TUI apps render
  // correctly on the smallest attached viewport; larger clients just get
  // letterboxed.
  const clientSizes = new Map<WebSocket | typeof CLI_SIZE_KEY, Map<string, { cols: number; rows: number }>>();
  // Last applied PTY size per session — used to dedup so we don't fire
  // SIGWINCH (which makes ink-based apps redraw) when nothing changed.
  const appliedSize = new Map<string, { cols: number; rows: number }>();
  // Pending resize timers per session. iOS Safari's URL bar hide/show makes
  // visualViewport.height oscillate; without debouncing, every oscillation
  // hits the PTY and ink redraws half-finish, leaving the screen garbled.
  const resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const RESIZE_DEBOUNCE_MS = 250;
  // Last time we received any frame (message or pong) from this socket.
  // Mobile browsers commonly suspend JS in the background and leave the WS
  // half-open; without this server-side liveness probe a backgrounded mobile
  // would keep its (small) reported size pinned in clientSizes forever.
  const lastSeen = new Map<WebSocket, number>();
  const STALE_MS = 30_000;

  /** Remote CLI clients indexed by sessionId */
  const remoteClients = new Map<string, RemoteCLIClient>();

  function applyMinSizeForSession(sessionId: string): void {
    let minCols = Infinity;
    let minRows = Infinity;
    for (const perSession of clientSizes.values()) {
      const entry = perSession.get(sessionId);
      if (!entry) continue;
      if (entry.cols < minCols) minCols = entry.cols;
      if (entry.rows < minRows) minRows = entry.rows;
    }
    if (!Number.isFinite(minCols) || !Number.isFinite(minRows)) return;

    const pending = resizeTimers.get(sessionId);
    if (pending) clearTimeout(pending);
    resizeTimers.set(sessionId, setTimeout(() => {
      resizeTimers.delete(sessionId);
      const applied = appliedSize.get(sessionId);
      if (applied?.cols === minCols && applied.rows === minRows) return;
      appliedSize.set(sessionId, { cols: minCols, rows: minRows });
      manager.getSession(sessionId)?.resize(minCols, minRows);
    }, RESIZE_DEBOUNCE_MS));
  }

  function recordClientSize(key: WebSocket | typeof CLI_SIZE_KEY, sessionId: string, cols: number, rows: number): void {
    let perSession = clientSizes.get(key);
    if (!perSession) {
      perSession = new Map();
      clientSizes.set(key, perSession);
    }
    perSession.set(sessionId, { cols, rows });
    applyMinSizeForSession(sessionId);
  }

  function dropClientSizes(key: WebSocket | typeof CLI_SIZE_KEY): void {
    const perSession = clientSizes.get(key);
    if (!perSession) return;
    const affected = [...perSession.keys()];
    clientSizes.delete(key);
    // Recompute MIN with this client removed. If it was the only contributor,
    // we leave the PTY at its last size (no clients = no resize).
    for (const sessionId of affected) {
      applyMinSizeForSession(sessionId);
    }
  }

  function setCliSize(sessionId: string, cols: number, rows: number): void {
    recordClientSize(CLI_SIZE_KEY, sessionId, cols, rows);
  }

  function dropCliSize(sessionId: string): void {
    const perSession = clientSizes.get(CLI_SIZE_KEY);
    if (!perSession) return;
    if (!perSession.delete(sessionId)) return;
    if (perSession.size === 0) clientSizes.delete(CLI_SIZE_KEY);
    applyMinSizeForSession(sessionId);
  }

  // Periodic liveness check: reap sockets that haven't sent an *application*
  // message in STALE_MS. We don't ping at the WS protocol level — iOS Safari
  // auto-pongs from the network stack even while JS is suspended, which would
  // mask a backgrounded mobile and keep its size pinned in clientSizes. The
  // browser-side `pingTimer` (15s) supplies the heartbeat we look for.
  const livenessTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of clients) {
      const seen = lastSeen.get(ws) ?? now;
      if (now - seen > STALE_MS) {
        try { ws.terminate(); } catch { /* ignore */ }
      }
    }
  }, 10_000);

  // Event-loop lag sampler. A setInterval that fires late means the loop was
  // blocked by synchronous work (huge JSON.stringify, history snapshot, etc.).
  // We keep the peak so a single debug snapshot reveals a stall that already
  // happened — if maxEventLoopLagMs is in the hundreds, the freeze is the
  // server blocking, not the network or the browser.
  const LAG_SAMPLE_MS = 1000;
  let eventLoopLagMs = 0;
  let maxEventLoopLagMs = 0;
  let lastLagTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    eventLoopLagMs = Math.max(0, now - lastLagTick - LAG_SAMPLE_MS);
    if (eventLoopLagMs > maxEventLoopLagMs) maxEventLoopLagMs = eventLoopLagMs;
    lastLagTick = now;
  }, LAG_SAMPLE_MS);

  app.get('/ws', { websocket: true }, (socket, request) => {
    const requestId = resolveRequestId(request);
    clients.add(socket);
    subscriptions.set(socket, new Set());
    socketRequestIds.set(socket, requestId);
    lastSeen.set(socket, Date.now());
    logObservabilityEvent('ws.connect', {
      requestId,
      sessionId: null,
      errorCode: null,
      details: {
        path: request.url,
      },
    });

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
      lastSeen.set(socket, Date.now());
      const socketRequestId = socketRequestIds.get(socket) ?? requestId;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString()) as unknown;
      } catch {
        logObservabilityEvent('ws.invalid_message', {
          level: 'warn',
          requestId: socketRequestId,
          sessionId: null,
          errorCode: 'WS_INVALID_MESSAGE',
          details: { reason: 'json_parse_failed' },
        });
        return;
      }

      if (!isWSMessage(parsed)) {
        logObservabilityEvent('ws.invalid_message', {
          level: 'warn',
          requestId: socketRequestId,
          sessionId: null,
          errorCode: 'WS_INVALID_MESSAGE',
          details: { reason: 'invalid_shape' },
        });
        return;
      }

      const msg = parsed;

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
      if (msg.type === 'cli:size') {
        // Remote CLI reporting its owning terminal's size. Tracked under the
        // CLI socket like any browser viewport so it joins the MIN that
        // drives the PTY; cleared automatically on socket close via
        // dropClientSizes(socket).
        const sessionId = msg.sessionId as string;
        const cols = msg.cols as number;
        const rows = msg.rows as number;
        if (sessionId && cols && rows) {
          recordClientSize(socket, sessionId, cols, rows);
        }
        return;
      }
      if (msg.type === 'ping') {
        // Browser keepalive — no-op, just prevents the connection from going idle
        return;
      }

      if (!BROWSER_MESSAGE_TYPES.has(msg.type)) {
        logObservabilityEvent('ws.invalid_message', {
          level: 'warn',
          requestId: socketRequestId,
          sessionId: null,
          errorCode: 'WS_INVALID_MESSAGE',
          details: { reason: 'unsupported_type', type: msg.type },
        });
        return;
      }

      // Browser client messages
      ensureSessionList();
      handleMessage(socket, msg, manager, subscriptions, clients, recordClientSize);
    });

    socket.on('close', () => {
      clearTimeout(listTimer);
      clients.delete(socket);
      subscriptions.delete(socket);
      dropClientSizes(socket);
      lastSeen.delete(socket);
      const socketRequestId = socketRequestIds.get(socket) ?? requestId;
      socketRequestIds.delete(socket);

      // Check if this was a remote CLI client and mark session as disconnected
      let disconnectedSessionId: string | null = null;
      let disconnectErrorCode: string | null = null;
      for (const [sessionId, client] of remoteClients) {
        if (client.ws === socket) {
          remoteClients.delete(sessionId);
          disconnectedSessionId = sessionId;
          disconnectErrorCode = 'WS_CLIENT_DISCONNECTED';
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
      logObservabilityEvent('ws.disconnect', {
        requestId: socketRequestId,
        sessionId: disconnectedSessionId,
        errorCode: disconnectErrorCode,
      });
    });
  });

  // Diagnostics: snapshot of live WS / buffer state. The remote dashboard
  // freezing "after a while" almost always means data is queueing faster than
  // the tunnel drains it — `ws.bufferedAmount` climbing without bound — or a
  // session's 16MB raw ring inflating every replay. This endpoint surfaces
  // both so we can tell which it is instead of guessing. Open /api/debug/ws.
  const serverStart = Date.now();
  app.get('/api/debug/ws', async () => {
    const now = Date.now();
    const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;

    // Reverse-map sockets to the remote-CLI session they own (if any).
    const remoteBySocket = new Map<WebSocket, string>();
    for (const [sessionId, client] of remoteClients) {
      remoteBySocket.set(client.ws, sessionId);
    }

    let totalBuffered = 0;
    const clientList = [...clients].map((ws, i) => {
      const buffered = ws.bufferedAmount ?? 0;
      totalBuffered += buffered;
      const subs = subscriptions.get(ws);
      const remoteSessionId = remoteBySocket.get(ws);
      return {
        index: i,
        readyState: ws.readyState, // 1 = OPEN
        bufferedBytes: buffered,
        bufferedMB: mb(buffered),
        backpressured: buffered > WS_BUFFERED_WARN_BYTES,
        subscriptions: subs ? [...subs] : [],
        subCount: subs ? subs.size : 0,
        lastSeenMsAgo: now - (lastSeen.get(ws) ?? now),
        kind: remoteSessionId ? 'remote-cli' : 'browser',
        remoteSessionId: remoteSessionId ?? null,
      };
    });

    let totalSessionRawBytes = 0;
    const sessions = manager.getAllSessions().map((s) => {
      const stats = s.getBufferStats();
      totalSessionRawBytes += stats.rawBytes;
      const bytesLast5s = s.getRecentRawBytes(5000);
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        isLocal: s.isLocal,
        events: stats.events,
        rawEvents: stats.rawEvents,
        rawBytes: stats.rawBytes,
        rawMB: mb(stats.rawBytes),
        rawBytesEverWritten: stats.rawBytesEverWritten,
        rawEverMB: mb(stats.rawBytesEverWritten),
        detectBufferLen: stats.detectBufferLen,
        // Instantaneous output throughput. A session pushing MB/s is what
        // overwhelms the browser's xterm and looks like a freeze.
        bytesPerSec: Math.round(bytesLast5s / 5),
        kbPerSec: Math.round((bytesLast5s / 5 / 1024) * 10) / 10,
      };
    });

    const mem = process.memoryUsage();
    return {
      now: new Date(now).toISOString(),
      uptimeSec: Math.round((now - serverStart) / 1000),
      // Hundreds of ms here means the Node event loop was blocked — the freeze
      // is server-side synchronous work, not the network or the browser.
      eventLoopLagMs,
      maxEventLoopLagMs,
      memory: {
        rssMB: mb(mem.rss),
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        externalMB: mb(mem.external),
        arrayBuffersMB: mb(mem.arrayBuffers),
      },
      ws: {
        totalClients: clients.size,
        totalBufferedBytes: totalBuffered,
        totalBufferedMB: mb(totalBuffered),
        backpressuredWarnBytes: WS_BUFFERED_WARN_BYTES,
        clients: clientList,
      },
      remoteClients: remoteClients.size,
      pendingResizeTimers: resizeTimers.size,
      sessions: {
        count: sessions.length,
        totalRawBytes: totalSessionRawBytes,
        totalRawMB: mb(totalSessionRawBytes),
        list: sessions,
      },
    };
  });

  // Broadcast new sessions
  manager.on('session:added', (summary: SessionSummary) => {
    broadcast(clients, { type: 'session:added', session: summary });
  });

  manager.on('session:removed', (sessionId: string) => {
    const pending = resizeTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      resizeTimers.delete(sessionId);
    }
    appliedSize.delete(sessionId);
    for (const perSession of clientSizes.values()) {
      perSession.delete(sessionId);
    }
    broadcast(clients, { type: 'session:removed', sessionId });
  });

  // Broadcast events to subscribed clients. raw:output fires constantly, so
  // serialize each message ONCE here rather than per subscribed client.
  manager.on('event', (event: NormalizedEvent) => {
    const eventPayload = JSON.stringify({ type: 'event', event });
    const session = event.type === 'status:change' ? manager.getSession(event.sessionId) : undefined;
    const settingsPayload = session
      ? JSON.stringify({
          type: 'session:settings',
          sessionId: event.sessionId,
          settings: sessionSettingsPayload(session),
        })
      : null;
    for (const [ws, subs] of subscriptions) {
      // Send if subscribed to this session or subscribed to '*' (all)
      if (subs.has(event.sessionId) || subs.has('*')) {
        sendRaw(ws, eventPayload);
        if (settingsPayload) sendRaw(ws, settingsPayload);
      }
    }
  });

  return {
    broadcastShutdown: () => {
      broadcast(clients, { type: 'server:shutdown' });
    },
    stop: () => {
      clearInterval(livenessTimer);
      clearInterval(lagTimer);
      for (const timer of resizeTimers.values()) clearTimeout(timer);
      resizeTimers.clear();
    },
    setCliSize,
    dropCliSize,
  };
}

function handleMessage(
  socket: WebSocket,
  msg: WSMessage,
  manager: SessionManager,
  subscriptions: Map<WebSocket, Set<string>>,
  clients: Set<WebSocket>,
  recordClientSize: (socket: WebSocket, sessionId: string, cols: number, rows: number) => void,
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
      // Subscribe to live events for every session (used for status/settings
      // updates across the dashboard) but DO NOT replay raw history here.
      // Replaying N × 2MB on every connect saturates bandwidth-limited
      // tunnels (e.g. SSH -L) and stalls the WS write loop. Clients request
      // per-session replay via `subscribe { sessionId }` when the user
      // actually views that session.
      subs.add('*');
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
        // Record this client's reported size and re-apply MIN across all
        // connected clients (tmux-style) so TUI apps render correctly on
        // the smallest attached viewport.
        recordClientSize(socket, sessionId, cols, rows);
      }
      break;
    }
    case 'redraw': {
      const sessionId = msg.sessionId as string;
      if (sessionId) {
        const session = manager.getSession(sessionId);
        session?.redraw();
      }
      break;
    }
    case 'history:load': {
      const sessionId = msg.sessionId as string;
      const fromOffset = typeof msg.fromOffset === 'number'
        ? msg.fromOffset
        : Number(msg.fromOffset);
      if (!sessionId || !Number.isFinite(fromOffset)) break;
      const session = manager.getSession(sessionId);
      if (!session) break;
      const snapshot = session.getRawHistorySnapshot(fromOffset);
      send(socket, {
        type: 'history:snapshot',
        sessionId,
        startOffset: snapshot.startOffset,
        endOffset: snapshot.endOffset,
        data: snapshot.chunks,
        reachedEarliest: snapshot.reachedEarliest,
      });
      break;
    }
    case 'set:autoApprove': {
      const sessionId = msg.sessionId as string;
      const value = !!msg.value;
      if (sessionId) {
        const session = manager.setSessionSettings(sessionId, { autoApprove: value });
        if (session) {
          // Broadcast to all clients so all devices stay in sync
          broadcast(clients, { type: 'session:settings', sessionId, settings: sessionSettingsPayload(session) });
        }
      }
      break;
    }
    case 'set:autoCompact': {
      const sessionId = msg.sessionId as string;
      const value = !!msg.value;
      if (sessionId) {
        const session = manager.setSessionSettings(sessionId, { autoCompact: value });
        if (session) {
          broadcast(clients, { type: 'session:settings', sessionId, settings: sessionSettingsPayload(session) });
        }
      }
      break;
    }
    case 'set:repeat': {
      const sessionId = msg.sessionId as string;
      const intervalSeconds = typeof msg.intervalSeconds === 'number'
        ? msg.intervalSeconds
        : Number(msg.intervalSeconds);
      if (sessionId) {
        const patch = {
          ...(typeof msg.enabled === 'boolean' ? { repeatEnabled: msg.enabled } : {}),
          ...(typeof msg.command === 'string' ? { repeatCommand: msg.command } : {}),
          ...(Number.isFinite(intervalSeconds) ? { repeatIntervalSeconds: intervalSeconds } : {}),
          ...(typeof msg.clear === 'boolean' ? { repeatClear: msg.clear } : {}),
        };
        const session = manager.setSessionSettings(sessionId, {
          ...patch,
        });
        if (session) {
          broadcast(clients, { type: 'session:settings', sessionId, settings: sessionSettingsPayload(session) });
        }
      }
      break;
    }
    case 'set:tags': {
      const sessionId = msg.sessionId as string;
      const tags = Array.isArray(msg.tags) ? msg.tags.filter((tag): tag is string => typeof tag === 'string') : [];
      if (sessionId) {
        const session = manager.setSessionSettings(sessionId, { tags });
        if (session) {
          broadcast(clients, { type: 'session:settings', sessionId, settings: sessionSettingsPayload(session) });
        }
      }
      break;
    }
    case 'set:autoCompactMinutes': {
      const minutes = typeof msg.minutes === 'number' ? msg.minutes : Number(msg.minutes);
      if (Number.isFinite(minutes)) {
        const value = manager.setAutoCompactMinutes(minutes);
        broadcast(clients, { type: 'settings:autoCompactMinutes', minutes: value });
      }
      break;
    }
  }
}

function sessionSettingsPayload(session: NonNullable<ReturnType<SessionManager['getSession']>>): Record<string, unknown> {
  return {
    autoApprove: session.autoApprove,
    autoCompact: session.autoCompact,
    repeatEnabled: session.repeatEnabled,
    repeatCommand: session.repeatCommand,
    repeatIntervalSeconds: session.repeatIntervalSeconds,
    repeatClear: session.repeatClear,
    nextRepeatAt: session.summary.nextRepeatAt ?? null,
    nextAutoCompactAt: session.summary.nextAutoCompactAt ?? null,
    tags: session.tags,
  };
}

// Soft cap on per-socket buffered bytes. Above this we log a warning so we
// can spot pathological cases; we don't drop messages — the underlying ws
// library will continue to queue, and the callback form of ws.send() lets
// callers chain large replays serially instead of blasting them at once.
const WS_BUFFERED_WARN_BYTES = 4 * 1024 * 1024;

function warnIfBackpressured(ws: WebSocket): void {
  if (ws.bufferedAmount > WS_BUFFERED_WARN_BYTES) {
    logObservabilityEvent('ws.backpressure', {
      level: 'warn',
      requestId: null,
      sessionId: null,
      errorCode: 'WS_BACKPRESSURE',
      details: { bufferedAmount: ws.bufferedAmount },
    });
  }
}

/** Send an already-serialized payload — lets callers stringify once and fan
 *  the same string out to many sockets instead of re-encoding per client. */
function sendRaw(ws: WebSocket, payload: string): void {
  if (ws.readyState !== 1) return; // not OPEN
  warnIfBackpressured(ws);
  ws.send(payload);
}

function send(ws: WebSocket, data: unknown, onWritten?: (err?: Error) => void): void {
  if (ws.readyState !== 1) { // not OPEN
    onWritten?.(new Error('ws not open'));
    return;
  }
  warnIfBackpressured(ws);
  ws.send(JSON.stringify(data), (err?: Error) => onWritten?.(err));
}

function broadcast(clients: Set<WebSocket>, data: unknown): void {
  const payload = JSON.stringify(data);
  for (const ws of clients) {
    sendRaw(ws, payload);
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

function isWSMessage(value: unknown): value is WSMessage {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as { type?: unknown }).type === 'string';
}
