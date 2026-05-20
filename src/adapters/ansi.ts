// Shared ANSI / VT escape-sequence primitives. Centralized so the adapters and
// the debug route strip terminal output identically — they had drifted: the
// CSI matcher in generic.ts omitted the ':' subparameter separator (used by
// truecolor SGR), so it left fragments behind that base.ts stripped.
//
// All exported regexes are `g`-flagged and used with String.replace(), which
// always restarts from index 0, so sharing a single module-level instance
// across callers is safe. Do NOT use these with .exec()/.test() in a loop
// without resetting lastIndex.

export const ESC_CHAR = String.fromCharCode(0x1b);
export const BEL_CHAR = String.fromCharCode(0x07);
export const NUL_CHAR = String.fromCharCode(0x00);
export const US_CHAR = String.fromCharCode(0x1f);

// OSC (Operating System Command): ESC ] ... (BEL | ST)
export const OSC_ANY_RE = new RegExp(`${ESC_CHAR}\\].*?(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`, 'g');
// CSI (Control Sequence Introducer): ESC [ params final. Params may include
// ':' subparameter separators, so keep ':' in the character class.
export const CSI_RE = new RegExp(`${ESC_CHAR}\\[[0-9;:?]*[A-Za-z~]`, 'g');
// Any other two-char ESC sequence.
export const ESC_OTHER_RE = new RegExp(`${ESC_CHAR}[^\\[].?`, 'g');
// C0 control characters.
export const CONTROL_CHARS_RE = new RegExp(`[${NUL_CHAR}-${US_CHAR}]`, 'g');

/** Strip ANSI escapes / control chars to readable, whitespace-normalized text. */
export function stripAnsiToText(text: string): string {
  return text
    .replace(OSC_ANY_RE, ' ')
    .replace(CSI_RE, ' ')
    .replace(ESC_OTHER_RE, ' ')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
