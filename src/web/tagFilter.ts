// Single source of truth for "is this session visible under the active tag
// filter". An empty filter shows everything; otherwise a session is visible if
// it carries at least one of the filtered tags. Inlining this in multiple
// places (keyboard tab-switch, MRU switcher, tab headers, settings count) is
// how filtered tabs and arrow-switching drifted out of sync before.

export function sessionMatchesTagFilter(
  session: { tags?: string[] | null },
  tagFilter: string[],
): boolean {
  if (tagFilter.length === 0) return true;
  return (session.tags ?? []).some((tag) => tagFilter.includes(tag));
}
