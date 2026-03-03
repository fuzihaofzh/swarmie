import { useSessionStore } from '../hooks/useSessions';
import { SessionCard } from './SessionCard';

export function SessionList() {
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();

  if (sessions.length === 0) {
    return <div className="empty-sessions">No active sessions</div>;
  }

  return (
    <div>
      {sessions.map((session) => (
        <SessionCard
          key={session.id}
          session={session}
          isActive={session.id === activeSessionId}
          onClick={() => setActiveSession(session.id)}
        />
      ))}
    </div>
  );
}
