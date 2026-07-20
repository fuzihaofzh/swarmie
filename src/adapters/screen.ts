import pkg from '@xterm/headless';

const { Terminal } = pkg;

const DEFAULT_SCROLLBACK = 200;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLS = 20;
const MIN_ROWS = 5;
const MAX_COLS = 1000;
const MAX_ROWS = 300;
const WRITE_CHUNK_SIZE = 64 * 1024;

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
  getLine(y: number): { translateToString(trimRight?: boolean): string; isWrapped?: boolean } | undefined;
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
    this._cols = normalizeDimension(cols, MIN_COLS, MAX_COLS, DEFAULT_COLS);
    this._rows = normalizeDimension(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS);
    this.term = this.createTerminal();
  }

  private createTerminal(): HeadlessTerminal {
    return new (Terminal as unknown as new (opts: Record<string, unknown>) => HeadlessTerminal)({
      cols: this._cols,
      rows: this._rows,
      scrollback: DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  private resetTerminal(): void {
    try {
      this.term?.dispose();
    } catch {
      // Best-effort cleanup after xterm entered a bad internal state.
    }
    this.term = this.createTerminal();
  }

  write(chunk: string): void {
    if (!chunk) return;
    for (let offset = 0; offset < chunk.length; offset += WRITE_CHUNK_SIZE) {
      this.writeChunk(chunk.slice(offset, offset + WRITE_CHUNK_SIZE));
    }
  }

  private writeChunk(chunk: string): void {
    try {
      this.writeUnsafe(chunk);
    } catch {
      this.resetTerminal();
      try {
        this.writeUnsafe(chunk);
      } catch {
        this.resetTerminal();
      }
    }
  }

  private writeUnsafe(chunk: string): void {
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
    const c = normalizeDimension(cols, MIN_COLS, MAX_COLS, this._cols);
    const r = normalizeDimension(rows, MIN_ROWS, MAX_ROWS, this._rows);
    if (c === this._cols && r === this._rows) return;
    this._cols = c;
    this._rows = r;
    try {
      this.term.resize(c, r);
    } catch {
      this.resetTerminal();
    }
  }

  /**
   * Text currently visible on screen — the rows of the active buffer (which
   * could be the normal or alt buffer). One line per row, joined by '\n'.
   * Trailing whitespace is trimmed per line.
   */
  getViewportText(): string {
    try {
      const buf = this.term.buffer.active;
      const top = buf.viewportY;
      const out: string[] = [];
      for (let i = 0; i < this._rows; i++) {
        const line = buf.getLine(top + i);
        out.push(line ? line.translateToString(true) : '');
      }
      return out.join('\n');
    } catch {
      this.resetTerminal();
      return '';
    }
  }

  /**
   * Viewport text plus up to `extraScrollback` rows above it — useful when
   * a prompt has scrolled slightly out of view but is still relevant. Capped
   * to whatever the scrollback buffer retains.
   */
  getRecentText(extraScrollback = 20): string {
    try {
      const buf = this.term.buffer.active;
      const top = Math.max(0, buf.viewportY - extraScrollback);
      const bottom = Math.min(buf.length, buf.viewportY + this._rows);
      const out: string[] = [];
      for (let i = top; i < bottom; i++) {
        const line = buf.getLine(i);
        const text = line ? line.translateToString(true) : '';
        // A row the terminal wrapped is a continuation of the row above, not a
        // new line. Detection regexes use '.', which never matches '\n', so a
        // status line like "Working… (23s · esc to interrupt)" would stop
        // matching purely because the terminal was narrow. Rejoin it.
        if (line?.isWrapped && out.length > 0) {
          out[out.length - 1] += text;
        } else {
          out.push(text);
        }
      }
      return out.join('\n');
    } catch {
      this.resetTerminal();
      return '';
    }
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }

  dispose(): void {
    try {
      this.term.dispose();
    } catch {
      // Ignore cleanup failures from an already-corrupt headless terminal.
    }
  }
}

function normalizeDimension(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
