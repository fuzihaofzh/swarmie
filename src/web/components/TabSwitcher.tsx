import { useEffect, useState, useCallback, useRef } from 'react';
import { useSessionStore } from '../hooks/useSessions';
import { ToolIcon } from './ToolIcon';

interface TabSwitcherProps {
  mruRef: React.RefObject<string[]>;
}

export function TabSwitcher({ mruRef }: TabSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const sessions = useSessionStore((s) => s.sessions);
  const mruListRef = useRef<string[]>([]);

  const getMRUSessions = useCallback(() => {
    const mru = mruListRef.current;
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return mru.map((id) => sessionMap.get(id)).filter(Boolean) as typeof sessions;
  }, [sessions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (open) {
        // Navigate within the switcher
        const len = mruListRef.current.length;
        if (len === 0) return;

        if (e.key === 'ArrowUp' || (e.altKey && e.shiftKey && e.code === 'BracketLeft')) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => (prev - 1 + len) % len);
        } else if (e.key === 'ArrowDown' || (e.altKey && !e.shiftKey && e.code === 'BracketLeft')) {
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

      // Option+[ to open switcher
      if (e.altKey && e.code === 'BracketLeft') {
        e.preventDefault();
        e.stopPropagation();
        mruListRef.current = [...(mruRef.current ?? [])];
        if (mruListRef.current.length < 2) {
          return;
        }
        setOpen(true);
        setSelectedIndex(1);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!open) return;
      // Release Option key to confirm selection
      if (e.key === 'Alt') {
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

  const mruSessions = getMRUSessions();

  return (
    <div className="tab-switcher-overlay" onClick={() => setOpen(false)}>
      <div className="tab-switcher" onClick={(e) => e.stopPropagation()}>
        {mruSessions.map((s, i) => {
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
