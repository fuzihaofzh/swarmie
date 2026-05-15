import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';
import { useKeybindingStore, matchesAction } from '../hooks/useKeybindings';

const ALL_TAG = '__all__';

export function TagSwitcher() {
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const sessions = useSessionStore((s) => s.sessions);
  const tagFilter = useUIStore((s) => s.tagFilter);
  const setTagFilter = useUIStore((s) => s.setTagFilter);

  const entries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      for (const tag of session.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const tags = Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ id: tag, label: tag, count }));
    return [{ id: ALL_TAG, label: 'All', count: sessions.length }, ...tags];
  }, [sessions]);

  // When opening, start selection on the next/prev entry relative to current filter
  const currentFilterIndex = useMemo(() => {
    if (tagFilter.length === 0) return 0;
    const idx = entries.findIndex((e) => e.id === tagFilter[0]);
    return idx >= 0 ? idx : 0;
  }, [entries, tagFilter]);

  const applySelection = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    if (entry.id === ALL_TAG) setTagFilter([]);
    else setTagFilter([entry.id]);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (open) {
        const len = entries.length;
        if (len === 0) return;
        if (e.key === 'ArrowUp' || matchesAction(e, 'tag-switcher-prev')) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => (prev - 1 + len) % len);
        } else if (e.key === 'ArrowDown' || matchesAction(e, 'tag-switcher')) {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex((prev) => (prev + 1) % len);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          applySelection(selectedIndex);
          setOpen(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
      }

      if (matchesAction(e, 'tag-switcher') || matchesAction(e, 'tag-switcher-prev')) {
        if (entries.length < 2) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = matchesAction(e, 'tag-switcher-prev') ? -1 : 1;
        const len = entries.length;
        setOpen(true);
        setSelectedIndex((currentFilterIndex + dir + len) % len);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!open) return;
      const binding = useKeybindingStore.getState().getBinding('tag-switcher');
      const isModRelease =
        (binding.alt && e.key === 'Alt') ||
        (binding.ctrl && e.key === 'Control') ||
        (binding.meta && e.key === 'Meta');
      if (isModRelease) {
        e.preventDefault();
        e.stopPropagation();
        applySelection(selectedIndex);
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
    };
  }, [open, selectedIndex, entries, currentFilterIndex]);

  if (!open) return null;

  return (
    <div className="tab-switcher-overlay" onClick={() => setOpen(false)}>
      <div className="tab-switcher tag-switcher" onClick={(e) => e.stopPropagation()}>
        {entries.map((entry, i) => {
          const isCurrent = entry.id === ALL_TAG
            ? tagFilter.length === 0
            : tagFilter.includes(entry.id);
          return (
            <div
              key={entry.id}
              className={`tab-switcher-item ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => {
                applySelection(i);
                setOpen(false);
              }}
            >
              <span className="tag-switcher-dot" data-current={isCurrent ? 'true' : 'false'} />
              <span className="tab-switcher-name">{entry.label}</span>
              <span className="tag-switcher-count">{entry.count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
