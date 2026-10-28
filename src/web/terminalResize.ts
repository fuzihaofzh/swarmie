import type { Terminal } from '@xterm/xterm';

type ResizableTerminal = Pick<Terminal,
  'cols' | 'rows' | 'buffer' | 'options' | 'registerMarker' | 'resize' | 'scrollToLine' | 'scrollToBottom'>;

/** Keep the passage being read in view when xterm rewraps the buffer. */
export function resizeTerminalPreservingScroll(
  term: ResizableTerminal,
  cols: number,
  rows: number,
  following: boolean,
  minimumScrollback = term.options.scrollback ?? 1000,
): void {
  if (term.cols === cols && term.rows === rows) return;
  const buffer = term.buffer.active;
  let start = buffer.viewportY;
  // A marker on a continuation row can be deleted when wider columns merge
  // that row. Anchor the logical line instead; xterm moves its marker through
  // insertions, deletions, and scrollback eviction during reflow.
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  const cellOffset = (buffer.viewportY - start) * term.cols;
  const marker = !following && buffer.type === 'normal'
    ? term.registerMarker(start - buffer.baseY - buffer.cursorY)
    : undefined;
  try {
    const normal = term.buffer.normal;
    if (normal.length > 0) {
      // Narrowing can multiply physical rows. A fixed row cap silently evicts
      // history just because a phone takes over, and widening cannot undo it.
      // Reserve enough rows for existing cells before reflow trims the buffer.
      term.options.scrollback = Math.max(
        term.options.scrollback ?? minimumScrollback,
        // Round per source row; separate hard lines cannot share leftover
        // cells, and a wide character may leave the last column empty.
        normal.length * (cols < term.cols ? Math.ceil(term.cols / Math.max(1, cols - 1)) : 1),
      );
    }
    term.resize(cols, rows);
    term.options.scrollback = Math.max(minimumScrollback, term.buffer.normal.baseY);
    if (following) {
      term.scrollToBottom();
    } else if (marker && !marker.isDisposed) {
      let top = marker.line;
      const offsetRows = Math.floor(cellOffset / cols);
      for (let i = 0; i < offsetRows && term.buffer.active.getLine(top + 1)?.isWrapped; i++) top++;
      term.scrollToLine(top);
    }
  } finally {
    marker?.dispose();
  }
}
