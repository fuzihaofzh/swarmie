const RECENT_DIRS_KEY = 'swarmie-recent-dirs-v2';
const MAX_RECENT = 12;

export interface RecentEntry {
  dir: string;
  hostname?: string;
}

/** Local hostname learned from sessions — used to collapse hostname variants */
let _localHostname = '';
export function setLocalHostname(h: string) { _localHostname = h; }

/** Normalize hostname: treat falsy / 'local' / actual local hostname as '' */
function normalizeHost(h?: string): string {
  if (!h || h === 'local') return '';
  if (_localHostname && h === _localHostname) return '';
  return h;
}

function entryKey(dir: string, hostname?: string): string {
  return `${normalizeHost(hostname)}:${dir}`;
}

export function loadRecentDirs(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]');
  } catch { return []; }
}

export function saveRecentDir(entry: RecentEntry) {
  const targetKey = entryKey(entry.dir, entry.hostname);
  const list = loadRecentDirs().filter((e) => entryKey(e.dir, e.hostname) !== targetKey);
  list.unshift({ dir: entry.dir, hostname: normalizeHost(entry.hostname) || undefined });
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
}

/** Merge persisted history with live session cwds, newest first */
export function getRecentEntries(sessions: { cwd: string; hostname: string }[]): RecentEntry[] {
  const saved = loadRecentDirs();
  const keys = new Set(saved.map((e) => entryKey(e.dir, e.hostname)));
  for (const s of sessions) {
    if (s.cwd && s.cwd !== '~') {
      const key = entryKey(s.cwd, s.hostname);
      if (!keys.has(key)) {
        const h = normalizeHost(s.hostname);
        saved.push({ dir: s.cwd, hostname: h || undefined });
        keys.add(key);
      }
    }
  }
  return saved.slice(0, MAX_RECENT);
}
