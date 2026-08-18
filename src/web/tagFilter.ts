// Single source of truth for "is this session visible under the active filter".
// Workspace identity comes from the same presentation module as tab/sidebar
// names, so filtering and labels cannot independently drift.

import type { SessionSummary } from './hooks/useSessions';
import { sessionWorkspaceKey, sessionWorkspacePath } from './sessionPresentation';

export function sessionMatchesTagFilter(
  session: SessionSummary,
  tagFilter: string[],
  allSessions: readonly SessionSummary[] = [session],
): boolean {
  if (tagFilter.length === 0) return true;
  return tagFilter.some((filter) =>
    filter.startsWith('workspace:hostcwd:')
      ? sessionWorkspaceKey(session, allSessions) === filter
      : filter.startsWith('workspace:cwd:')
      ? sessionWorkspaceKey(session, allSessions) === filter
      : filter.startsWith('workspace:tag:')
        ? (session.tags ?? []).includes(filter.slice('workspace:tag:'.length))
        : filter.startsWith('cwd:')
          ? sessionWorkspacePath(session, allSessions) === filter.slice(4)
          : (session.tags ?? []).includes(filter),
  );
}
