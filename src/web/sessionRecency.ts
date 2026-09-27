// Most-recently-activated session order, persisted so that switching into a
// workspace filter lands on the tab the user was last working in there rather
// than on whichever session happens to be first in the list.

const RECENT_SESSIONS_KEY = 'swarmie-recent-sessions';
const MAX_RECENT_SESSIONS = 200;

let recentIds: string[] = loadRecentSessionIds();

function loadRecentSessionIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_SESSIONS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function noteSessionActivated(id: string | null): void {
  if (!id || recentIds[0] === id) return;
  recentIds = [id, ...recentIds.filter((existing) => existing !== id)].slice(0, MAX_RECENT_SESSIONS);
  try {
    localStorage.setItem(RECENT_SESSIONS_KEY, JSON.stringify(recentIds));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

export function recentSessionIds(): readonly string[] {
  return recentIds;
}

/** The candidate activated most recently, falling back to the first one. */
export function mostRecentSession<T extends { id: string }>(
  candidates: readonly T[],
  recent: readonly string[] = recentIds,
): T | undefined {
  if (candidates.length === 0) return undefined;
  const rank = new Map(recent.map((id, index) => [id, index]));
  let best: T | undefined;
  let bestRank = Infinity;
  for (const candidate of candidates) {
    const r = rank.get(candidate.id) ?? Infinity;
    if (r < bestRank) {
      best = candidate;
      bestRank = r;
    }
  }
  return best ?? candidates[0];
}
