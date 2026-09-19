import type { SessionSummary } from './hooks/useSessions';
import { sessionMatchesTagFilter } from './tagFilter';

interface CommandTabShortcut {
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Return the 1-based tab number requested by Cmd+1 ... Cmd+9. */
export function commandTabNumber(event: CommandTabShortcut): number | null {
  if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return null;
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) : null;
}

/**
 * Keep the displayed numbers and keyboard targets in Dockview's current order.
 * Archived, tag-filtered, and non-session panels do not consume a number.
 */
export function numberedTabIds(
  orderedPanelIds: readonly string[],
  sessions: readonly SessionSummary[],
  archivedSessionIds: readonly string[],
  tagFilter: readonly string[],
): string[] {
  const archived = new Set(archivedSessionIds);
  const workspaceSessions = sessions.filter((session) => !archived.has(session.id));
  const activeTagFilter = [...tagFilter];
  const visibleIds = new Set(
    workspaceSessions
      .filter((session) =>
        activeTagFilter.length === 0 || sessionMatchesTagFilter(session, activeTagFilter, workspaceSessions)
      )
      .map((session) => session.id),
  );

  return orderedPanelIds.filter((id) => visibleIds.has(id));
}
