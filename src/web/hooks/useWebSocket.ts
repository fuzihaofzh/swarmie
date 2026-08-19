import { useSessionStore, type SessionSummary, type NormalizedEvent, type SessionSettingsPatch } from './useSessions';
import { clearTerminalBuffer } from '../terminalBus';
import { useServerStore, LOCAL_SERVER } from './useServers';
import { useUIStore } from './useUI';

type WSMessage = {
  type: string;
  [key: string]: unknown;
};

export interface CreatedSession {
  id: string;
  name: string;
  tool: string;
  status: string;
}

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
  private reconnectAttempts = 0;
  private pendingSessionSettings = new Map<string, SessionSettingsPatch>();
  private pendingAutoCompactMinutes: number | null = null;
  private pendingSeenSessions = new Set<string>();
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
    if (
      !force &&
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    clearTimeout(this.reconnectTimer);

    useServerStore.getState().setConnectionStatus(this.serverUrl, 'connecting');

    let wsUrl = this.isLocal
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : `${this.serverUrl.replace(/^http/, 'ws')}/ws`;
    const protocols = this.token && !this.isLocal ? [`swarmie-token.${this.token}`] : undefined;

    const previous = this.ws;
    if (previous && previous.readyState !== WebSocket.CLOSED) {
      previous.onopen = null;
      previous.onmessage = null;
      previous.onclose = null;
      previous.onerror = null;
      if (previous.readyState !== WebSocket.CLOSING) {
        previous.close();
      }
    }

    const ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.retryPaused = false;
      this.reconnectAttempts = 0;
      useServerStore.getState().setConnectionStatus(this.serverUrl, 'connected');
      ws.send(JSON.stringify({ type: 'subscribe:all' }));
      // Reconcile once over REST as well as the websocket replay. This covers
      // agents created just before a reconnect, where an incremental
      // session:added event may have been missed by the browser.
      void this.refreshSessionList();
      this.flushPendingSettings();
      // Heartbeat to keep connection alive in background tabs
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(ev.data) as WSMessage;
        this.handleMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      if (!this.shutdown && !this.disposed) {
        if (this.retryPaused) {
          // A remote server errored (often a transient blip or a momentarily
          // unreachable host). Surface the error and drop its now-stale
          // sessions, but schedule a backoff reconnect so it recovers on its
          // own instead of staying dead until a manual retry.
          useServerStore.getState().setConnectionStatus(this.serverUrl, 'error');
          if (!this.isLocal) {
            useSessionStore.getState().removeServerSessions(this.serverUrl);
          }
          this.reconnectTimer = setTimeout(() => {
            this.retryPaused = false;
            this.connect();
          }, this.nextReconnectDelay());
          return;
        }
        useServerStore.getState().setConnectionStatus(this.serverUrl, 'disconnected');
        this.reconnectTimer = setTimeout(() => this.connect(), this.nextReconnectDelay());
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      if (!this.isLocal) {
        this.retryPaused = true;
      }
      useServerStore.getState().setConnectionStatus(this.serverUrl, 'error');
      ws.close();
    };
  }

  private async refreshSessionList(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase()}/api/sessions`, { headers: this.authHeaders() });
      if (!res.ok) return;
      const sessions = (await res.json() as SessionSummary[]).map((session) => ({
        ...session,
        serverUrl: this.serverUrl,
      }));
      useSessionStore.getState().setServerSessions(this.serverUrl, sessions);
    } catch {
      // The websocket remains the live source; REST reconciliation is best effort.
    }
  }

  /**
   * Exponential backoff (1s → 30s cap) with ±20% jitter so a downed server
   * isn't hammered every 2s and many tabs don't reconnect in lockstep. Reset
   * to 0 on a successful open.
   */
  private nextReconnectDelay(): number {
    const base = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  /** Reconnect immediately if the WebSocket is not open (e.g. after returning from background tab) */
  reconnectIfNeeded(): void {
    if (this.disposed || this.shutdown) return;
    if (this.retryPaused) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.connect();
  }

  retry(): void {
    if (this.disposed) return;
    this.shutdown = false;
    this.retryPaused = false;
    this.reconnectAttempts = 0;
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

  send(msg: WSMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  sendAutoApprove(sessionId: string, value: boolean): void {
    this.sendSessionSettings(sessionId, { autoApprove: value });
  }

  sendSessionSettings(sessionId: string, patch: SessionSettingsPatch): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.queueSessionSettings(sessionId, patch);
      this.reconnectIfNeeded();
      return;
    }
    if (!this.sendSessionSettingsNow(sessionId, patch)) {
      this.queueSessionSettings(sessionId, patch);
      this.reconnectIfNeeded();
    }
  }

  sendAutoCompactMinutes(minutes: number): void {
    if (!this.send({ type: 'set:autoCompactMinutes', minutes })) {
      this.pendingAutoCompactMinutes = minutes;
      this.reconnectIfNeeded();
    }
  }

  sendSessionSeen(sessionId: string): void {
    if (this.send({ type: 'mark:seen', sessionId })) {
      this.pendingSeenSessions.delete(sessionId);
      return;
    }
    this.pendingSeenSessions.add(sessionId);
    this.reconnectIfNeeded();
  }

  private queueSessionSettings(sessionId: string, patch: SessionSettingsPatch): void {
    this.pendingSessionSettings.set(sessionId, {
      ...(this.pendingSessionSettings.get(sessionId) ?? {}),
      ...patch,
    });
  }

  private flushPendingSettings(): void {
    if (this.pendingAutoCompactMinutes !== null) {
      const minutes = this.pendingAutoCompactMinutes;
      this.pendingAutoCompactMinutes = null;
      if (!this.send({ type: 'set:autoCompactMinutes', minutes })) {
        this.pendingAutoCompactMinutes = minutes;
        return;
      }
    }

    const pending = [...this.pendingSessionSettings.entries()];
    this.pendingSessionSettings.clear();
    for (const [sessionId, patch] of pending) {
      if (!this.sendSessionSettingsNow(sessionId, patch)) {
        this.queueSessionSettings(sessionId, patch);
        return;
      }
    }

    const pendingSeen = [...this.pendingSeenSessions];
    for (const sessionId of pendingSeen) {
      if (!this.send({ type: 'mark:seen', sessionId })) return;
      this.pendingSeenSessions.delete(sessionId);
    }
  }

  private sendSessionSettingsNow(sessionId: string, patch: SessionSettingsPatch): boolean {
    if (patch.autoApprove !== undefined) {
      if (!this.send({ type: 'set:autoApprove', sessionId, value: patch.autoApprove })) return false;
    }
    if (patch.autoCompact !== undefined) {
      if (!this.send({ type: 'set:autoCompact', sessionId, value: patch.autoCompact })) return false;
    }
    if (
      patch.repeatEnabled !== undefined ||
      patch.repeatCommand !== undefined ||
      patch.repeatIntervalSeconds !== undefined ||
      patch.repeatClear !== undefined
    ) {
      if (!this.send({
        type: 'set:repeat',
        sessionId,
        enabled: patch.repeatEnabled,
        command: patch.repeatCommand,
        intervalSeconds: patch.repeatIntervalSeconds,
        clear: patch.repeatClear,
      })) return false;
    }
    if (patch.tags !== undefined) {
      if (!this.send({ type: 'set:tags', sessionId, tags: patch.tags })) return false;
    }
    return true;
  }

  async createSession(opts: {
    tool?: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
  }): Promise<CreatedSession> {
    try {
      const base = this.apiBase();
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Failed to create session (HTTP ${res.status})`);
      }
      return await res.json() as CreatedSession;
    } catch (err) {
      console.error('Failed to create session:', err);
      if (err instanceof Error) throw err;
      throw new Error(String(err));
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
          // Terminal raw streams use one WebSocket per tab. The dashboard
          // connection only tracks structured state.
        } else {
          store.addEvent(evt);
        }
        break;
      }
      case 'event:batch': {
        const sid = msg.sessionId as string;
        const all = msg.events as NormalizedEvent[];
        const structured = all.filter((evt) => evt.type !== 'raw:output');
        if (structured.length > 0) {
          store.addEventBatch(sid, structured);
        }
        break;
      }
    }
  }
}
