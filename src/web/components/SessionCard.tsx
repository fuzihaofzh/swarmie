import { useEffect, useState } from 'react';
import type { SessionSummary } from '../hooks/useSessions';

interface SessionCardProps {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}

const SPINNER_CHARS = ['✻', '✳', '✺', '✹', '✷', '✶'];

function Spinner() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % SPINNER_CHARS.length), 150);
    return () => clearInterval(id);
  }, []);
  return <span className="status-spinner">{SPINNER_CHARS[idx]}</span>;
}

function StatusIndicator({ status }: { status: string }) {
  if (status === 'waiting_input') {
    return <span className="status-bell">&#x1F514;</span>;
  }
  if (status === 'running' || status === 'thinking' || status === 'tool_executing') {
    return <Spinner />;
  }
  return <span className={`status-dot ${status}`} />;
}

export function SessionCard({ session, isActive, onClick }: SessionCardProps) {
  const elapsed = session.endTime
    ? formatDuration(session.endTime - session.startTime)
    : formatDuration(Date.now() - session.startTime);

  return (
    <div
      className={`session-item ${isActive ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="session-main">
        <div className="session-item-name">
          <StatusIndicator status={session.status} />
          <span className="name-text">{session.displayName}@{session.hostname}</span>
        </div>
        <div className="session-item-info">
          {shortPath(session.cwd)} &middot; {elapsed}
        </div>
      </div>
    </div>
  );
}

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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
