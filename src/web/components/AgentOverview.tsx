import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSessionStore, type SessionSummary } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';

type AgentView = 'attention' | 'active' | 'archived';

const BUSY_STATUSES = new Set(['starting', 'running', 'thinking', 'tool_executing']);
const DONE_STATUSES = new Set(['completed', 'error']);

function shortPath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}

function basename(path: string): string {
  const cleaned = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
  return cleaned.split('/').pop() || cleaned || '~';
}

function hostLabel(session: SessionSummary): string {
  if (session.serverUrl) {
    try {
      return new URL(session.serverUrl).hostname;
    } catch {
      return session.serverUrl;
    }
  }
  if (session.hostname && session.hostname !== session.initialHostname) return session.hostname;
  return session.initialHostname || session.hostname || 'local';
}

function statusLabel(status: string): string {
  switch (status) {
    case 'waiting_input': return 'waiting';
    case 'tool_executing': return 'tool';
    default: return status;
  }
}

function attentionRank(session: SessionSummary): number {
  if (session.status === 'waiting_input') return 0;
  if (session.status === 'error') return 1;
  if (session.status === 'completed') return 2;
  if (BUSY_STATUSES.has(session.status)) return 3;
  return 4;
}

function isAttention(session: SessionSummary): boolean {
  return session.status === 'waiting_input' || session.status === 'error' || session.status === 'completed';
}

function isArchivable(session: SessionSummary): boolean {
  return DONE_STATUSES.has(session.status);
}

