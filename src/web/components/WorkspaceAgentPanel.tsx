import { useEffect, useMemo, useState } from 'react';
import { useSessionStore, type SessionSummary } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';
import { sessionHostLabel } from '../serverHost';

const BUSY = new Set(['starting', 'running', 'thinking', 'tool_executing']);

function statusClass(status: string): string {
  if (status === 'waiting_input' || status === 'blocked') return 'blocked';
  if (status === 'done' || status === 'completed') return 'done';
  if (status === 'error') return 'error';
  if (BUSY.has(status)) return 'working';
  return 'idle';
}

function statusLabel(status: string): string {
  if (status === 'waiting_input') return 'waiting';
  if (status === 'tool_executing') return 'tool';
  return status;
}

function workspaceName(tag: string): string {
  return tag.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function workspaceKey(session: SessionSummary): string | null {
  const cwd = (session.workspaceCwd ?? session.cwd)?.trim();
  return cwd && cwd !== '~' ? `cwd:${cwd}` : (session.tags?.[0] ?? null);
}

function workspaceLabel(key: string): string {
  if (key.startsWith('cwd:')) {
    const path = key.slice(4).replace(/\/$/, '');
    return path.split('/').pop() || path || 'Workspace';
  }
  return workspaceName(key);
}

function agentMatches(session: SessionSummary, query: string): boolean {
  const value = query.trim().toLocaleLowerCase();
  if (!value) return true;
  return [session.displayName, session.name, session.tool, session.cwd, session.status, ...(session.tags ?? [])]
    .some((part) => part.toLocaleLowerCase().includes(value));
}

function elapsedLabel(startTime: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function WorkspaceAgentPanel() {
  const sessions = useSessionStore((state) => state.sessions);
  const archivedIds = useSessionStore((state) => state.archivedSessionIds);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const setShowNewSession = useUIStore((state) => state.setShowNewSession);
  const tagFilter = useUIStore((state) => state.tagFilter);
  const setTagFilter = useUIStore((state) => state.setTagFilter);
  const workspacePanelWidth = useUIStore((state) => state.workspacePanelWidth);
  const setWorkspacePanelWidth = useUIStore((state) => state.setWorkspacePanelWidth);
  const { createSession, getConnection } = useWsContext();
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [sortMode, setSortMode] = useState<'attention' | 'recent' | 'name'>('attention');
  const [now, setNow] = useState(Date.now());
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!resizing) return undefined;
    const move = (event: PointerEvent) => setWorkspacePanelWidth(event.clientX);
    const stop = () => setResizing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    document.body.classList.add('workspace-panel-resizing');
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('workspace-panel-resizing');
    };
  }, [resizing, setWorkspacePanelWidth]);

  const activeSessions = useMemo(
    () => sessions.filter((session) => !archivedIds.includes(session.id)),
    [archivedIds, sessions],
  );
  const workspaces = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of activeSessions) {
      const key = workspaceKey(session);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeSessions]);
  const selectedWorkspace = tagFilter.length === 1 ? tagFilter[0] : null;
  const visibleAgents = useMemo(() => {
    const workspaceAgents = selectedWorkspace
      ? activeSessions.filter((session) => workspaceKey(session) === selectedWorkspace || session.tags?.includes(selectedWorkspace))
      : activeSessions;
    return workspaceAgents
      .filter((session) => agentMatches(session, query))
      .filter((session) => stateFilter === 'all' || statusClass(session.status) === stateFilter)
      .sort((a, b) => {
        if (sortMode === 'name') return (a.displayName || a.name).localeCompare(b.displayName || b.name);
        if (sortMode === 'recent') return b.startTime - a.startTime;
        const rank = (session: SessionSummary) => session.status === 'waiting_input' || session.status === 'blocked' ? 0 : BUSY.has(session.status) ? 1 : session.status === 'done' || session.status === 'completed' ? 2 : 3;
        return rank(a) - rank(b) || b.startTime - a.startTime;
      });
  }, [activeSessions, query, selectedWorkspace, sortMode, stateFilter]);
  const workspaceSummary = useMemo(() => {
    const counts = { working: 0, blocked: 0, done: 0, idle: 0 };
    for (const session of visibleAgents) {
      if (session.status === 'waiting_input' || session.status === 'blocked') counts.blocked++;
      else if (BUSY.has(session.status)) counts.working++;
      else if (session.status === 'done' || session.status === 'completed') counts.done++;
      else counts.idle++;
    }
    return counts;
  }, [visibleAgents]);

  const selectWorkspace = (workspace: string | null) => {
    setTagFilter(workspace ? [workspace] : []);
  };

  const openAgent = (session: SessionSummary) => {
    setActiveSession(session.id);
    setShowNewSession(false);
  };

  const markSeen = (session: SessionSummary) => {
    useSessionStore.getState()._setSeenLocal?.(session.id);
    const connection = getConnection(session.serverUrl);
    connection?.sendSessionSeen(session.id);
  };

  const explainState = async (session: SessionSummary) => {
    if (explanations[session.id]) {
      setExplanations((current) => {
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      return;
    }
    try {
      const response = await fetch(`/api/sessions/${session.id}/detection`);
      const data = await response.json() as { reason?: string; matchedRuleId?: string; resolvedSource?: string; state?: string };
      setExplanations((current) => ({
        ...current,
        [session.id]: `${data.state ?? session.status} · ${data.reason ?? 'no reason'}${data.matchedRuleId ? ` · ${data.matchedRuleId}` : ''}${data.resolvedSource ? ` · ${data.resolvedSource}` : ''}`,
      }));
    } catch {
      setExplanations((current) => ({ ...current, [session.id]: 'Unable to load state explanation' }));
    }
  };

  const createAgent = async () => {
    const result = await createSession({ tool: 'claude' });
    if (result) setActiveSession(result.id);
  };

  const filterOptions = ['all', 'working', 'blocked', 'done', 'idle'];

  return (
    <aside className="workspace-agent-panel" style={{ width: `${workspacePanelWidth}px` }} aria-label="Workspace and agents">
      <div className="workspace-panel-header">
        <div>
          <div className="workspace-panel-kicker">WORKSPACE</div>
          <h2>Agents</h2>
        </div>
        <button className="workspace-panel-new" onClick={() => void createAgent()} title="New Claude agent">+</button>
      </div>

      <div className="workspace-list" role="listbox" aria-label="Workspaces">
        <button className={`workspace-item ${selectedWorkspace === null ? 'selected' : ''}`} onClick={() => selectWorkspace(null)}>
          <span className="workspace-item-mark">⌂</span>
          <span>All workspaces</span>
          <span className="workspace-item-count">{activeSessions.length}</span>
        </button>
        {workspaces.map(([workspace, count]) => (
          <button
            className={`workspace-item ${selectedWorkspace === workspace ? 'selected' : ''}`}
            key={workspace}
            onClick={() => selectWorkspace(workspace)}
          >
            <span className="workspace-item-mark">◈</span>
            <span>{workspaceLabel(workspace)}</span>
            <span className="workspace-item-count">{count}</span>
          </button>
        ))}
      </div>

      <div className="workspace-agents-heading">
        <span>{selectedWorkspace ? workspaceLabel(selectedWorkspace) : 'All agents'}</span>
        <span>{visibleAgents.length}</span>
      </div>
      <div className="workspace-state-summary" aria-label="Workspace agent state summary">
        <span className="working">● {workspaceSummary.working}</span>
        <span className="blocked">! {workspaceSummary.blocked}</span>
        <span className="done">✓ {workspaceSummary.done}</span>
        <span className="idle">○ {workspaceSummary.idle}</span>
      </div>
      <div className="workspace-agent-search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an agent" aria-label="Find an agent" />
        <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} aria-label="Filter agent state">
          {filterOptions.map((filter) => <option key={filter} value={filter}>{filter === 'all' ? 'All states' : filter}</option>)}
        </select>
        <select value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)} aria-label="Sort agents">
          <option value="attention">Priority</option>
          <option value="recent">Recent</option>
          <option value="name">Name</option>
        </select>
      </div>
      <div className="workspace-agent-list">
        {visibleAgents.map((session) => (
          <div
            className={`workspace-agent-row ${session.id === activeSessionId ? 'selected' : ''}`}
            key={session.id}
            onClick={() => openAgent(session)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openAgent(session); }}
          >
            <span className={`workspace-status-dot ${statusClass(session.status)}`} />
            <span className="workspace-agent-icon"><ToolIcon tool={session.tool} status={session.status} /></span>
            <span className="workspace-agent-copy">
              <span className="workspace-agent-name">{session.displayName || session.name}</span>
              <span className="workspace-agent-meta">{statusLabel(session.status)} · {elapsedLabel(session.startTime, now)} · {session.tool} · {session.cwd} · {sessionHostLabel(session, sessions) ?? session.hostname}</span>
              {explanations[session.id] && <span className="workspace-agent-explanation">{explanations[session.id]}</span>}
            </span>
            <span className="workspace-agent-actions" onClick={(event) => event.stopPropagation()}>
              <button onClick={() => markSeen(session)} title="Mark seen">✓</button>
              <button onClick={() => void explainState(session)} title="Explain state">?</button>
            </span>
          </div>
        ))}
        {visibleAgents.length === 0 && <div className="workspace-agent-empty">No agents in this workspace</div>}
      </div>
      <div
        className={`workspace-panel-resizer ${resizing ? 'active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace panel"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setResizing(true);
        }}
      />
    </aside>
  );
}
