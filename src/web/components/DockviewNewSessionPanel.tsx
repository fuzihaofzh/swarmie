import { useEffect, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { NewSessionPage } from './NewSessionPage';
import { useWsContext } from '../contexts/WsContext';
import { useSessionStore } from '../hooks/useSessions';
import { useServerStore } from '../hooks/useServers';
import { useUIStore } from '../hooks/useUI';
import { sessionMatchesTagFilter } from '../tagFilter';

export function DockviewNewSessionPanel({ api }: IDockviewPanelProps) {
  const { createSession } = useWsContext();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tagFilter = useUIStore((s) => s.tagFilter);
  const servers = useServerStore((s) => s.servers);
  const autoCreated = useRef(false);
  const activeSession = sessions.find((session) => session.id === activeSessionId)
    ?? sessions.find((session) => sessionMatchesTagFilter(session, tagFilter, sessions));
  const initialCwd = activeSession?.cwd ?? activeSession?.workspaceCwd;

  // Single server — auto-create session immediately
  useEffect(() => {
    if (servers.length > 0 || autoCreated.current) return;
    autoCreated.current = true;
    createSession(initialCwd ? { cwd: initialCwd } : {}).then((result) => {
      if (result) {
        useSessionStore.getState().setActiveSession(result.id);
        try { api.close(); } catch { /* already closed */ }
      }
    });
  }, [servers.length, createSession, api, initialCwd]);

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
      initialCwd={initialCwd}
    />
  );
}