function matchesQuery(session: SessionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    session.name,
    session.tool,
    session.displayName,
    session.status,
    session.cwd,
    hostLabel(session),
    session.serverUrl,
    ...(session.tags ?? []),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function lastActivityAt(session: SessionSummary, events: ReturnType<typeof useSessionStore.getState>['events']): number {
  const lastEvent = events[session.id]?.at(-1)?.timestamp ?? 0;
  return Math.max(session.endTime ?? 0, lastEvent, session.startTime);
}

function formatAge(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function AgentOverview() {
  const mode = useUIStore((s) => s.agentOverlayMode);
  const closeAgentOverlay = useUIStore((s) => s.closeAgentOverlay);
  const setShowNewSession = useUIStore((s) => s.setShowNewSession);
  const sessions = useSessionStore((s) => s.sessions);
  const events = useSessionStore((s) => s.events);
  const archivedSessionIds = useSessionStore((s) => s.archivedSessionIds);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const archiveSessions = useSessionStore((s) => s.archiveSessions);
  const unarchiveSessions = useSessionStore((s) => s.unarchiveSessions);
  const archiveCompletedSessions = useSessionStore((s) => s.archiveCompletedSessions);
  const setSessionAutoApprove = useSessionStore((s) => s.setSessionAutoApprove);
  const setSessionAutoCompact = useSessionStore((s) => s.setSessionAutoCompact);
  const { killSession } = useWsContext();

  const [view, setView] = useState<AgentView>('attention');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const searchRef = useRef<HTMLInputElement | null>(null);

  const archived = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds]);
  const activeSessions = useMemo(() => sessions.filter((s) => !archived.has(s.id)), [archived, sessions]);
  const archivedSessions = useMemo(() => sessions.filter((s) => archived.has(s.id)), [archived, sessions]);
  const attentionSessions = useMemo(
    () => activeSessions.filter(isAttention).sort((a, b) => attentionRank(a) - attentionRank(b)),
    [activeSessions],
  );

  const stats = useMemo(() => ({
    waiting: activeSessions.filter((s) => s.status === 'waiting_input').length,
    busy: activeSessions.filter((s) => BUSY_STATUSES.has(s.status)).length,
    idle: activeSessions.filter((s) => s.status === 'idle').length,
    done: activeSessions.filter((s) => DONE_STATUSES.has(s.status)).length,
  }), [activeSessions]);

  const rows = useMemo(() => {
    const source = mode === 'switcher'
      ? activeSessions
      : view === 'archived'
        ? archivedSessions
        : view === 'attention'
          ? attentionSessions
          : activeSessions;
    return source
      .filter((session) => matchesQuery(session, query))
      .sort((a, b) => {
        const rank = attentionRank(a) - attentionRank(b);
        if (rank !== 0) return rank;
        return lastActivityAt(b, events) - lastActivityAt(a, events);
      });
  }, [activeSessions, archivedSessions, attentionSessions, events, mode, query, view]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedSessions = useMemo(
    () => sessions.filter((session) => selectedSet.has(session.id)),
    [selectedSet, sessions],
  );
  const selectedArchivableIds = selectedSessions.filter(isArchivable).map((s) => s.id);
  const selectedArchivedIds = selectedSessions.filter((s) => archived.has(s.id)).map((s) => s.id);

  useEffect(() => {
    if (!mode) return;
    setQuery('');
    setSelectedIds([]);
    setHighlightedIndex(0);
    if (mode === 'switcher') setView('active');
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [mode]);

  useEffect(() => {
    if (!mode) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (highlightedIndex >= rows.length) {
      setHighlightedIndex(Math.max(0, rows.length - 1));
    }
  }, [highlightedIndex, rows.length]);

  if (!mode) return null;

  const switcherMode = mode === 'switcher';

  const openSession = (sessionId: string) => {
    if (archived.has(sessionId)) unarchiveSessions([sessionId]);
    setActiveSession(sessionId);
    setShowNewSession(false);
    closeAgentOverlay();
  };

  const toggleSelected = (sessionId: string) => {
    setSelectedIds((current) =>
      current.includes(sessionId)
        ? current.filter((id) => id !== sessionId)
        : [...current, sessionId],
    );
  };

  const handleListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAgentOverlay();
      return;
    }
    if (!switcherMode) return;
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((idx) => Math.min(rows.length - 1, idx + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((idx) => Math.max(0, idx - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = rows[highlightedIndex];
      if (target) openSession(target.id);
    }
  };

  const selectAllRows = () => {
    const rowIds = rows.map((session) => session.id);
    const allSelected = rowIds.length > 0 && rowIds.every((id) => selectedSet.has(id));
    setSelectedIds(allSelected ? [] : rowIds);
  };

  const archiveSelected = () => {
    archiveSessions(selectedArchivableIds);
    setSelectedIds((current) => current.filter((id) => !selectedArchivableIds.includes(id)));
  };

  const archiveAllFinished = () => {
    archiveCompletedSessions();
    setSelectedIds([]);
  };

  const killSelected = () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`Kill ${selectedIds.length} selected agent${selectedIds.length === 1 ? '' : 's'}?`)) return;
    selectedIds.forEach((id) => void killSession(id));
  };

  return (
    <div className="agent-overlay" onClick={closeAgentOverlay}>
      <div
        className={`agent-panel ${switcherMode ? 'agent-panel-compact' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleListKeyDown}
      >
        <div className="agent-panel-header">
          <div>
            <h2>{switcherMode ? 'Switch Agent' : 'Agents'}</h2>
            {!switcherMode && (
              <div className="agent-panel-subtitle">
                <span>{activeSessions.length} active</span>
                <span>{archivedSessions.length} archived</span>
              </div>
            )}
          </div>
          <button className="agent-panel-close" onClick={closeAgentOverlay}>&times;</button>
        </div>

        {!switcherMode && (
          <div className="agent-stats">
            <button className="agent-stat waiting" onClick={() => setView('attention')}>
              <span>{stats.waiting}</span>
              <label>waiting</label>
            </button>
            <button className="agent-stat busy" onClick={() => setView('active')}>
              <span>{stats.busy}</span>
              <label>busy</label>
            </button>
            <button className="agent-stat idle" onClick={() => setView('active')}>
              <span>{stats.idle}</span>
              <label>idle</label>
            </button>
            <button className="agent-stat done" onClick={() => setView('active')}>
              <span>{stats.done}</span>
              <label>done</label>
            </button>
          </div>
        )}

        <div className="agent-toolbar">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlightedIndex(0);
            }}
            placeholder="Search agents"
          />
          {!switcherMode && (
            <div className="agent-view-tabs">
              <button className={view === 'attention' ? 'active' : ''} onClick={() => setView('attention')}>
                Attention <span>{attentionSessions.length}</span>
              </button>
              <button className={view === 'active' ? 'active' : ''} onClick={() => setView('active')}>
                Active <span>{activeSessions.length}</span>
              </button>
              <button className={view === 'archived' ? 'active' : ''} onClick={() => setView('archived')}>
                Archived <span>{archivedSessions.length}</span>
              </button>
            </div>
          )}
        </div>

        {!switcherMode && (
          <div className="agent-bulkbar">
            <button onClick={selectAllRows}>{selectedIds.length > 0 ? 'Clear' : 'Select all'}</button>
            <button onClick={() => selectedIds.forEach((id) => setSessionAutoApprove(id, true))} disabled={selectedIds.length === 0}>
              Auto yes on
            </button>
            <button onClick={() => selectedIds.forEach((id) => setSessionAutoApprove(id, false))} disabled={selectedIds.length === 0}>
              Auto yes off
            </button>
            <button onClick={() => selectedIds.forEach((id) => setSessionAutoCompact(id, true))} disabled={selectedIds.length === 0}>
              Compact on
            </button>
            <button onClick={() => selectedIds.forEach((id) => setSessionAutoCompact(id, false))} disabled={selectedIds.length === 0}>
              Compact off
            </button>
            <button onClick={archiveSelected} disabled={selectedArchivableIds.length === 0}>
              Archive finished
            </button>
            <button onClick={() => unarchiveSessions(selectedArchivedIds)} disabled={selectedArchivedIds.length === 0}>
              Restore
            </button>
            <button onClick={archiveAllFinished} disabled={stats.done === 0}>
              Archive all finished
            </button>
            <button className="danger" onClick={killSelected} disabled={selectedIds.length === 0}>
              Kill
            </button>
          </div>
        )}

        <div className="agent-list">
          {rows.length === 0 && (
            <div className="agent-empty">{query ? 'No matching agents' : 'No agents'}</div>
          )}
          {rows.map((session, index) => {
            const selected = selectedSet.has(session.id);
            const rowArchived = archived.has(session.id);
            return (
              <div
                key={session.id}
                className={`agent-row ${selected ? 'selected' : ''} ${switcherMode && index === highlightedIndex ? 'highlighted' : ''}`}
                onClick={() => (switcherMode ? openSession(session.id) : toggleSelected(session.id))}
              >
                {!switcherMode && (
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelected(session.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
                <ToolIcon tool={session.tool} status={session.status} />
                <div className="agent-row-main" onDoubleClick={() => openSession(session.id)}>
                  <div className="agent-row-title">
                    <span>{session.name || basename(session.cwd)}</span>
                    <span className={`agent-status-chip status-${session.status}`}>{statusLabel(session.status)}</span>
                  </div>
                  <div className="agent-row-meta">
                    <span>{hostLabel(session)}</span>
                    <span>{shortPath(session.cwd)}</span>
                    <span>{formatAge(lastActivityAt(session, events), now)} ago</span>
                  </div>
                </div>
                <div className="agent-row-tags">
                  {(session.tags ?? []).slice(0, 3).map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <div className="agent-row-flags">
                  {session.autoApprove && <span>yes</span>}
                  {session.autoCompact && <span>compact</span>}
                  {session.repeatEnabled && <span>repeat</span>}
                </div>
                {!switcherMode && (
                  <div className="agent-row-actions">
                    <button onClick={(e) => { e.stopPropagation(); openSession(session.id); }}>
                      Open
                    </button>
                    {rowArchived ? (
                      <button onClick={(e) => { e.stopPropagation(); unarchiveSessions([session.id]); }}>
                        Restore
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); archiveSessions([session.id]); }}
                        disabled={!isArchivable(session)}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
