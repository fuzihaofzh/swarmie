import { useEffect, useMemo, useState } from 'react';
import { useSessionStore, type SessionSummary } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';
import { sessionHostLabel } from '../serverHost';
import {
  sessionDisplayLabel,
  sessionWorkspaceKey,
  sessionWorkspacePath,
  workspacePathFromKey,
} from '../sessionPresentation';

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

function agentMatches(session: SessionSummary, query: string, allSessions: SessionSummary[]): boolean {
  const value = query.trim().toLocaleLowerCase();
  if (!value) return true;
  return [sessionDisplayLabel(session, allSessions), session.displayName, session.name, session.tool, session.cwd, session.status, ...(session.tags ?? [])]
    .some((part) => part.toLocaleLowerCase().includes(value));
}

function elapsedLabel(startTime: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type WorkspaceCounts = { total: number; working: number; blocked: number; done: number; idle: number };

function countStates(sessions: SessionSummary[]): WorkspaceCounts {
  const counts: WorkspaceCounts = { total: sessions.length, working: 0, blocked: 0, done: 0, idle: 0 };
  for (const session of sessions) {
    const state = statusClass(session.status);
    counts[state === 'error' ? 'blocked' : state]++;
  }
  return counts;
}

export function WorkspaceAgentPanel() {
  const sessions = useSessionStore((state) => state.sessions);
  const archivedIds = useSessionStore((state) => state.archivedSessionIds);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const setShowNewSession = useUIStore((state) => state.setShowNewSession);
  const tagFilter = useUIStore((state) => state.tagFilter);
  const setTagFilter = useUIStore((state) => state.setTagFilter);
  const defaultAgentTool = useUIStore((state) => state.defaultAgentTool);
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
    const groups = new Map<string, SessionSummary[]>();
    for (const session of activeSessions) {
      const key = sessionWorkspaceKey(session, activeSessions);
      if (key) groups.set(key, [...(groups.get(key) ?? []), session]);
    }
    return [...groups.entries()]
      .map(([key, grouped]) => [key, countStates(grouped), sessionDisplayLabel(grouped[0], activeSessions)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeSessions]);
  const rawWorkspace = tagFilter.length === 1 ? tagFilter[0] : null;
  const selectedWorkspace = rawWorkspace && workspaces.some(([key]) => key === rawWorkspace)
    ? rawWorkspace
    : rawWorkspace && workspaces.some(([key]) => key === `workspace:tag:${rawWorkspace}`)
      ? `workspace:tag:${rawWorkspace}`
      : null;
  const allWorkspaceSummary = useMemo(() => countStates(activeSessions), [activeSessions]);
  useEffect(() => {
    if (rawWorkspace && selectedWorkspace && rawWorkspace !== selectedWorkspace) {
      setTagFilter([selectedWorkspace]);
    }
  }, [rawWorkspace, selectedWorkspace, setTagFilter]);
  const visibleAgents = useMemo(() => {
    const workspaceAgents = selectedWorkspace
      ? activeSessions.filter((session) => sessionWorkspaceKey(session, activeSessions) === selectedWorkspace)
      : activeSessions;
    return workspaceAgents
      .filter((session) => agentMatches(session, query, activeSessions))
      .filter((session) => stateFilter === 'all' || statusClass(session.status) === stateFilter)
      .sort((a, b) => {
        if (sortMode === 'name') return sessionDisplayLabel(a, activeSessions).localeCompare(sessionDisplayLabel(b, activeSessions));
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
    const workspaceSession = selectedWorkspace
      ? activeSessions.find((session) => sessionWorkspaceKey(session, activeSessions) === selectedWorkspace)
      : undefined;
    const cwd = workspacePathFromKey(selectedWorkspace) ?? workspaceSession?.cwd ?? workspaceSession?.workspaceCwd;
    const result = await createSession({
      tool: defaultAgentTool,
      ...(cwd && cwd !== '~' ? { cwd } : {}),
    });
    if (result) setActiveSession(result.id);
  };

  const filterOptions = ['all', 'working', 'blocked', 'done', 'idle'];
  const stateCounts = (counts: WorkspaceCounts) => (
    <span className="workspace-item-states" aria-label={`running ${counts.working}, blocked ${counts.blocked}, done ${counts.done}, idle ${counts.idle}`}>
      {counts.working > 0 && <span className="working">{counts.working}</span>}
      {counts.blocked > 0 && <span className="blocked">{counts.blocked}</span>}
      {counts.done > 0 && <span className="done">{counts.done}</span>}
      {counts.idle > 0 && <span className="idle">{counts.idle}</span>}
    </span>
  );

  return (
    <aside className="workspace-agent-panel" style={{ width: `${workspacePanelWidth}px` }} aria-label="Workspace and agents">
      <div className="workspace-panel-header">
        <div>
          <div className="workspace-panel-kicker">WORKSPACE</div>
          <h2>Agents</h2>
        </div>
        <button className="workspace-panel-new" onClick={() => void createAgent()} title={`New ${defaultAgentTool} agent`}>+</button>
      </div>

      <div className="workspace-list" role="listbox" aria-label="Workspaces">
        <button className={`workspace-item ${selectedWorkspace === null ? 'selected' : ''}`} onClick={() => selectWorkspace(null)}>
          <span className="workspace-item-mark">⌂</span>
          <span>All workspaces</span>
          <span className="workspace-item-count">{allWorkspaceSummary.total}</span>
          {stateCounts(allWorkspaceSummary)}
        </button>
        {workspaces.map(([workspace, counts, label]) => (
          <button
            className={`workspace-item ${selectedWorkspace === workspace ? 'selected' : ''}`}
            key={workspace}
            onClick={() => selectWorkspace(workspace)}
          >
            <span className="workspace-item-mark">◈</span>
            <span>{label}</span>
            <span className="workspace-item-count">{counts.total}</span>
            {stateCounts(counts)}
          </button>
        ))}
      </div>

      <div className="workspace-agents-heading">
        <span>{selectedWorkspace ? workspaces.find(([key]) => key === selectedWorkspace)?.[2] ?? 'Workspace' : 'All agents'}</span>
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
              <span className="workspace-agent-name">{sessionDisplayLabel(session, sessions)}</span>
              <span className="workspace-agent-meta">{statusLabel(session.status)} · {elapsedLabel(session.startTime, now)} · {session.tool} · {sessionWorkspacePath(session, sessions)} · {sessionHostLabel(session, sessions) ?? session.hostname}</span>
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
