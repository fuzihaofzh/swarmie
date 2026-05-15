import { execFileSync } from 'node:child_process';
import { hostname as osHostname, platform } from 'node:os';

let cachedDisplayHostname: string | null = null;

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

function readCommand(command: string, args: string[]): string | null {
  try {
    return cleanHostname(execFileSync(command, args, { timeout: 1000 }).toString('utf-8'));
  } catch {
    return null;
  }
}

export function getSystemDisplayHostname(): string {
  if (cachedDisplayHostname) return cachedDisplayHostname;

  const candidates: Array<string | null> = [];
  candidates.push(cleanHostname(process.env.SWARMIE_HOSTNAME));

  if (platform() === 'darwin') {
    candidates.push(readCommand('scutil', ['--get', 'LocalHostName']));
    candidates.push(readCommand('scutil', ['--get', 'ComputerName']));
  }

  candidates.push(cleanHostname(osHostname()));
  candidates.push(readCommand('hostname', ['-s']));
  candidates.push(readCommand('hostname', []));

  cachedDisplayHostname =
    candidates.find((candidate) => candidate && !isAddressLikeHostname(candidate)) ??
    candidates.find((candidate): candidate is string => !!candidate) ??
    'local';

  return cachedDisplayHostname;
}

export function getDefaultHostTag(reportedHostname?: string): string {
  const cleaned = cleanHostname(reportedHostname);
  if (cleaned && !isAddressLikeHostname(cleaned)) {
    return cleaned;
  }
  return getSystemDisplayHostname();
}
