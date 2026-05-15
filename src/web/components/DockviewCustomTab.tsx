import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';

const NEW_SESSION_PANEL_ID = '__new_session__';

function shortPath(p: string): string {
  if (p === '~' || p === '/') return p;
  // Show only the last directory name
  const name = p.endsWith('/') ? p.slice(0, -1) : p;
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash === -1) return name;
  return name.slice(lastSlash + 1) || p;
}

function _shortPathFull(p: string): string {
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

function formatRemaining(target: number | null | undefined, now: number): string {
  if (!target) return '';
  const seconds = Math.max(0, Math.ceil((target - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function isBusyForRepeat(status: string): boolean {
  return status === 'starting' || status === 'running' || status === 'thinking' || status === 'tool_executing';
}

function isBusyForAutoCompact(status: string): boolean {
  return status !== 'idle' && status !== 'completed' && status !== 'error';
}

export function DockviewCustomTab({ api, params }: IDockviewPanelHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, width: 260 });
  const [repeatDraft, setRepeatDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [now, setNow] = useState(Date.now());
  const tabRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLSpanElement>(null);
  const sessionId = (params as { sessionId?: string }).sessionId;
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId));
  const allSessions = useSessionStore((s) => s.sessions);
  const tagFilter = useUIStore((s) => s.tagFilter);

  const availableTags = useMemo(() => {
    const current = new Set(session?.tags ?? []);
    const all = new Set<string>();
    for (const sess of allSessions) {
      for (const tag of sess.tags ?? []) {
        if (!current.has(tag)) all.add(tag);
      }
    }
    return Array.from(all).sort();
  }, [allSessions, session?.tags]);

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
  const setSessionAutoCompact = useSessionStore((s) => s.setSessionAutoCompact);
  const setSessionRepeat = useSessionStore((s) => s.setSessionRepeat);
  const setSessionTags = useSessionStore((s) => s.setSessionTags);
  const { killSession } = useWsContext();

  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (tabRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.('.tab-tools-panel')) return;
      setPanelOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanelOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [panelOpen]);

  useEffect(() => {
    setRepeatDraft(session?.repeatCommand ?? '');
  }, [session?.id, session?.repeatCommand]);

  useEffect(() => {
    if (!session?.repeatEnabled && !session?.autoCompact) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.repeatEnabled, session?.autoCompact]);

  if (!session) return null;

  const filteredOut = tagFilter.length > 0
    && !(session.tags ?? []).some((tag) => tagFilter.includes(tag));

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

  const handleToolsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = toolsRef.current?.getBoundingClientRect();
    if (rect) {
      const viewportPadding = 8;
      const panelWidth = Math.min(280, Math.max(240, window.innerWidth - viewportPadding * 2));
      const desiredLeft = rect.right - panelWidth;
      const maxLeft = window.innerWidth - panelWidth - viewportPadding;
      setPanelPos({
        top: Math.max(viewportPadding, Math.min(rect.bottom + 6, window.innerHeight - viewportPadding)),
        left: Math.max(viewportPadding, Math.min(desiredLeft, maxLeft)),
        width: panelWidth,
      });
    }
    setPanelOpen((open) => !open);
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await killSession(session.id);
  };

  const addTag = (value?: string) => {
    const tag = (value ?? tagDraft).trim();
    if (!tag) return;
    if ((session.tags ?? []).includes(tag)) return;
    setSessionTags(session.id, [...(session.tags ?? []), tag]);
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    setSessionTags(session.id, (session.tags ?? []).filter((t) => t !== tag));
  };

  const commitRepeatCommand = () => {
    setSessionRepeat(session.id, { enabled: !!session.repeatEnabled, command: repeatDraft });
  };

  const toolsActive = active || session.autoCompact || session.repeatEnabled || (session.tags?.length ?? 0) > 0;
  const repeatLabel = session.repeatEnabled
    ? !session.repeatCommand
        ? 'repeat unset'
        : isBusyForRepeat(session.status)
          ? 'busy'
          : formatRemaining(session.nextRepeatAt, now) || 'on'
    : null;
  const compactLabel = session.autoCompact
    ? isBusyForAutoCompact(session.status)
      ? 'busy'
      : formatRemaining(session.nextAutoCompactAt, now) || 'on'
    : null;

  return (
    <div
      ref={tabRef}
      className={`dv-custom-tab${filteredOut ? ' dv-custom-tab-hidden' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => api.setActive()}
    >
      <ToolIcon tool={session.tool} status={session.status} />
      <span className="dv-tab-name">
        {displayHost ? `${displayHost}:${shortPath(session.cwd)}` : shortPath(session.cwd)}
      </span>
      <span
        ref={toolsRef}
        className={`dv-tab-tools ${toolsActive || hovered || panelOpen ? 'visible' : ''}`}
        onClick={handleToolsClick}
        title="Session tools"
      >
        <span className="dv-tab-tools-icon">&#9881;</span>
      </span>
      {panelOpen && createPortal(
        <div
          className="tab-tools-panel"
          style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tab-tools-row">
            <span>Auto yes</span>
            <button
              className={`toggle-switch ${active ? 'on' : ''}`}
              onClick={() => setSessionAutoApprove(session.id, !active)}
              aria-label="Toggle auto yes"
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="tab-tools-row">
            <span className="tab-tools-label">
              <span>Auto compact</span>
              {compactLabel && (
                <span className={`tab-tools-status ${compactLabel === 'busy' ? 'busy' : ''}`}>
                  {compactLabel}
                </span>
              )}
            </span>
            <button
              className={`toggle-switch ${session.autoCompact ? 'on' : ''}`}
              onClick={() => setSessionAutoCompact(session.id, !session.autoCompact)}
              aria-label="Toggle auto compact"
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <div className="tab-tools-row">
            <span className="tab-tools-label">
              <span>Repeat</span>
              {repeatLabel && (
                <span className={`tab-tools-status ${repeatLabel === 'busy' ? 'busy' : ''}`}>
                  {repeatLabel}
                </span>
              )}
            </span>
            <button
              className={`toggle-switch ${session.repeatEnabled ? 'on' : ''}`}
              onClick={() => setSessionRepeat(session.id, { enabled: !session.repeatEnabled, command: repeatDraft })}
              aria-label="Toggle repeat"
            >
              <span className="toggle-knob" />
            </button>
          </div>
          {session.repeatEnabled && (
            <input
              className="tab-tools-input"
              value={repeatDraft}
              onChange={(e) => {
                const value = e.target.value;
                setRepeatDraft(value);
              }}
              onBlur={commitRepeatCommand}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRepeatCommand();
                }
              }}
              onKeyUp={(e) => e.stopPropagation()}
              placeholder="Repeat command"
            />
          )}
          {session.repeatEnabled && (
            <div className="tab-tools-repeat-options">
              <label className="tab-tools-number">
                <span>Interval</span>
                <input
                  type="number"
                  min="1"
                  max="86400"
                  value={session.repeatIntervalSeconds ?? 60}
                  onChange={(e) => setSessionRepeat(session.id, { intervalSeconds: Number(e.target.value) })}
                />
                <span>sec</span>
              </label>
              <label className="tab-tools-checkbox">
                <input
                  type="checkbox"
                  checked={!!session.repeatClear}
                  onChange={(e) => setSessionRepeat(session.id, { clear: e.target.checked })}
                />
                <span>Clear</span>
              </label>
            </div>
          )}
          <div className="tab-tools-tags">
            {(session.tags ?? []).map((tag) => (
              <button
                key={tag}
                className="tab-tools-tag"
                onClick={() => removeTag(tag)}
                title="Remove tag"
              >
                {tag}<span>&times;</span>
              </button>
            ))}
          </div>
          <div className="tab-tools-add-tag">
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add tag"
            />
            <button onClick={() => addTag()}>Add</button>
          </div>
          {availableTags.length > 0 && (
            <div className="tab-tools-available-tags">
              <div className="tab-tools-available-tags-label">Available</div>
              <div className="tab-tools-available-tags-grid">
                {availableTags.map((tag) => (
                  <button
                    key={tag}
                    className="tab-tools-available-tag"
                    onClick={() => addTag(tag)}
                    title="Add tag"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
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
