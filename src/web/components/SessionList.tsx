import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useServerStore } from '../hooks/useServers';
import { useWsContext } from '../contexts/WsContext';
import { SessionCard } from './SessionCard';

export function SessionList() {
  const { sessions, archivedSessionIds, activeSessionId, setActiveSession } = useSessionStore();
  const setShowNewSession = useUIStore((s) => s.setShowNewSession);
  const servers = useServerStore((s) => s.servers);
  const { createSession } = useWsContext();

  const handleNewSession = async () => {
    if (servers.length > 0) {
      setShowNewSession(true);
      return;
    }
    // Single server — create directly
    const result = await createSession({});
    if (result) {
      useSessionStore.getState().setActiveSession(result.id);
    }
  };

  const archived = new Set(archivedSessionIds);
  const workspaceSessions = sessions.filter((session) => !archived.has(session.id));

  return (
    <div>
      <button
        className="new-session-btn"
        onClick={handleNewSession}
      >
        + New Session
      </button>
      {workspaceSessions.length === 0 && (
        <div className="empty-sessions">No active sessions</div>
      )}
      {workspaceSessions.map((session) => (
        <SessionCard
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onClick={() => {
            setActiveSession(session.id);
            setShowNewSession(false);
          }}
        />
      ))}
    </div>
  );
}
