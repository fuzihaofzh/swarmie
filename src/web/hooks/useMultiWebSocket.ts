import { useEffect, useRef, useCallback } from 'react';
import { ServerConnection } from './useWebSocket';
import { useServerStore, LOCAL_SERVER } from './useServers';
import { useSessionStore, registerAutoApproveSync, registerSessionSettingsSync, type SessionSettingsPatch } from './useSessions';
import { registerAutoCompactMinutesSync, useUIStore } from './useUI';

export function useMultiWebSocket() {
  const connectionsRef = useRef<Map<string, ServerConnection>>(new Map());

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

    let lastSeenKey = '';
    const markActiveSeen = (force = false) => {
      if (document.hidden) return;
      const state = useSessionStore.getState();
      const session = state.sessions.find((item) => item.id === state.activeSessionId);
      if (!session || session.seen !== false) return;
      const key = `${session.id}:${session.status}:${session.stateChangeSeq ?? 0}`;
      if (!force && key === lastSeenKey) return;
      lastSeenKey = key;
      getConnectionForSession(session.id)?.sendSessionSeen(session.id);
    };
    const unsubscribeSessions = useSessionStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId || state.sessions !== previous.sessions) {
        markActiveSeen();
      }
    });
    markActiveSeen();

    // Reconnect all connections when page becomes visible again
    const onVisibility = () => {
      if (!document.hidden) {
        for (const conn of connectionsRef.current.values()) {
          conn.reconnectIfNeeded();
        }
        lastSeenKey = '';
        markActiveSeen(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeSessions();
      registerAutoApproveSync(null);
      registerSessionSettingsSync(null);
      registerAutoCompactMinutesSync(null);
      for (const conn of connectionsRef.current.values()) {
        conn.disconnect();
      }
      connectionsRef.current.clear();
    };
  }, [getConnectionForSession]);

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

  return { createSession, killSession, getConnection };
}
