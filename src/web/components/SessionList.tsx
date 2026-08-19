import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { SessionCard } from './SessionCard';

export function SessionList() {
  const { sessions, archivedSessionIds, activeSessionId, setActiveSession } = useSessionStore();
  const setShowNewSession = useUIStore((s) => s.setShowNewSession);

  const handleNewSession = () => setShowNewSession(true);

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
          allSessions={sessions}
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
