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

// Alternate-screen switch sequences. Full-screen programs (tmux, vim, less,
// htop, man, …) enter the "alternate screen" buffer, which in xterm.js has NO
// scrollback — lines that scroll off its top are discarded, so the mouse wheel
// has nothing to reveal there (and xterm turns the wheel into arrow keys, which
// inside tmux cycles the shell's command history). Stripping these switches
// keeps such programs drawing in the NORMAL buffer instead, where scrolled-off
// lines fall into the 100k-line scrollback and the wheel scrolls back through
// them — the same effect as iTerm's "Save lines to scrollback in alternate
// screen mode". We CANNOT tell which program it is: it may be tmux on a remote
// host reached over ssh, and the byte stream only carries the generic switch,
// never the program identity. So — exactly like iTerm's option — this applies
// to EVERY full-screen app alike, not just tmux.
//
// Covers the three DECSET variants: 1049 (save-cursor + switch + clear), 1047
// (switch + clear), and the bare 47 (switch). Their matching reset (…l) forms
// are stripped too so a program's exit doesn't try to restore/clear the alt
// buffer — its final screen simply stays in the normal buffer's scrollback.
const ALT_SCREEN_TOGGLE = /\x1b\[\?(?:1049|1047|47)[hl]/g;
const ALT_SCREEN_TOGGLES = [
  '\x1b[?1049h',
  '\x1b[?1049l',
  '\x1b[?1047h',
  '\x1b[?1047l',
  '\x1b[?47h',
  '\x1b[?47l',
] as const;

/**
 * Remove alternate-screen switches so full-screen apps render into the normal
 * buffer and their scrolled-off lines land in xterm's scrollback (see above).
 */
export function stripAlternateScreen(binary: string): string {
  if (binary.indexOf('\x1b') === -1) return binary;
  return binary.replace(ALT_SCREEN_TOGGLE, '');
}

/**
 * Stateful alternate-screen filter for a streamed terminal byte sequence.
 *
 * PTY and WebSocket chunk boundaries are arbitrary: `ESC[?1049h` can arrive as
 * `ESC[?10` followed by `49h`. Applying stripAlternateScreen() independently to
 * those chunks lets xterm join the two halves itself and enter the alternate
 * buffer, whose scrolled-off rows have no history. Keep only a suffix that can
 * still become one of the toggles, then decide it when the next chunk arrives.
 */
export class AlternateScreenStreamFilter {
  private carry = '';

  write(binary: string, enabled = true): string {
    if (!enabled) {
      const out = this.carry + binary;
      this.carry = '';
      return out;
    }

    const combined = this.carry + binary;
    this.carry = '';
    let carryLength = 0;
    const max = Math.min(
      combined.length,
      Math.max(...ALT_SCREEN_TOGGLES.map((toggle) => toggle.length - 1)),
    );
    for (let length = max; length > 0; length--) {
      const suffix = combined.slice(-length);
      if (ALT_SCREEN_TOGGLES.some((toggle) => toggle.startsWith(suffix))) {
        carryLength = length;
        break;
      }
    }
    if (carryLength > 0) {
      this.carry = combined.slice(-carryLength);
    }
    const ready = carryLength > 0 ? combined.slice(0, -carryLength) : combined;
    return stripAlternateScreen(ready);
  }

  reset(): void {
    this.carry = '';
  }
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
