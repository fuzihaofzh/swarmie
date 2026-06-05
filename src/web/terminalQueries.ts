// Device query / report escape sequences.
//
// Replayed history contains the queries the running tool emitted over the
// session's lifetime — cursor-position reports (DSR), device attributes (DA),
// and OSC color queries that shell prompts like powerlevel10k fire on every
// render. When xterm re-parses replayed output it ANSWERS those queries, and
// we forward the answers into the live PTY — where an idle shell echoes them
// as garbage (";1R1;2c10;rgb:...") that piles up over reconnects.
//
// Strip the queries from REPLAYED output only so xterm never generates the
// stale answers. Live output is left untouched so interactive apps still get
// real responses. The patterns are pure ASCII (final byte n / c, or an OSC
// "?" payload) and never collide with UTF-8 continuation bytes (>= 0x80), so
// running this over a binary (latin1) string is safe.
const DSR_QUERY = /\x1b\[[?0-9;]*n/g; // ESC[6n cursor position, ESC[5n status
const DA_QUERY = /\x1b\[[?>=0-9;]*c/g; // ESC[c / ESC[>c device attributes
const OSC_COLOR_QUERY = /\x1b\][0-9;]*;\?(?:\x07|\x1b\\)/g; // OSC 10/11/4;n ";?" color queries
const ANSI_CONTROL = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-~]/g;
const NON_PRINTING_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// Programs like claudemonitor often repaint a private status line with:
//   save cursor -> absolute row/col -> clear line -> write padded status -> restore cursor
// If they cached an older terminal width, a later web viewer with fewer cols
// will wrap that padded status line at the bottom and turn every repaint into
// scrollback. Keep those repaint blocks single-line in the browser renderer.
const SAVED_CURSOR_LINE_REDRAW =
  /((?:\x1b\[s|\x1b7)\x1b\[(\d+);1[Hf]\x1b\[2K)([\s\S]*?)((?:\x1b\[u|\x1b8))/g;

/** Remove device query/report sequences from a binary (latin1) string. */
export function stripDeviceQueries(binary: string): string {
  return binary
    .replace(DSR_QUERY, '')
    .replace(DA_QUERY, '')
    .replace(OSC_COLOR_QUERY, '');
}

function visibleByteLength(binary: string): number {
  return binary
    .replace(ANSI_CONTROL, '')
    .replace(NON_PRINTING_CONTROL, '')
    .length;
}

/**
 * Prevent stale-width status-line redraws from wrapping in the browser xterm.
 *
 * This only touches save/absolute-line/clear/restore repaint blocks that would
 * overflow the current xterm viewport. The live PTY bytes remain unchanged.
 */
export function protectStatusLineRedraws(binary: string, cols: number, rows: number): string {
  if (!binary.includes('\x1b')) return binary;
  const width = Math.max(1, Math.floor(cols || 80));
  const height = Math.max(1, Math.floor(rows || 24));

  return binary.replace(SAVED_CURSOR_LINE_REDRAW, (match, prefix, rowText, body, restore) => {
    const row = Number(rowText);
    if (Number.isFinite(row) && row <= height && visibleByteLength(body) < width) {
      return match;
    }
    return `${prefix}\x1b[?7l${body}\x1b[?7h${restore}`;
  });
}
