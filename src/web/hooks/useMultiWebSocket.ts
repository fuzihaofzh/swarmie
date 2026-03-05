import { useEffect, useRef, useCallback } from 'react';
import { ServerConnection, registerAutoApproveForConnections } from './useWebSocket';
import { useServerStore, LOCAL_SERVER } from './useServers';
import { useSessionStore, registerAutoApproveSend } from './useSessions';

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

    // Register auto-approve routing
    registerAutoApproveForConnections(getConnectionForSession);

    return () => {
      registerAutoApproveSend(null);
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
        const conn = new ServerConnection(server.url);
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

  return { sendInput, sendResize, sendRedraw, createSession, killSession, getConnection };
}
