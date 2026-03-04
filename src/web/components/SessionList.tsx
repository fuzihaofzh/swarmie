import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { SessionCard } from './SessionCard';

export function SessionList() {
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();
  const setShowNewSession = useUIStore((s) => s.setShowNewSession);

  return (
    <div>
      <button
        className="new-session-btn"
        onClick={() => setShowNewSession(true)}
      >
        + New Session
      </button>
      {sessions.length === 0 && (
        <div className="empty-sessions">No active sessions</div>
      )}
      {sessions.map((session) => (
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
