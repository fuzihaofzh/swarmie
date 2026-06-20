import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewPanelHeaderProps } from 'dockview';
import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useWsContext } from '../contexts/WsContext';
import { ToolIcon } from './ToolIcon';
import { sessionMatchesTagFilter } from '../tagFilter';

const NEW_SESSION_PANEL_ID = '__new_session__';

// Touch swipe threshold (px) above which a touch is treated as a scroll, not a tap.
const TAP_MOVE_THRESHOLD = 14;
const SUPPRESS_CLICK_MS = 700;

/**
 * Distinguish a tap from a swipe on touch devices. Swiping horizontally to
 * scroll the tab strip still fires Dockview's parent `pointerdown` handler
 * before the finger has moved. For touch pointers we intercept that event in
 * the capture phase, then activate the tab ourselves only if the gesture ends
 * as a tap.
 */
function useSwipeSafeTabActivate(
  tabRef: React.RefObject<HTMLElement | null>,
  onTap: () => void,
) {
  const onTapRef = useRef(onTap);
  const gestureRef = useRef<{
    x: number;
    y: number;
    pointerId?: number;
    moved: boolean;
    interactive: boolean;
  } | null>(null);
  const suppressClickUntilRef = useRef(0);

  useEffect(() => {
    onTapRef.current = onTap;
  }, [onTap]);

  useEffect(() => {
    const el = tabRef.current;
    if (!el) return;

    const isInteractiveTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      !!target.closest('.dv-tab-tools, .dv-tab-close, button, input, textarea, select, a');

    const stopDockviewActivation = (event: Event) => {
      event.stopPropagation();
    };

    const stopSyntheticClick = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if ('stopImmediatePropagation' in event) {
        event.stopImmediatePropagation();
      }
    };

    const updateMovement = (clientX: number, clientY: number) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (
        Math.abs(clientX - gesture.x) > TAP_MOVE_THRESHOLD ||
        Math.abs(clientY - gesture.y) > TAP_MOVE_THRESHOLD
      ) {
        gesture.moved = true;
      }
    };

    const finishGesture = (event: Event, shouldActivate: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      stopDockviewActivation(event);
      suppressClickUntilRef.current = Date.now() + SUPPRESS_CLICK_MS;
      if (shouldActivate && !gesture.moved && !gesture.interactive) {
        onTapRef.current();
      }
      gestureRef.current = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      gestureRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        moved: false,
        interactive: isInteractiveTarget(event.target),
      };
      stopDockviewActivation(event);
    };

    const onPointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      updateMovement(event.clientX, event.clientY);
    };

    const onPointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      finishGesture(event, true);
    };

    const onPointerCancel = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      finishGesture(event, false);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (gestureRef.current?.pointerId !== undefined) return;
      const touch = event.touches[0];
      if (!touch) return;
      gestureRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        moved: false,
        interactive: isInteractiveTarget(event.target),
      };
      stopDockviewActivation(event);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (gestureRef.current?.pointerId !== undefined) return;
      const touch = event.touches[0];
      if (!touch) return;
      updateMovement(touch.clientX, touch.clientY);
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (gestureRef.current?.pointerId !== undefined) return;
      finishGesture(event, true);
    };

    const onClick = (event: MouseEvent) => {
      // Never swallow clicks on the gear/close buttons (or any control): the
      // post-gesture suppression window exists only to cancel Dockview's own
      // tab-activation synthetic click, not the user's tap on a child control.
      if (isInteractiveTarget(event.target)) return;
      if (Date.now() < suppressClickUntilRef.current) {
        stopSyntheticClick(event);
      }
    };

    el.addEventListener('pointerdown', onPointerDown, { capture: true });
    el.addEventListener('pointermove', onPointerMove, { capture: true });
    el.addEventListener('pointerup', onPointerUp, { capture: true });
    el.addEventListener('pointercancel', onPointerCancel, { capture: true });
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    el.addEventListener('touchend', onTouchEnd, { capture: true });
    el.addEventListener('click', onClick, { capture: true });

    return () => {
      el.removeEventListener('pointerdown', onPointerDown, { capture: true });
      el.removeEventListener('pointermove', onPointerMove, { capture: true });
      el.removeEventListener('pointerup', onPointerUp, { capture: true });
      el.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      el.removeEventListener('click', onClick, { capture: true });
    };
  }, [tabRef]);
}

function shortPath(p: string): string {
  if (p === '~' || p === '/') return p;
  // Show only the last directory name
  const name = p.endsWith('/') ? p.slice(0, -1) : p;
  const lastSlash = name.lastIndexOf('/');
  if (lastSlash === -1) return name;
  return name.slice(lastSlash + 1) || p;
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
  useSwipeSafeTabActivate(tabRef, () => api.setActive());
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

  const filteredOut = tagFilter.length > 0 && !sessionMatchesTagFilter(session, tagFilter);

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
  const tabRef = useRef<HTMLDivElement>(null);
  useSwipeSafeTabActivate(tabRef, () => api.setActive());
  return (
    <div
      ref={tabRef}
      className="dv-custom-tab dv-new-session-tab"
    >
      <span style={{ fontSize: 16, fontWeight: 'bold' }}>+</span>
      <span className="dv-tab-name">New Session</span>
    </div>
  );
}

export { NEW_SESSION_PANEL_ID };
