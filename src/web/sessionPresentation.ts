import type { SessionSummary } from './hooks/useSessions';
import { sessionHostLabel } from './serverHost';

/** Last path component used consistently by tabs, workspaces, and agent rows. */
export function shortSessionPath(path: string): string {
  if (path === '~' || path === '/') return path;
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? normalized : (normalized.slice(lastSlash + 1) || path);
}

/** One live cwd shared by tab labels, workspace groups, and agent rows. */
export function sessionWorkspacePath(
  session: SessionSummary,
  _allSessions: readonly SessionSummary[] = [],
): string {
  return session.cwd.trim() || '~';
}

/** Canonical live session name used by tabs and agent rows. */
export function sessionDisplayLabel(
  session: SessionSummary,
  allSessions: readonly SessionSummary[] = [],
): string {
  const host = sessionHostLabel(session, allSessions);
  const path = shortSessionPath(session.cwd.trim() || '~');
  return host ? `${host}:${path}` : path;
}

/** Canonical workspace identity used by filtering and the workspace sidebar. */
export function sessionWorkspaceKey(
  session: SessionSummary,
  allSessions: readonly SessionSummary[] = [],
): string | null {
  const host = sessionHostLabel(session, allSessions);
  const path = sessionWorkspacePath(session, allSessions);
  if (!path || path === '~') {
    return session.tags?.[0] ? `workspace:tag:${session.tags[0]}` : null;
  }
  return host ? `workspace:hostcwd:${host}:${path}` : `workspace:cwd:${path}`;
}

export function workspacePathFromKey(key: string | null): string | undefined {
  if (!key) return undefined;
  if (key.startsWith('workspace:cwd:')) return key.slice('workspace:cwd:'.length);
  if (key.startsWith('workspace:hostcwd:')) {
    const value = key.slice('workspace:hostcwd:'.length);
    const separator = value.indexOf(':');
    return separator >= 0 ? value.slice(separator + 1) : undefined;
  }
  return undefined;
}
