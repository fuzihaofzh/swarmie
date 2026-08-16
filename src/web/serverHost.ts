// Helpers for turning a session's `serverUrl` into a human host label.
//
// A session registered from a *different* swarmie process carries the URL the
// browser would reach it at (e.g. "http://seis10:3200"). But the coordinator
// you're viewing is itself reached over some URL too — and when you open the
// dashboard by LAN IP ("http://192.168.0.253:3200"), that machine's own
// sessions come back tagged with that same IP. Showing it as a remote host is
// wrong: from the viewer's seat it's simply local. So a serverUrl whose host
// matches the page's own host is treated as local and gets no label.

/** Extract the hostname from a serverUrl, or null if it isn't a parseable URL. */
export function serverUrlHostname(serverUrl: string | undefined): string | null {
  if (!serverUrl) return null;
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return null;
  }
}

function normalizeHostname(value: string | undefined): string | null {
  let normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/%[a-z0-9_.-]+$/i, '');
  normalized = normalized.replace(/\.$/, '').replace(/\.local$/i, '');
  return normalized || null;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Compare harmless aliases without hiding a genuinely different host. */
export function hostnamesEquivalent(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeHostname(a);
  const right = normalizeHostname(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return isLoopback(left) && isLoopback(right);
}

/**
 * True when `serverUrl` points at the same machine that's serving this page.
 * Compares hostnames only — a different port is still the same box, and the
 * user's complaint ("that's the local machine, don't write it") is about the
 * host, not the port.
 */
export function isSelfServerUrl(serverUrl: string | undefined): boolean {
  const host = serverUrlHostname(serverUrl);
  if (host === null) return false;
  if (typeof window === 'undefined') return false;
  return hostnamesEquivalent(host, window.location.hostname);
}

/**
 * Host label to show for a remote session, or null when it should show none
 * (empty serverUrl = local; or a serverUrl that resolves to this same machine).
 */
export function remoteHostLabel(serverUrl: string | undefined): string | null {
  if (!serverUrl) return null;
  if (isSelfServerUrl(serverUrl)) return null;
  return serverUrlHostname(serverUrl) ?? serverUrl;
}

export interface HostAwareSession {
  serverUrl?: string;
  hostname?: string;
  initialHostname?: string;
}

/**
 * Host prefix for a session tab. `null` means the session is on this machine
 * and the tab should show only its directory.
 *
 * Besides the page URL, local sessions provide a stable machine identity. It
 * lets us recognize the same Swarmie server reached through another alias or
 * LAN address without confusing a truly remote server with local.
 */
export function sessionHostLabel(
  session: HostAwareSession,
  allSessions: readonly HostAwareSession[] = [],
): string | null {
  const localInitialHosts = allSessions
    .filter((candidate) => !candidate.serverUrl || isSelfServerUrl(candidate.serverUrl))
    .map((candidate) => candidate.initialHostname)
    .filter((hostname): hostname is string => !!hostname);

  const sourceIsLocal = !session.serverUrl
    || isSelfServerUrl(session.serverUrl)
    || localInitialHosts.some((hostname) => hostnamesEquivalent(hostname, session.initialHostname));

  if (!sourceIsLocal) return remoteHostLabel(session.serverUrl);

  // For a local source, show a host only after a real SSH transition. Ignore
  // `.local`, case, loopback, and page-host variants left in older sessions.
  if (!session.hostname || hostnamesEquivalent(session.hostname, session.initialHostname)) return null;
  if (typeof window !== 'undefined' && hostnamesEquivalent(session.hostname, window.location.hostname)) return null;
  if (localInitialHosts.some((hostname) => hostnamesEquivalent(hostname, session.hostname))) return null;
  return session.hostname;
}
