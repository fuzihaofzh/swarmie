const RECENT_DIRS_KEY = 'swarmie-recent-dirs-v2';
const MAX_RECENT = 12;

export interface RecentEntry {
  dir: string;
  hostname?: string;
}

export function loadRecentDirs(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]');
  } catch { return []; }
}

export function saveRecentDir(entry: RecentEntry) {
  const list = loadRecentDirs().filter((e) => !(e.dir === entry.dir && e.hostname === entry.hostname));
  list.unshift(entry);
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
}

/** Merge persisted history with live session cwds, newest first */
export function getRecentEntries(sessions: { cwd: string; hostname: string }[]): RecentEntry[] {
  const saved = loadRecentDirs();
  const keys = new Set(saved.map((e) => `${e.hostname || ''}:${e.dir}`));
  for (const s of sessions) {
    if (s.cwd && s.cwd !== '~') {
      const key = `${s.hostname || ''}:${s.cwd}`;
      if (!keys.has(key)) {
        saved.push({ dir: s.cwd, hostname: s.hostname || undefined });
        keys.add(key);
      }
    }
  }
  return saved.slice(0, MAX_RECENT);
}
