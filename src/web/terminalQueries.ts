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

/** Remove device query/report sequences from a binary (latin1) string. */
export function stripDeviceQueries(binary: string): string {
  return binary
    .replace(DSR_QUERY, '')
    .replace(DA_QUERY, '')
    .replace(OSC_COLOR_QUERY, '');
}
