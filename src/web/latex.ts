/**
 * LaTeX detection + KaTeX rendering for the terminal math-overlay feature.
 *
 * Detection is intentionally CONSERVATIVE: a terminal is full of `$` (shell
 * prompts, `$PATH`, prices like `$5`), so single-`$` inline math is only
 * accepted when the content carries a strong math signal (`\`, `^`, `_`, `{`,
 * `}`). The explicit LaTeX delimiters (`$$…$$`, `\[…\]`, `\(…\)`) are far less
 * ambiguous and are accepted on their own (KaTeX still has to render them).
 *
 * Everything here is pure string→data except renderMath(), so the scanner is
 * unit-testable without a DOM.
 */
import katex from 'katex';

export interface MathSpan {
  /** Column index (0-based) of the first delimiter char in the source line. */
  start: number;
  /** Column index one past the last delimiter char. */
  end: number;
  /** The LaTeX source between the delimiters (trimmed of surrounding spaces). */
  tex: string;
  /** Display (block) vs inline math. */
  display: boolean;
}

/**
 * A math item located within a window of terminal lines. Coordinates are
 * relative to the provided `lines` array. A block (`$$…$$`, `\[…\]`) may span
 * multiple lines (startLine !== endLine).
 */
export interface MathItem {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  tex: string;
  display: boolean;
}

// A single-`$` span must look like math, not shell noise (`$PATH`, `$5`, prices,
// `$ a sentence $`). Accept it if it carries a real LaTeX signal OR is a lone
// variable like `$C$` / `$H$` (extremely common in real math) — but NOT a
// multi-letter bareword (`$PATH`) or a bare number (`$5`).
const SINGLE_VARIABLE = /^[A-Za-z]$/;
// Characters that strongly indicate math: LaTeX commands, sub/superscripts,
// braces, relations, grouping, bars (|H|), operators. Their presence (in
// non-prose content) is enough to treat a `$…$` as an equation.
const MATH_CHARS = /[\\^_{}=<>+*/|()[\]~≤≥≠]/;
// CJK / fullwidth text — real inline math is ASCII (Greek comes via \commands),
// so any of these means we grabbed prose, not an equation.
const CJK_TEXT = /[⺀-鿿　-〿＀-￯]/;

function looksLikeInlineMath(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (CJK_TEXT.test(t)) return false;
  if (SINGLE_VARIABLE.test(t)) return true;       // $H$, $x$
  if (/^\d+(\.\d+)?$/.test(t)) return false;       // pure number / price ($5, $10.50)
  if (/^[A-Za-z]{2,}$/.test(t)) return false;      // bareword / shell var ($PATH, $HOME)
  return MATH_CHARS.test(t);                        // |H|, f(x), x^2, a<b, [a,b], \alpha
}
// Upper bound so a stray unmatched delimiter can't swallow a whole long line.
const MAX_TEX_LEN = 240;
// Blocks (display math) may legitimately be longer than an inline span.
const MAX_BLOCK_TEX_LEN = 2000;

function pushSpan(spans: MathSpan[], start: number, end: number, raw: string, display: boolean): void {
  const tex = raw.trim();
  if (tex.length === 0 || tex.length > MAX_TEX_LEN) return;
  spans.push({ start, end, tex, display });
}

/**
 * Find non-overlapping math spans in a single line of terminal text, scanning
 * left→right. Explicit delimiters win over a bare `$`.
 */
export function detectMathSpans(line: string): MathSpan[] {
  const spans: MathSpan[] = [];
  const n = line.length;
  let i = 0;

  while (i < n) {
    const c = line[i];

    // $$ … $$  (display)
    if (c === '$' && line[i + 1] === '$') {
      const close = line.indexOf('$$', i + 2);
      if (close !== -1) {
        pushSpan(spans, i, close + 2, line.slice(i + 2, close), true);
        i = close + 2;
        continue;
      }
      // No closing $$ on this line — skip both chars so a lone $$ (e.g. shell
      // `echo $$`) doesn't get reinterpreted as the start of a single-$ span.
      i += 2;
      continue;
    }

    // \[ … \]  (display)   and   \( … \)  (inline)
    if (c === '\\' && (line[i + 1] === '[' || line[i + 1] === '(')) {
      const display = line[i + 1] === '[';
      const closeTok = display ? '\\]' : '\\)';
      const close = line.indexOf(closeTok, i + 2);
      if (close !== -1) {
        pushSpan(spans, i, close + 2, line.slice(i + 2, close), display);
        i = close + 2;
        continue;
      }
    }

    // $ … $  (inline) — only with a strong math signal.
    if (c === '$') {
      let close = -1;
      for (let j = i + 1; j < n; j++) {
        if (line[j] === '$') { close = j; break; }
      }
      if (close !== -1 && close > i + 1) {
        const inner = line.slice(i + 1, close);
        if (looksLikeInlineMath(inner)) {
          pushSpan(spans, i, close + 1, inner, false);
          i = close + 1;
          continue;
        }
      }
    }

    i += 1;
  }

  return spans;
}

// Rendered-HTML cache keyed by `${display ? 'D' : 'I'}:${tex}` so repeated
// formulas (a redrawing TUI re-emits the same line constantly) don't re-run
// KaTeX. `null` means KaTeX rejected it — cached too, so we don't retry.
const renderCache = new Map<string, string | null>();
const MAX_CACHE = 500;

