/** Ignore the common tmux window-list/clock footer when measuring agent work.
 * Require both multiple window entries and a clock at the end, rather than
 * discarding arbitrary timestamped program output. */
export function stripTmuxStatusLine(text: string): string {
  const lines = text.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return text;
  const footer = lines[end];
  if ((footer.match(/(?:^|\s)\d+:[^\s]+/g)?.length ?? 0) < 2
      || !/\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(footer)) return text;
  lines[end] = '';
  return lines.join('\n');
}
