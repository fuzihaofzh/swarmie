import { useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useSessionStore } from '../hooks/useSessions';
import { ToolIcon } from './ToolIcon';

const NEW_SESSION_PANEL_ID = '__new_session__';

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

function ShieldIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ color: active ? '#3fb950' : 'currentColor', flexShrink: 0 }}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      {active && <polyline points="9 12 11 14 15 10" />}
    </svg>
  );
}

export function DockviewCustomTab({ api, params }: IDockviewPanelHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const sessionId = (params as { sessionId?: string }).sessionId;
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const setSessionAutoApprove = useSessionStore((s) => s.setSessionAutoApprove);

  if (!session) return null;

  const active = !!session.autoApprove;

  const handleShieldClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSessionAutoApprove(session.id, !active);
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/sessions/${session.id}/kill`, { method: 'POST' });
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="dv-custom-tab"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => api.setActive()}
    >
      <ToolIcon tool={session.tool} status={session.status} />
      <span className="dv-tab-name">{session.displayName}</span>
      <span className="dv-tab-cwd">{shortPath(session.cwd)}</span>
      <span
        className={`dv-tab-shield ${active || hovered ? 'visible' : ''}`}
        onClick={handleShieldClick}
        title={`Auto-approve: ${active ? 'on' : 'off'}`}
      >
        <ShieldIcon active={active} />
      </span>
      <span
        className={`dv-tab-close ${hovered ? 'visible' : ''}`}
        onClick={handleClose}
      >
        &times;
      </span>
    </div>
  );
}

export function DockviewNewSessionTab({ api }: IDockviewPanelHeaderProps) {
  return (
    <div
      className="dv-custom-tab dv-new-session-tab"
      onClick={() => api.setActive()}
    >
      <span style={{ fontSize: 16, fontWeight: 'bold' }}>+</span>
      <span className="dv-tab-name">New Session</span>
    </div>
  );
}

export { NEW_SESSION_PANEL_ID };
