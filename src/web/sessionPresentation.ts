import type { SessionSummary } from './hooks/useSessions';
import { sessionHostLabel } from './serverHost';

/** Last path component used consistently by tabs, workspaces, and agent rows. */
export function shortSessionPath(path: string): string {
  if (path === '~' || path === '/') return path;
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash === -1 ? normalized : (normalized.slice(lastSlash + 1) || path);
}

/**
 * One canonical path for every session label/grouping consumer.
 * Local agent child processes may move around, so their workspace stays at
 * the launch cwd. A real SSH transition uses the remote shell's live cwd.
 */
export function sessionWorkspacePath(
  session: SessionSummary,
  allSessions: readonly SessionSummary[] = [],
): string {
  const remoteHost = sessionHostLabel(session, allSessions);
  return (remoteHost ? session.cwd : (session.workspaceCwd ?? session.cwd)).trim() || '~';
}

/** Canonical user-facing session/workspace name. */
export function sessionDisplayLabel(
  session: SessionSummary,
  allSessions: readonly SessionSummary[] = [],
): string {
  const host = sessionHostLabel(session, allSessions);
  const path = shortSessionPath(sessionWorkspacePath(session, allSessions));
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
