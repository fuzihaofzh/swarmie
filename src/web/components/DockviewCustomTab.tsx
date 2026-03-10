import { useState, useEffect, useRef } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useSessionStore } from '../hooks/useSessions';
import { useServerStore } from '../hooks/useServers';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';

const NEW_SESSION_PANEL_ID = '__new_session__';

function shortPath(p: string): string {
  // macOS: /Users/name/... → ~/...
  // Linux: /home/name/... → ~/...
  for (const prefix of ['/Users/', '/home/']) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) return '~';
      return '~' + rest.slice(slashIdx);
    }
  }
  return p;
}

function ToggleSwitch({ active }: { active: boolean }) {
  return (
    <span
      className={`dv-tab-toggle ${active ? 'on' : ''}`}
      aria-checked={active}
      role="switch"
    >
      <span className="dv-tab-toggle-knob" />
    </span>
  );
}

export function DockviewCustomTab({ api, params }: IDockviewPanelHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);
  const sessionId = (params as { sessionId?: string }).sessionId;
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));

  // Scroll active tab into view
  useEffect(() => {
    const disposable = api.onDidActiveChange((e) => {
      if (e.isActive) {
        tabRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    });
    return () => disposable.dispose();
  }, [api]);
  const setSessionAutoApprove = useSessionStore((s) => s.setSessionAutoApprove);
  const servers = useServerStore((s) => s.servers);
  const { killSession } = useWsContext();

  if (!session) return null;

  const active = !!session.autoApprove;
  const isRemote = !!session.serverUrl;
  // Extract short hostname from server URL (e.g. "http://seis10:3200" → "seis10")
  const remoteHost = isRemote
    ? (() => {
        try {
          const h = new URL(session.serverUrl).hostname;
          return h;
        } catch {
          return session.serverUrl;
        }
      })()
    : null;
  // If SSH detected via OSC sequences, show the SSH hostname
  const sshHost = !isRemote && session.hostname && session.hostname !== session.initialHostname
    ? session.hostname
    : null;
  const displayHost = remoteHost || sshHost;

  const handleShieldClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSessionAutoApprove(session.id, !active);
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await killSession(session.id);
  };

  return (
    <div
      ref={tabRef}
      className="dv-custom-tab"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => api.setActive()}
    >
      <ToolIcon tool={session.tool} status={session.status} />
      <span className="dv-tab-name">
        {displayHost ? `${displayHost}:${shortPath(session.cwd)}` : shortPath(session.cwd)}
      </span>
      <span
        className={`dv-tab-shield ${active || hovered ? 'visible' : ''}`}
        onClick={handleShieldClick}
        title={`Auto-approve: ${active ? 'on' : 'off'}`}
      >
        <ToggleSwitch active={active} />
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
