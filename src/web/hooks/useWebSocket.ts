import { useSessionStore, type SessionSummary, type NormalizedEvent, type SessionSettingsPatch } from './useSessions';
import { writeToTerminal, clearTerminalBuffer, applyHistorySnapshot } from '../terminalBus';
import { useServerStore, LOCAL_SERVER } from './useServers';
import { useUIStore } from './useUI';
import { mergeBase64Chunks } from '../base64';

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

/**
 * Manages a single WebSocket + REST connection to one swarmie server.
 */
export class ServerConnection {
  readonly serverUrl: string;
  readonly token?: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private shutdown = false;
  private disposed = false;
  private retryPaused = false;
  /** sessionIds whose history we've already requested over the current ws.
   *  Cleared on every reconnect — the server tracks subscriptions per-socket. */
  private requestedReplay = new Set<string>();

  constructor(serverUrl: string, token?: string) {
    this.serverUrl = serverUrl;
    this.token = token;
  }

  /** Whether this connection targets the local (same-origin) server */
  get isLocal(): boolean {
    return this.serverUrl === LOCAL_SERVER;
  }

  connect(force = false): void {
    if (this.disposed || this.shutdown) return;
    if (this.retryPaused && !force) return;

    useServerStore.getState().setConnectionStatus(this.serverUrl, 'connecting');

    let wsUrl = this.isLocal
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : `${this.serverUrl.replace(/^http/, 'ws')}/ws`;
    const protocols = this.token && !this.isLocal ? [`swarmie-token.${this.token}`] : undefined;
    const ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.retryPaused = false;
      useServerStore.getState().setConnectionStatus(this.serverUrl, 'connected');
      this.requestedReplay.clear();
      ws.send(JSON.stringify({ type: 'subscribe:all' }));
      // Heartbeat to keep connection alive in background tabs
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WSMessage;
        this.handleMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.ws = null;
      clearInterval(this.pingTimer);
      if (!this.shutdown && !this.disposed) {
        if (this.retryPaused) {
          useServerStore.getState().setConnectionStatus(this.serverUrl, 'error');
          if (!this.isLocal) {
            useSessionStore.getState().removeServerSessions(this.serverUrl);
          }
          return;
        }
        useServerStore.getState().setConnectionStatus(this.serverUrl, 'disconnected');
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };

    ws.onerror = () => {
      if (!this.isLocal) {
        this.retryPaused = true;
      }
      useServerStore.getState().setConnectionStatus(this.serverUrl, 'error');
      ws.close();
    };
  }

  /** Reconnect immediately if the WebSocket is not open (e.g. after returning from background tab) */
  reconnectIfNeeded(): void {
    if (this.disposed || this.shutdown) return;
    if (this.retryPaused) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.connect();
  }

  retry(): void {
    if (this.disposed) return;
    this.shutdown = false;
    this.retryPaused = false;
    clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
    this.connect(true);
  }

  disconnect(): void {
    this.disposed = true;
    this.shutdown = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    useServerStore.getState().setConnectionStatus(this.serverUrl, 'disconnected');
  }

