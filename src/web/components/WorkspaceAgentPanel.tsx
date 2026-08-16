import { useEffect, useMemo, useState } from 'react';
import { useSessionStore, type SessionSummary } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';

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
  const { createSession } = useWsContext();
  const [query, setQuery] = useState('');
  const [resizing, setResizing] = useState(false);

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
    return workspaceAgents.filter((session) => agentMatches(session, query));
  }, [activeSessions, query, selectedWorkspace]);
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

  const createAgent = async () => {
    const result = await createSession({ tool: 'claude' });
    if (result) setActiveSession(result.id);
  };

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
      </div>
      <div className="workspace-agent-list">
        {visibleAgents.map((session) => (
          <button
            className={`workspace-agent-row ${session.id === activeSessionId ? 'selected' : ''}`}
            key={session.id}
            onClick={() => openAgent(session)}
          >
            <span className={`workspace-status-dot ${statusClass(session.status)}`} />
            <span className="workspace-agent-icon"><ToolIcon tool={session.tool} status={session.status} /></span>
            <span className="workspace-agent-copy">
              <span className="workspace-agent-name">{session.displayName || session.name}</span>
              <span className="workspace-agent-meta">{statusLabel(session.status)} · {session.tool} · {session.cwd} · {session.hostname}</span>
            </span>
          </button>
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
