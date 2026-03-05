import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { NewSessionPage } from './NewSessionPage';
import { useWsContext } from '../contexts/WsContext';
import { useSessionStore } from '../hooks/useSessions';
import { useServerStore } from '../hooks/useServers';

export function DockviewNewSessionPanel({ api }: IDockviewPanelProps) {
  const { createSession } = useWsContext();
  const sessions = useSessionStore((s) => s.sessions);
  const servers = useServerStore((s) => s.servers);
  const autoCreated = useRef(false);

  // Single server — auto-create session immediately
  useEffect(() => {
    if (servers.length > 0 || autoCreated.current) return;
    autoCreated.current = true;
    createSession({}).then((result) => {
      if (result) {
        useSessionStore.getState().setActiveSession(result.id);
        try { api.close(); } catch { /* already closed */ }
      }
    });
  }, [servers.length, createSession, api]);

  // Multi-server — show server picker
  if (servers.length === 0) return null;

  return (
    <NewSessionPage
      onCreateSession={async (opts) => {
        const result = await createSession(opts);
        if (result) {
          useSessionStore.getState().setActiveSession(result.id);
          try { api.close(); } catch { /* already closed */ }
        }
        return result;
      }}
      onCancel={sessions.length > 0 ? () => api.close() : undefined}
    />
  );
}
