import { execFileSync } from 'node:child_process';
import { hostname as osHostname, networkInterfaces, platform } from 'node:os';

let cachedDisplayHostname: string | null = null;
let cachedHostnameCandidates: string[] | null = null;
let cachedLocalNameIdentities: Set<string> | null = null;

export function isAddressLikeHostname(value: string | undefined): boolean {
  const host = value?.trim();
  if (!host) return false;
  if (/^\d+$/.test(host)) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  if (/^[0-9a-f:]+$/i.test(host) && host.includes(':')) return true;
  return false;
}

function cleanHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\.local$/i, '');
}

/**
 * Canonical form used only for identity comparisons. Keep the display spelling
 * returned by getSystemDisplayHostname(), but make harmless DNS variants such
 * as "Mac.local" and "mac." compare equal.
 */
export function normalizeHostnameIdentity(value: string | undefined): string | null {
  let normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  // OSC 7 can include an IPv6 scope id, while node:os reports the bare address.
  normalized = normalized.replace(/%[a-z0-9_.-]+$/i, '');
  normalized = normalized.replace(/\.$/, '').replace(/\.local$/i, '');
  return normalized || null;
}

function readCommand(command: string, args: string[]): string | null {
  try {
    return cleanHostname(execFileSync(command, args, { timeout: 1000 }).toString('utf-8'));
  } catch {
    return null;
  }
}

function getHostnameCandidates(): string[] {
  if (cachedHostnameCandidates) return cachedHostnameCandidates;

  const candidates: Array<string | null> = [];
  candidates.push(cleanHostname(process.env.SWARMIE_HOSTNAME));

  if (platform() === 'darwin') {
    candidates.push(readCommand('scutil', ['--get', 'LocalHostName']));
    candidates.push(readCommand('scutil', ['--get', 'ComputerName']));
  }

  candidates.push(cleanHostname(osHostname()));
  candidates.push(readCommand('hostname', ['-s']));
  candidates.push(readCommand('hostname', []));

  cachedHostnameCandidates = candidates.filter((candidate): candidate is string => !!candidate);
  return cachedHostnameCandidates;
}

export function getSystemDisplayHostname(): string {
  if (cachedDisplayHostname) return cachedDisplayHostname;

  const candidates = getHostnameCandidates();

  cachedDisplayHostname =
    candidates.find((candidate) => candidate && !isAddressLikeHostname(candidate)) ??
    candidates.find((candidate): candidate is string => !!candidate) ??
    'local';

  return cachedDisplayHostname;
}

/**
 * True when a hostname reported by OSC 7 names this process's own machine.
 *
 * Shells do not agree on which local identity to put in OSC 7: macOS alone can
 * emit the LocalHostName, ComputerName, `<name>.local`, or an interface IP.
 * Treat all of those as local so a cwd update does not masquerade as an SSH
 * transition in the tab title.
 */
export function isLocalHostname(value: string | undefined): boolean {
  const identity = normalizeHostnameIdentity(value);
  if (!identity) return false;
  if (identity === 'localhost' || identity === '::1' || /^127(?:\.\d{1,3}){3}$/.test(identity)) {
    return true;
  }

  if (!cachedLocalNameIdentities) {
    const identities = new Set<string>();
    for (const candidate of getHostnameCandidates()) {
      const normalized = normalizeHostnameIdentity(candidate);
      if (normalized) identities.add(normalized);
    }
    cachedLocalNameIdentities = identities;
  }
  if (cachedLocalNameIdentities.has(identity)) return true;

  // A laptop's addresses can change while the coordinator stays alive, so do
  // not freeze interface IPs in the name cache.
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (normalizeHostnameIdentity(entry.address) === identity) return true;
    }
  }
  return false;
}

export function getDefaultHostTag(reportedHostname?: string): string {
  const cleaned = cleanHostname(reportedHostname);
  if (cleaned && !isAddressLikeHostname(cleaned)) {
    return cleaned;
  }
  return getSystemDisplayHostname();
}
