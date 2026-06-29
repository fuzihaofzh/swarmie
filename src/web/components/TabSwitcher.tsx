import { useEffect, useState, useRef } from 'react';
import { useSessionStore } from '../hooks/useSessions';
import { ToolIcon } from './ToolIcon';
import { useKeybindingStore, matchesAction } from '../hooks/useKeybindings';
import { useUIStore } from '../hooks/useUI';
import { sessionMatchesTagFilter } from '../tagFilter';

interface TabSwitcherProps {
  mruRef: React.RefObject<string[]>;
}

/**
 * True for real editable form fields (the tag/server/password inputs) but NOT
 * the xterm helper <textarea>, which holds focus whenever a terminal is active.
 * Global shortcuts must keep working while a terminal is focused.
 */
function isNonTerminalFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.xterm')) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function TabSwitcher({ mruRef }: TabSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Display order, frozen at open time. Deliberately NOT recomputed while the
  // switcher is open — re-sorting on every render (e.g. when a background
  // session flips to waiting_input) used to shuffle items out from under the
  // user's selection, so releasing the modifier activated the wrong agent.
  const [orderIds, setOrderIds] = useState<string[]>([]);
  const sessions = useSessionStore((s) => s.sessions);
  const archivedSessionIds = useSessionStore((s) => s.archivedSessionIds);
  const mruListRef = useRef<string[]>([]);

  const setSessionAutoApprove = useSessionStore((s) => s.setSessionAutoApprove);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (open) {
        // Navigate within the switcher
        const len = mruListRef.current.length;
        if (len === 0) return;

        if (e.key === 'ArrowUp' || matchesAction(e, 'tab-switcher-prev')) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => (prev - 1 + len) % len);
        } else if (e.key === 'ArrowDown' || matchesAction(e, 'tab-switcher')) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => (prev + 1) % len);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const targetId = mruListRef.current[selectedIndex];
          if (targetId) {
            useSessionStore.getState().setActiveSession(targetId);
          }
          setOpen(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
      }

      // Open switcher. Ignore the shortcut while the user is typing in a real
      // form field (tag rename, server URL/password, …) — but NOT the xterm
      // helper textarea, which holds focus whenever a terminal is active and is
      // the normal context for invoking the switcher.
      if (matchesAction(e, 'tab-switcher') || matchesAction(e, 'tab-switcher-prev')) {
        if (isNonTerminalFormField(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        const state = useSessionStore.getState();
        const archived = new Set(state.archivedSessionIds);
        const currentTagFilter = useUIStore.getState().tagFilter;
        const visibleSessions = state.sessions
          .filter((s) => !archived.has(s.id))
          .filter((s) => currentTagFilter.length === 0 || sessionMatchesTagFilter(s, currentTagFilter));
        const visibleById = new Map(visibleSessions.map((s) => [s.id, s]));
        const filtered = [...(mruRef.current ?? [])].filter((id) => visibleById.has(id));
        if (filtered.length < 2) {
          return;
        }
        // Apply the bell-first sort exactly once, here, then freeze it.
        const ordered = filtered.sort((a, b) => {
          const aBell = visibleById.get(a)?.status === 'waiting_input' ? 0 : 1;
          const bBell = visibleById.get(b)?.status === 'waiting_input' ? 0 : 1;
          return aBell - bBell;
        });
        mruListRef.current = ordered;
        setOrderIds(ordered);
        setOpen(true);
        setSelectedIndex(Math.min(1, ordered.length - 1));
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!open) return;
      // Release the modifier key to confirm selection
      const binding = useKeybindingStore.getState().getBinding('tab-switcher');
      const isModRelease =
        (binding.alt && e.key === 'Alt') ||
        (binding.ctrl && e.key === 'Control') ||
        (binding.meta && e.key === 'Meta');
      if (isModRelease) {
        e.preventDefault();
        e.stopPropagation();
        const targetId = mruListRef.current[selectedIndex];
        if (targetId) {
          useSessionStore.getState().setActiveSession(targetId);
        }
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [open, selectedIndex, mruRef]);

  if (!open) return null;

  // Render from the frozen order. Look each id up in the live session list so
  // status/host details stay current, but the ORDER and the index→id mapping
  // (mruListRef) never change while open, keeping the highlighted row and the
  // keyboard selection in lock-step.
  const archived = new Set(archivedSessionIds);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  return (
    <div className="tab-switcher-overlay" onClick={() => setOpen(false)}>
      <div className="tab-switcher" onClick={(e) => e.stopPropagation()}>
        {orderIds.map((id, i) => {
          const s = sessionById.get(id);
          if (!s || archived.has(id)) return null;
          const short = s.cwd
            .replace(/^\/Users\/[^/]+/, '~')
            .replace(/^\/home\/[^/]+/, '~');
          return (
            <div
              key={s.id}
              className={`tab-switcher-item ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => {
                useSessionStore.getState().setActiveSession(s.id);
                setOpen(false);
              }}
            >
              <ToolIcon tool={s.tool} status={s.status} />
              <span className="tab-switcher-name">
                {short || '~'}
              </span>
              {s.hostname && s.hostname !== 'local' && (
                <span className="tab-switcher-host">{s.hostname}</span>
              )}
              <span
                className="tab-switcher-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setSessionAutoApprove(s.id, !s.autoApprove);
                }}
                title={`Auto-approve: ${s.autoApprove ? 'on' : 'off'}`}
              >
                <span className={`dv-tab-toggle ${s.autoApprove ? 'on' : ''}`}>
                  <span className="dv-tab-toggle-knob" />
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