/** Render LaTeX to an HTML string, or null if KaTeX can't render it. */
export function renderMath(tex: string, display: boolean): string | null {
  const key = `${display ? 'D' : 'I'}:${tex}`;
  const cached = renderCache.get(key);
  if (cached !== undefined) return cached;

  let html: string | null = null;
  try {
    html = katex.renderToString(tex, {
      displayMode: display,
      // Best-effort: a single bad token (often upstream markdown eating LaTeX,
      // e.g. `\_`/`\;` stripped) renders in red instead of failing the whole
      // formula. Detection (looksLikeInlineMath) is the real false-positive gate.
      throwOnError: false,
      output: 'html',
      strict: 'ignore', // don't spam the console for benign non-strict input
    });
  } catch {
    html = null;
  }

  if (renderCache.size >= MAX_CACHE) renderCache.clear();
  renderCache.set(key, html);
  return html;
}

/** Test-only: reset the render cache. */
export function _clearRenderCache(): void {
  renderCache.clear();
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji / symbols
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK extension B+
  );
}

/**
 * Terminal cell width of a string. CJK/fullwidth/emoji glyphs occupy 2 cells,
 * so a character index in the line text is NOT the terminal column — overlay
 * positioning must convert through this.
 */
export function cellWidthOf(s: string): number {
  let w = 0;
  for (const ch of s) w += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

interface Region {
  openLine: number; openCol: number;   // col of the first delimiter char
  closeLine: number; closeCol: number; // col one past the last delimiter char
}

/**
 * Find delimiter-paired regions across a window of lines. Works for symmetric
 * delimiters (`$$`/`$$`) and directional ones (`\[`/`\]`): scan for an opener,
 * then the next closer (possibly on a later line), pair them, continue.
 */
function findBlocks(lines: string[], openTok: string, closeTok: string): Region[] {
  const regions: Region[] = [];
  let li = 0;
  let col = 0;
  while (li < lines.length) {
    const openIdx = lines[li].indexOf(openTok, col);
    if (openIdx === -1) { li += 1; col = 0; continue; }
    // Find the closing token, starting just after the opener.
    let cli = li;
    let from = openIdx + openTok.length;
    let closeIdx = -1;
    while (cli < lines.length) {
      const idx = lines[cli].indexOf(closeTok, from);
      if (idx !== -1) { closeIdx = idx; break; }
      cli += 1;
      from = 0;
    }
    if (closeIdx === -1) break; // unterminated within the window
    regions.push({ openLine: li, openCol: openIdx, closeLine: cli, closeCol: closeIdx + closeTok.length });
    li = cli;
    col = closeIdx + closeTok.length;
  }
  return regions;
}

function blockTex(lines: string[], r: Region, openLen: number, closeLen: number): string {
  if (r.openLine === r.closeLine) {
    return lines[r.openLine].slice(r.openCol + openLen, r.closeCol - closeLen).trim();
  }
  const parts: string[] = [lines[r.openLine].slice(r.openCol + openLen)];
  for (let li = r.openLine + 1; li < r.closeLine; li++) parts.push(lines[li]);
  parts.push(lines[r.closeLine].slice(0, r.closeCol - closeLen));
  return parts.join(' ').trim();
}

// Blank out a region's columns in the masked copy so the later inline pass
// doesn't re-detect delimiters that already belong to a block.
function blankRegion(masked: string[], r: Region): void {
  const blank = (li: number, a: number, b: number) => {
    const s = masked[li];
    masked[li] = s.slice(0, a) + ' '.repeat(Math.max(0, b - a)) + s.slice(b);
  };
  if (r.openLine === r.closeLine) { blank(r.openLine, r.openCol, r.closeCol); return; }
  blank(r.openLine, r.openCol, masked[r.openLine].length);
  for (let li = r.openLine + 1; li < r.closeLine; li++) blank(li, 0, masked[li].length);
  blank(r.closeLine, 0, r.closeCol);
}

/**
 * Detect all math in a window of terminal lines, including DISPLAY blocks that
 * span multiple lines (`$$ … $$`, `\[ … \]`). Coordinates are relative to the
 * provided array. Inline math (`$…$`, `\(…\)`) and single-line blocks are also
 * returned. Block delimiters are matched first, then masked out before the
 * per-line inline scan, so nothing is double-counted.
 */
export function detectMath(lines: string[]): MathItem[] {
  const items: MathItem[] = [];
  const masked = lines.slice();

  const blockDelims: Array<[string, string]> = [['$$', '$$'], ['\\[', '\\]']];
  for (const [open, close] of blockDelims) {
    for (const r of findBlocks(masked, open, close)) {
      const tex = blockTex(masked, r, open.length, close.length);
      // Require a real math character so two stray shell `$$` (the PID variable)
      // on separate lines don't get paired into a bogus block.
      if (tex && tex.length <= MAX_BLOCK_TEX_LEN && MATH_CHARS.test(tex)) {
        items.push({
          startLine: r.openLine, startCol: r.openCol,
          endLine: r.closeLine, endCol: r.closeCol,
          tex, display: true,
        });
      }
      blankRegion(masked, r); // remove from the masked text before the next delim + inline pass
    }
  }

  for (let li = 0; li < masked.length; li++) {
    const t = masked[li];
    if (t.indexOf('$') === -1 && t.indexOf('\\') === -1) continue;
    for (const s of detectMathSpans(t)) {
      items.push({ startLine: li, startCol: s.start, endLine: li, endCol: s.end, tex: s.tex, display: s.display });
    }
  }

  return items;
}
