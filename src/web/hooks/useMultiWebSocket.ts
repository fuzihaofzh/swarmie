import { useEffect, useRef, useCallback } from 'react';
import { ServerConnection } from './useWebSocket';
import { useServerStore, LOCAL_SERVER, type ConnectionStatus } from './useServers';
import { useSessionStore, registerAutoApproveSync, registerSessionSettingsSync, type SessionSettingsPatch } from './useSessions';
import { registerAutoCompactMinutesSync, useUIStore } from './useUI';

export function useMultiWebSocket() {
  const connectionsRef = useRef<Map<string, ServerConnection>>(new Map());
  const activeRawRef = useRef<{ sessionId: string; serverUrl: string } | null>(null);

  // Get the current list of remote servers from the store
  const servers = useServerStore((s) => s.servers);

  /** Find the ServerConnection that owns a given sessionId */
  const getConnectionForSession = useCallback((sessionId: string): ServerConnection | undefined => {
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    if (!session) return connectionsRef.current.get(LOCAL_SERVER);
    return connectionsRef.current.get(session.serverUrl) ?? connectionsRef.current.get(LOCAL_SERVER);
  }, []);

  // Connect local server on mount
  useEffect(() => {
    const local = new ServerConnection(LOCAL_SERVER);
    connectionsRef.current.set(LOCAL_SERVER, local);
    local.connect();

    // Register auto-approve sync to server
    registerAutoApproveSync((sessionId, value) => {
      getConnectionForSession(sessionId)?.sendAutoApprove(sessionId, value);
    });
    registerSessionSettingsSync((sessionId: string, patch: SessionSettingsPatch) => {
      const conn = getConnectionForSession(sessionId);
      if (patch.autoCompact !== undefined) {
        conn?.sendAutoCompactMinutes(useUIStore.getState().autoCompactMinutes);
      }
      conn?.sendSessionSettings(sessionId, patch);
    });
    registerAutoCompactMinutesSync((minutes: number) => {
      for (const conn of connectionsRef.current.values()) {
        conn.sendAutoCompactMinutes(minutes);
      }
    });

    // Reconnect all connections when page becomes visible again
    const onVisibility = () => {
      if (!document.hidden) {
        for (const conn of connectionsRef.current.values()) {
          conn.reconnectIfNeeded();
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      registerAutoApproveSync(null);
      registerSessionSettingsSync(null);
      registerAutoCompactMinutesSync(null);
      for (const conn of connectionsRef.current.values()) {
        conn.disconnect();
      }
      connectionsRef.current.clear();
    };
  }, [getConnectionForSession]);

  // Keep raw terminal streaming scoped to the active session. `subscribe:all`
  // carries structured dashboard updates only; raw bytes are expensive because
  // xterm parsing happens on the browser main thread. If a user visits a noisy
  // TUI tab once and then switches away, we must unsubscribe or the hidden
  // terminal can keep blocking input in other tabs.
  //
  // Lazily request per-session history when the user activates a session.
  // Subscribing to `subscribe:all` only enrols for live events; raw replay
  // is fetched on demand so we don't blast N×2MB across the WS on connect.
  // Also retried when the owning server reconnects (ws.onopen clears the
  // per-connection requestedReplay set), so the active session re-fetches.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const connectionStatus: Record<string, ConnectionStatus> = useServerStore((s) => s.connectionStatus);
  useEffect(() => {
    const previous = activeRawRef.current;
    const activeSession = activeSessionId
      ? useSessionStore.getState().sessions.find((s) => s.id === activeSessionId)
      : undefined;
    const nextServerUrl = activeSession?.serverUrl ?? LOCAL_SERVER;

    if (previous && previous.sessionId !== activeSessionId) {
      connectionsRef.current.get(previous.serverUrl)?.setActiveRawSession(null);
      activeRawRef.current = null;
    }

    if (!activeSessionId) return;
    getConnectionForSession(activeSessionId)?.setActiveRawSession(activeSessionId);
    activeRawRef.current = { sessionId: activeSessionId, serverUrl: nextServerUrl };
  }, [activeSessionId, connectionStatus, getConnectionForSession]);

  // Sync remote server connections when server list changes
  useEffect(() => {
    const conns = connectionsRef.current;
    const desiredUrls = new Set(servers.map((s) => s.url));

    // Add new servers
    for (const server of servers) {
      if (!conns.has(server.url)) {
        const conn = new ServerConnection(server.url, server.token);
        conns.set(server.url, conn);
        conn.connect();
      }
    }

    // Remove servers no longer in the list
    for (const [url, conn] of conns) {
      if (url !== LOCAL_SERVER && !desiredUrls.has(url)) {
        conn.disconnect();
        conns.delete(url);
        useSessionStore.getState().removeServerSessions(url);
      }
    }
  }, [servers]);

  const sendInput = useCallback((sessionId: string, data: string) => {
    getConnectionForSession(sessionId)?.sendInput(sessionId, data);
  }, [getConnectionForSession]);

  const sendResize = useCallback((sessionId: string, cols: number, rows: number) => {
    getConnectionForSession(sessionId)?.sendResize(sessionId, cols, rows);
  }, [getConnectionForSession]);

  const sendRedraw = useCallback((sessionId: string) => {
    getConnectionForSession(sessionId)?.sendRedraw(sessionId);
  }, [getConnectionForSession]);

  const sendLoadHistory = useCallback((sessionId: string, fromOffset: number) => {
    getConnectionForSession(sessionId)?.sendLoadHistory(sessionId, fromOffset);
  }, [getConnectionForSession]);

  const createSession = useCallback(async (opts: {
    tool?: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
    serverUrl?: string;
  }): Promise<{ id: string; name: string; tool: string; status: string } | null> => {
    const targetUrl = opts.serverUrl ?? LOCAL_SERVER;
    const conn = connectionsRef.current.get(targetUrl);
    if (!conn) {
      console.error(`No connection found for server: "${targetUrl}". Available:`, [...connectionsRef.current.keys()]);
      return null;
    }
    return conn.createSession(opts);
  }, []);

  const killSession = useCallback(async (sessionId: string) => {
    const conn = getConnectionForSession(sessionId);
    if (conn) await conn.killSession(sessionId);
  }, [getConnectionForSession]);

  const getConnection = useCallback((serverUrl: string): ServerConnection | undefined => {
    return connectionsRef.current.get(serverUrl);
  }, []);

  return { sendInput, sendResize, sendRedraw, sendLoadHistory, createSession, killSession, getConnection };
}
