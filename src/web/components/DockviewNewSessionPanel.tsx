import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { NewSessionPage } from './NewSessionPage';
import { useWsContext } from '../contexts/WsContext';
import { useSessionStore } from '../hooks/useSessions';
import { useServerStore } from '../hooks/useServers';
import { useUIStore } from '../hooks/useUI';
import { sessionMatchesTagFilter } from '../tagFilter';
import { sessionHostLabel } from '../serverHost';

export function DockviewNewSessionPanel({ api }: IDockviewPanelProps) {
  const { createSession } = useWsContext();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tagFilter = useUIStore((s) => s.tagFilter);
  const servers = useServerStore((s) => s.servers);
  const autoCreated = useRef(false);
  const [autoCreateError, setAutoCreateError] = useState('');
  const activeSession = sessions.find((session) => session.id === activeSessionId)
    ?? sessions.find((session) => sessionMatchesTagFilter(session, tagFilter, sessions));
  const initialServerUrl = activeSession?.serverUrl || '';
  // A local PTY may currently be inside SSH. Its cwd belongs to the SSH host,
  // not to the local coordinator, so it cannot be used as node-pty's cwd for a
  // sibling session. A genuine remote Swarmie session is safe because the POST
  // can be sent back to its owning serverUrl.
  const nestedRemoteHost = !initialServerUrl && activeSession
    ? sessionHostLabel(activeSession, sessions)
    : null;
  const initialCwd = nestedRemoteHost
    ? undefined
    : activeSession?.cwd ?? activeSession?.workspaceCwd;

  // Single server — auto-create session immediately
  useEffect(() => {
    if (servers.length > 0 || nestedRemoteHost || autoCreated.current) return;
    autoCreated.current = true;
    void createSession(initialCwd ? { cwd: initialCwd } : {})
      .then((result) => {
        useSessionStore.getState().setActiveSession(result.id);
        useUIStore.getState().setShowNewSession(false);
        try { api.close(); } catch { /* already closed */ }
      })
      .catch((error: unknown) => {
        setAutoCreateError(error instanceof Error ? error.message : String(error));
      });
  }, [servers.length, createSession, api, initialCwd, nestedRemoteHost]);

  // The local single-server path creates immediately. Stay blank only while
  // that first request is in flight; on failure render the form + exact error
  // so the tab remains useful and the user can retry.
  if (servers.length === 0 && !nestedRemoteHost && !autoCreateError) return null;

  return (
    <NewSessionPage
      onCreateSession={async (opts) => {
        const result = await createSession(opts);
        useSessionStore.getState().setActiveSession(result.id);
        useUIStore.getState().setShowNewSession(false);
        try { api.close(); } catch { /* already closed */ }
        return result;
      }}
      onCancel={sessions.length > 0 ? () => api.close() : undefined}
      initialCwd={initialCwd}
      initialServerUrl={initialServerUrl}
      initialError={autoCreateError}
    />
  );
}
