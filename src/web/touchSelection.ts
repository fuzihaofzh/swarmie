// Pure helpers for the phone long-press selection in TerminalView. xterm.js has
// no touch selection of its own, so a long press on a phone only surfaced the
// browser's "Paste" bubble for xterm's hidden textarea.

/** A cell position in buffer coordinates (row includes scrollback). */
export interface CellPos {
  col: number;
  row: number;
}

/** Minimal view of an xterm buffer line: the text of each cell, '' for the
 *  trailing half of a wide (CJK) character. */
export type CellText = (col: number) => { chars: string; width: number } | undefined;

const WORD_SEPARATORS = /[\s()[\]{}<>'"`,;|│─]/;

function isWordCell(cellAt: CellText, col: number): boolean {
  const cell = cellAt(col);
  if (!cell) return false;
  // The second half of a wide character belongs to the character before it.
  if (cell.width === 0) return col > 0 && isWordCell(cellAt, col - 1);
  return cell.chars !== '' && !WORD_SEPARATORS.test(cell.chars);
}

/** Column range [start, end] (inclusive) of the word under `col`, or just that
 *  cell when it is whitespace/punctuation. */
export function wordBoundsAt(cellAt: CellText, col: number, cols: number): { start: number; end: number } {
  if (!isWordCell(cellAt, col)) return { start: col, end: col };
  let start = col;
  while (start > 0 && isWordCell(cellAt, start - 1)) start--;
  let end = col;
  while (end < cols - 1 && isWordCell(cellAt, end + 1)) end++;
  return { start, end };
}

function compare(a: CellPos, b: CellPos): number {
  return a.row === b.row ? a.col - b.col : a.row - b.row;
}

/** Arguments for `term.select(col, row, length)` covering both ends inclusive.
 *  xterm's length runs linearly across wrapped rows. */
export function selectionArgs(a: CellPos, b: CellPos, cols: number): { col: number; row: number; length: number } {
  const [first, last] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const length = (last.row - first.row) * cols + (last.col - first.col) + 1;
  return { col: first.col, row: first.row, length };
}

/** When dragging, keep the whole initially pressed word selected and grow from
 *  whichever side the finger is on. */
export function extendFromWord(
  word: { start: CellPos; end: CellPos },
  head: CellPos,
  cols: number,
): { col: number; row: number; length: number } {
  if (compare(head, word.start) < 0) return selectionArgs(head, word.end, cols);
  if (compare(head, word.end) > 0) return selectionArgs(word.start, head, cols);
  return selectionArgs(word.start, word.end, cols);
}

export interface CellRange {
  start: CellPos;
  end: CellPos;
}

/** Inverse of `selectionArgs`: the inclusive range `term.select` covers. */
export function rangeFromArgs(args: { col: number; row: number; length: number }, cols: number): CellRange {
  const last = args.row * cols + args.col + args.length - 1;
  return { start: { col: args.col, row: args.row }, end: { col: last % cols, row: Math.floor(last / cols) } };
}

/** Move one end of a selection to `pos`. Dragging an end past the other one
 *  swaps them, so the returned `active` says which handle the finger now holds. */
export function moveRangeEnd(
  range: CellRange,
  which: 'start' | 'end',
  pos: CellPos,
): { range: CellRange; active: 'start' | 'end' } {
  const fixed = which === 'start' ? range.end : range.start;
  const swapped = which === 'start' ? compare(pos, fixed) > 0 : compare(pos, fixed) < 0;
  if (!swapped) {
    return { range: which === 'start' ? { start: pos, end: fixed } : { start: fixed, end: pos }, active: which };
  }
  return which === 'start'
    ? { range: { start: fixed, end: pos }, active: 'end' }
    : { range: { start: pos, end: fixed }, active: 'start' };
}