  send(msg: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendInput(sessionId: string, data: string): void {
    this.send({ type: 'input', sessionId, data });
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  sendRedraw(sessionId: string): void {
    this.send({ type: 'redraw', sessionId });
  }

  sendLoadHistory(sessionId: string, fromOffset: number): void {
    this.send({ type: 'history:load', sessionId, fromOffset });
  }

  /** Request the initial raw-output replay for a session, but only once per
   *  ws lifetime. Server's `subscribe:all` no longer pushes per-session
   *  replays (would blast N×2MB on connect), so callers ask for the active
   *  session's history on demand. */
  requestReplayOnce(sessionId: string): void {
    if (this.requestedReplay.has(sessionId)) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.requestedReplay.add(sessionId);
    this.send({ type: 'subscribe', sessionId });
  }

  sendAutoApprove(sessionId: string, value: boolean): void {
    this.send({ type: 'set:autoApprove', sessionId, value });
  }

  sendSessionSettings(sessionId: string, patch: SessionSettingsPatch): void {
    if (patch.autoApprove !== undefined) {
      this.send({ type: 'set:autoApprove', sessionId, value: patch.autoApprove });
    }
    if (patch.autoCompact !== undefined) {
      this.send({ type: 'set:autoCompact', sessionId, value: patch.autoCompact });
    }
    if (
      patch.repeatEnabled !== undefined ||
      patch.repeatCommand !== undefined ||
      patch.repeatIntervalSeconds !== undefined ||
      patch.repeatClear !== undefined
    ) {
      this.send({
        type: 'set:repeat',
        sessionId,
        enabled: patch.repeatEnabled,
        command: patch.repeatCommand,
        intervalSeconds: patch.repeatIntervalSeconds,
        clear: patch.repeatClear,
      });
    }
    if (patch.tags !== undefined) {
      this.send({ type: 'set:tags', sessionId, tags: patch.tags });
    }
  }

  sendAutoCompactMinutes(minutes: number): void {
    this.send({ type: 'set:autoCompactMinutes', minutes });
  }

  async createSession(opts: {
    tool?: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
  }): Promise<{ id: string; name: string; tool: string; status: string } | null> {
    try {
      const base = this.apiBase();
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        const err = await res.json();
        console.error('Failed to create session:', err);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error('Failed to create session:', err);
      return null;
    }
  }

  async killSession(sessionId: string): Promise<void> {
    try {
      const base = this.apiBase();
      await fetch(`${base}/api/sessions/${sessionId}/kill`, {
        method: 'POST',
        headers: this.authHeaders(),
      });
    } catch {
      // ignore
    }
  }

  async fetchRecentDirs(): Promise<string[]> {
    try {
      const base = this.apiBase();
      const r = await fetch(`${base}/api/recent-dirs`, {
        headers: this.authHeaders(),
      });
      return await r.json();
    } catch {
      return [];
    }
  }

  async pickFolder(): Promise<string | null> {
    try {
      const base = this.apiBase();
      const r = await fetch(`${base}/api/pick-folder`, {
        method: 'POST',
        headers: this.authHeaders(),
      });
      if (r.ok) {
        const data = await r.json();
        return data?.path ?? null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** Returns base URL for REST calls — empty string for local server */
  private apiBase(): string {
    return this.isLocal ? '' : this.serverUrl;
  }

  /** Returns fetch headers with auth token for remote servers */
  private authHeaders(): Record<string, string> {
    if (this.token && !this.isLocal) {
      return { Authorization: `Bearer ${this.token}` };
    }
    return {};
  }

  private handleMessage(msg: WSMessage): void {
    const store = useSessionStore.getState();
    const serverUrl = this.serverUrl;

    switch (msg.type) {
      case 'session:list': {
        const sessions = (msg.sessions as SessionSummary[]).map((s) => ({
          ...s,
          serverUrl,
        }));
        store.setServerSessions(serverUrl, sessions);
        this.sendAutoCompactMinutes(useUIStore.getState().autoCompactMinutes);
        for (const session of useSessionStore.getState().sessions.filter((s) => s.serverUrl === serverUrl)) {
          this.sendSessionSettings(session.id, {
            autoApprove: !!session.autoApprove,
            autoCompact: !!session.autoCompact,
            repeatEnabled: !!session.repeatEnabled,
            repeatCommand: session.repeatCommand ?? '',
            repeatIntervalSeconds: session.repeatIntervalSeconds ?? 60,
            repeatClear: !!session.repeatClear,
            tags: session.tags ?? [],
          });
        }
        break;
      }
      case 'session:added': {
        const session = { ...(msg.session as SessionSummary), serverUrl };
        store.addSession(session);
        const synced = useSessionStore.getState().sessions.find((s) => s.id === session.id);
        if (synced) {
          this.sendSessionSettings(synced.id, {
            autoApprove: !!synced.autoApprove,
            autoCompact: !!synced.autoCompact,
            repeatEnabled: !!synced.repeatEnabled,
            repeatCommand: synced.repeatCommand ?? '',
            repeatIntervalSeconds: synced.repeatIntervalSeconds ?? 60,
            repeatClear: !!synced.repeatClear,
            tags: synced.tags ?? [],
          });
        }
        break;
      }
      case 'session:removed':
        clearTerminalBuffer(msg.sessionId as string);
        store.removeSession(msg.sessionId as string);
        break;
      case 'session:autoApprove':
        // Update local state only — don't sync back to server
        store._setAutoApproveLocal(msg.sessionId as string, !!msg.value);
        break;
      case 'session:settings':
        store._applySessionSettingsLocal(
          msg.sessionId as string,
          (msg.settings ?? {}) as SessionSettingsPatch,
        );
        break;
      case 'settings:autoCompactMinutes':
        useUIStore.getState()._setAutoCompactMinutesLocal(Number(msg.minutes));
        break;
      case 'server:shutdown':
        if (this.isLocal) {
          // Local server shutdown — same behavior as before
          this.shutdown = true;
          clearTimeout(this.reconnectTimer);
          this.ws?.close();
          this.ws = null;
          window.close();
          document.title = '[Closed] swarmie';
          document.body.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#8b949e;font-size:14px;">swarmie server has stopped.</div>';
        } else {
          // Remote server shutdown — just remove its sessions
          this.shutdown = true;
          clearTimeout(this.reconnectTimer);
          this.ws?.close();
          this.ws = null;
          useServerStore.getState().setConnectionStatus(serverUrl, 'disconnected');
          store.removeServerSessions(serverUrl);
        }
        break;
      case 'event': {
        const evt = msg.event as NormalizedEvent;
        if (evt.type === 'raw:output') {
          const data = evt.data as { data: string; offsetEnd?: number };
          writeToTerminal(evt.sessionId, data.data, data.offsetEnd);
        } else {
          store.addEvent(evt);
        }
        break;
      }
      case 'event:batch': {
        const sid = msg.sessionId as string;
        const all = msg.events as NormalizedEvent[];
        const structured: NormalizedEvent[] = [];
        const rawChunks: string[] = [];
        let mergedOffsetEnd: number | undefined;
        for (const evt of all) {
          if (evt.type === 'raw:output') {
            const data = evt.data as { data: string; offsetEnd?: number };
            rawChunks.push(data.data);
            if (typeof data.offsetEnd === 'number') {
              // The merged blob's offsetEnd is the last chunk's offsetEnd.
              mergedOffsetEnd = data.offsetEnd;
            }
          } else {
            structured.push(evt);
          }
        }
        if (rawChunks.length > 0) {
          writeToTerminal(sid, mergeBase64Chunks(rawChunks), mergedOffsetEnd);
        }
        if (structured.length > 0) {
          store.addEventBatch(sid, structured);
        }
        break;
      }
      case 'history:snapshot': {
        const sid = msg.sessionId as string;
        const startOffset = Number(msg.startOffset);
        const endOffset = Number(msg.endOffset);
        const data = Array.isArray(msg.data) ? (msg.data as string[]) : [];
        const reachedEarliest = !!msg.reachedEarliest;
        applyHistorySnapshot(sid, {
          startOffset,
          endOffset,
          chunks: data,
          reachedEarliest,
        });
        break;
      }
    }
  }
}
