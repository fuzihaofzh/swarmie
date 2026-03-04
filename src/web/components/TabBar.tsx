import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { StatusIndicator } from './StatusIndicator';
import { ToolIcon } from './ToolIcon';

function shortPath(p: string): string {
  const home = '/Users/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return '~';
    return '~' + rest.slice(slashIdx);
  }
  return p;
}

export function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const toggleDrawer = useUIStore((s) => s.toggleDrawer);
  const showNewSession = useUIStore((s) => s.showNewSession);
  const setShowNewSession = useUIStore((s) => s.setShowNewSession);

  const handleClose = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await fetch(`/api/sessions/${sessionId}/kill`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  return (
    <div className="tab-bar">
      <button className="menu-btn" onClick={toggleDrawer}>
        <span />
        <span />
        <span />
      </button>

      <div className="tab-list">
        {sessions.map((s) => {
          const isActive = s.id === activeSessionId && !showNewSession;
          return (
            <button
              key={s.id}
              className={`tab ${isActive ? 'active' : ''}`}
              onClick={() => {
                setActiveSession(s.id);
                setShowNewSession(false);
              }}
            >
              <ToolIcon tool={s.tool} status={s.status} />
              <span className="tab-name">{s.displayName}</span>
              <span className="tab-cwd">{shortPath(s.cwd)}</span>
              <span
                className="tab-close"
                onClick={(e) => handleClose(e, s.id)}
              >
                &times;
              </span>
            </button>
          );
        })}
      </div>

      <button
        className={`tab-new-btn ${showNewSession || sessions.length === 0 ? 'active' : ''}`}
        onClick={() => setShowNewSession(true)}
        title="New Session"
      >
        +
      </button>
    </div>
  );
}
