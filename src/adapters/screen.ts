import pkg from '@xterm/headless';

const { Terminal } = pkg;

const DEFAULT_SCROLLBACK = 200;
const MIN_COLS = 20;
const MIN_ROWS = 5;

interface HeadlessWriteBuffer {
  writeSync(data: string): void;
}

interface HeadlessCore {
  _writeBuffer: HeadlessWriteBuffer;
}

interface HeadlessTerminal {
  rows: number;
  cols: number;
  buffer: { active: HeadlessBuffer };
  resize(cols: number, rows: number): void;
  dispose(): void;
  write(data: string, cb?: () => void): void;
  /**
   * Private xterm internals — exposed in the bundled JS even though they're
   * not in the public `.d.ts`. We reach through `_core._writeBuffer.writeSync`
   * because the public `write()` is async (queued via setTimeout) and we
   * need the screen reflected before sampling in `handleActivityDetection`.
   * `Terminal.writeSync` is a thin wrapper around the same call but logs an
   * "unreliable" warning we don't want, so we use the underlying buffer
   * directly.
   */
  _core: HeadlessCore;
}

interface HeadlessBuffer {
  length: number;
  viewportY: number;
  baseY: number;
  getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * Server-side headless terminal that mirrors what the user sees on screen.
 * The detection layer reads from the rendered screen instead of trying to
 * strip ANSI from raw PTY chunks — that's the source of truth for "is the
 * prompt currently visible" once you account for cursor-positioned redraws,
 * alt buffers, animations, and chunk fragmentation.
 *
 * Uses xterm's internal writeSync so detection can read the screen
 * synchronously after a write (the public write() is async via setTimeout).
 */
export class HeadlessScreen {
  private term: HeadlessTerminal;
  private _cols: number;
  private _rows: number;

  constructor(cols: number, rows: number) {
    this._cols = Math.max(MIN_COLS, cols);
    this._rows = Math.max(MIN_ROWS, rows);
    this.term = new (Terminal as unknown as new (opts: Record<string, unknown>) => HeadlessTerminal)({
      cols: this._cols,
      rows: this._rows,
      scrollback: DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  write(chunk: string): void {
    if (!chunk) return;
    // Sync write so the buffer reflects this chunk before we return —
    // detection samples the screen on the same tick.
    const wb = this.term._core?._writeBuffer;
    if (wb && typeof wb.writeSync === 'function') {
      wb.writeSync(chunk);
    } else {
      this.term.write(chunk);
    }
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(MIN_COLS, cols);
    const r = Math.max(MIN_ROWS, rows);
    if (c === this._cols && r === this._rows) return;
    this._cols = c;
    this._rows = r;
    this.term.resize(c, r);
  }

  /**
   * Text currently visible on screen — the rows of the active buffer (which
   * could be the normal or alt buffer). One line per row, joined by '\n'.
   * Trailing whitespace is trimmed per line.
   */
  getViewportText(): string {
    const buf = this.term.buffer.active;
    const top = buf.viewportY;
    const out: string[] = [];
    for (let i = 0; i < this._rows; i++) {
      const line = buf.getLine(top + i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out.join('\n');
  }

  /**
   * Viewport text plus up to `extraScrollback` rows above it — useful when
   * a prompt has scrolled slightly out of view but is still relevant. Capped
   * to whatever the scrollback buffer retains.
   */
  getRecentText(extraScrollback = 20): string {
    const buf = this.term.buffer.active;
    const top = Math.max(0, buf.viewportY - extraScrollback);
    const bottom = Math.min(buf.length, buf.viewportY + this._rows);
    const out: string[] = [];
    for (let i = top; i < bottom; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : '');
    }
    return out.join('\n');
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  dispose(): void {
    this.term.dispose();
  }
}
