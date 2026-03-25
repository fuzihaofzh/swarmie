import { useSessionStore, type SessionSummary, type NormalizedEvent } from './useSessions';
import { writeToTerminal, clearTerminalBuffer } from '../terminalBus';
import { useServerStore, LOCAL_SERVER } from './useServers';

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

  constructor(serverUrl: string, token?: string) {
    this.serverUrl = serverUrl;
    this.token = token;
  }

  /** Whether this connection targets the local (same-origin) server */
  get isLocal(): boolean {
    return this.serverUrl === LOCAL_SERVER;
  }

  connect(): void {
    if (this.disposed || this.shutdown) return;

    useServerStore.getState().setConnectionStatus(this.serverUrl, 'connecting');

    let wsUrl = this.isLocal
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
      : `${this.serverUrl.replace(/^http/, 'ws')}/ws`;
    const protocols = this.token && !this.isLocal ? [`swarmie-token.${this.token}`] : undefined;
    const ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      useServerStore.getState().setConnectionStatus(this.serverUrl, 'connected');
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
        useServerStore.getState().setConnectionStatus(this.serverUrl, 'disconnected');
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };

    ws.onerror = () => {
      useServerStore.getState().setConnectionStatus(this.serverUrl, 'error');
      ws.close();
    };
  }

  /** Reconnect immediately if the WebSocket is not open (e.g. after returning from background tab) */
  reconnectIfNeeded(): void {
    if (this.disposed || this.shutdown) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    clearTimeout(this.reconnectTimer);
    this.connect();
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

  sendAutoApprove(sessionId: string, value: boolean): void {
    this.send({ type: 'set:autoApprove', sessionId, value });
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
        break;
      }
      case 'session:added': {
        const session = { ...(msg.session as SessionSummary), serverUrl };
        store.addSession(session);
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
          const b64 = (evt.data as { data: string }).data;
          writeToTerminal(evt.sessionId, b64);
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
        for (const evt of all) {
          if (evt.type === 'raw:output') {
            rawChunks.push((evt.data as { data: string }).data);
          } else {
            structured.push(evt);
          }
        }
        if (rawChunks.length > 0) {
          const parts: Uint8Array[] = [];
          let totalLen = 0;
          for (const b64 of rawChunks) {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            parts.push(bytes);
            totalLen += bytes.length;
          }
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const p of parts) {
            merged.set(p, offset);
            offset += p.length;
          }
          let bin = '';
          for (let i = 0; i < merged.length; i++) bin += String.fromCharCode(merged[i]);
          writeToTerminal(sid, btoa(bin));
        }
        if (structured.length > 0) {
          store.addEventBatch(sid, structured);
        }
        break;
      }
    }
  }
}
