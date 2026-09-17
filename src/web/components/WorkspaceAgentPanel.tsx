import { useEffect, useMemo, useRef, useState } from 'react';
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

import { agentStateGroup, agentStatePriority, countAgentStates } from '../agentState';

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

type WorkspaceCounts = ReturnType<typeof countAgentStates>;

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
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [createError, setCreateError] = useState('');
  const toggleWorkspacePanel = useUIStore((state) => state.toggleWorkspacePanel);

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
    window.addEventListener('pointercancel', stop, { once: true });
    document.body.classList.add('workspace-panel-resizing');
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
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
      .map(([key, grouped]) => [key, countAgentStates(grouped), sessionDisplayLabel(grouped[0], activeSessions)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeSessions]);
  const rawWorkspace = tagFilter.length === 1 ? tagFilter[0] : null;
  const selectedWorkspace = rawWorkspace && workspaces.some(([key]) => key === rawWorkspace)
    ? rawWorkspace
    : rawWorkspace && workspaces.some(([key]) => key === `workspace:tag:${rawWorkspace}`)
      ? `workspace:tag:${rawWorkspace}`
      : null;
  const allWorkspaceSummary = useMemo(() => countAgentStates(activeSessions), [activeSessions]);
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
      .filter((session) => stateFilter === 'all' || agentStateGroup(session.status) === stateFilter)
      .sort((a, b) => {
        if (sortMode === 'name') return sessionDisplayLabel(a, activeSessions).localeCompare(sessionDisplayLabel(b, activeSessions));
        if (sortMode === 'recent') return b.startTime - a.startTime;
        return agentStatePriority(a.status) - agentStatePriority(b.status) || b.startTime - a.startTime;
      });
  }, [activeSessions, query, selectedWorkspace, sortMode, stateFilter]);
  const workspaceSummary = useMemo(() => countAgentStates(visibleAgents), [visibleAgents]);

  const selectWorkspace = (workspace: string | null) => {
    setTagFilter(workspace ? [workspace] : []);
  };

  const openAgent = (session: SessionSummary) => {
    setActiveSession(session.id);
    setShowNewSession(false);
    if (window.matchMedia('(max-width: 760px)').matches) toggleWorkspacePanel();
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
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError('');
    const workspaceSession = selectedWorkspace
      ? activeSessions.find((session) => sessionWorkspaceKey(session, activeSessions) === selectedWorkspace)
      : undefined;
    const targetServerUrl = workspaceSession?.serverUrl || undefined;
    const nestedRemoteHost = !targetServerUrl && workspaceSession
      ? sessionHostLabel(workspaceSession, activeSessions)
      : null;
    const cwd = nestedRemoteHost
      ? undefined
      : workspacePathFromKey(selectedWorkspace) ?? workspaceSession?.cwd ?? workspaceSession?.workspaceCwd;
    try {
      const result = await createSession({
        tool: defaultAgentTool,
        ...(targetServerUrl ? { serverUrl: targetServerUrl } : {}),
        ...(cwd ? { cwd } : {}),
      });
      setActiveSession(result.id);
      setShowNewSession(false);
      if (window.matchMedia('(max-width: 760px)').matches) toggleWorkspacePanel();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const filterOptions = ['all', 'working', 'blocked', 'done', 'idle'];
  // Compact count: running(green) / done(blue) / total(gray). Running folds in
  // blocked (waiting_input) so agents needing attention still surface; total is
  // always the rightmost segment. Zero segments are dropped, colour disambiguates.
  const workspaceCounts = (counts: WorkspaceCounts) => {
    const running = counts.working + counts.blocked;
    const segments: { key: string; cls: string; value: number }[] = [];
    if (running > 0) segments.push({ key: 'running', cls: 'wc-running', value: running });
    if (counts.done > 0) segments.push({ key: 'done', cls: 'wc-done', value: counts.done });
    segments.push({ key: 'total', cls: 'wc-total', value: counts.total });
    return (
      <span className="workspace-item-count" aria-label={`${counts.total} total, ${running} running, ${counts.done} done`}>
        {segments.map((seg, index) => (
          <span key={seg.key} className={seg.cls}>
            {index > 0 && <span className="wc-sep">/</span>}
            {seg.value}
          </span>
        ))}
      </span>
    );
  };

  return (
    <aside className="workspace-agent-panel" style={{ width: `${workspacePanelWidth}px` }} aria-label="Workspace and agents">
      <div className="workspace-panel-header">
        <div>
          <div className="workspace-panel-kicker">WORKSPACE</div>
          <h2>Agents</h2>
        </div>
        <div className="workspace-panel-header-actions">
          <button className="workspace-panel-new" onClick={() => void createAgent()} disabled={creating} aria-label={creating ? "Creating agent" : `New ${defaultAgentTool} agent`} title={`New ${defaultAgentTool} agent`}>{creating ? '…' : '+'}</button>
          <button className="workspace-panel-new" onClick={toggleWorkspacePanel} aria-label="Close workspace panel" title="Close workspace panel">×</button>
        </div>
      </div>

      {createError && <div className="workspace-create-error" role="alert">{createError}</div>}
      <div className="workspace-list" role="group" aria-label="Workspaces">
        <button className={`workspace-item ${selectedWorkspace === null ? 'selected' : ''}`} onClick={() => selectWorkspace(null)}>
          <span className="workspace-item-mark">⌂</span>
          <span className="workspace-item-label">All workspaces</span>
          {workspaceCounts(allWorkspaceSummary)}
        </button>
        {workspaces.map(([workspace, counts, label]) => (
          <button
            className={`workspace-item ${selectedWorkspace === workspace ? 'selected' : ''}`}
            key={workspace}
            onClick={() => selectWorkspace(workspace)}
          >
            <span className="workspace-item-mark">◈</span>
            <span className="workspace-item-label" title={workspace}>{label}</span>
            {workspaceCounts(counts)}
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
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                openAgent(session);
              }
            }}
          >
            <span className={`workspace-status-dot ${session.status === 'error' ? 'error' : agentStateGroup(session.status)}`} />
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
        {visibleAgents.length === 0 && <div className="workspace-agent-empty">{query || stateFilter !== 'all' ? 'No agents match your filters' : 'No agents in this workspace'}</div>}
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
