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

/** Collapse `/Users/<u>/...` and `/home/<u>/...` to `~/...` so dedup key matches OSC-title form */
function normalizeDir(dir: string): string {
  return dir.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function entryKey(dir: string, hostname?: string): string {
  return `${normalizeHost(hostname)}:${normalizeDir(dir)}`;
}

export function loadRecentDirs(): RecentEntry[] {
  try {
    const raw: RecentEntry[] = JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]');
    // Dedup pre-existing entries that were saved before normalization landed
    const seen = new Set<string>();
    const out: RecentEntry[] = [];
    for (const e of raw) {
      const k = entryKey(e.dir, e.hostname);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
    return out;
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
