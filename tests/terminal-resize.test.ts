import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { resizeTerminalPreservingScroll } from '../src/web/terminalResize';

const write = (term: Terminal, data: string) => new Promise<void>(resolve => term.write(data, resolve));
const top = (term: Terminal) => term.buffer.active.getLine(term.buffer.active.viewportY)?.translateToString(true);

describe('terminal resize while reading history', () => {
  it('does not evict already loaded history when a phone multiplies wrapped rows', async () => {
    const term = new Terminal({ cols: 100, rows: 10, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, Array.from({ length: 100 }, (_, i) => `ROW ${i} ${'中abc'.repeat(17)}\r\n`).join(''));
      const oldest = term.buffer.normal.getLine(0)?.translateToString(true);
      term.scrollToLine(10);
      const passage = top(term)?.match(/^ROW \d+/)?.[0];
      for (const [cols, rows] of [[21, 8], [50, 15], [100, 10]]) {
        resizeTerminalPreservingScroll(term, cols, rows, false, 100);
        expect(term.buffer.normal.getLine(0)?.translateToString(true), `cols ${cols}, length ${term.buffer.normal.length}, base ${term.buffer.normal.baseY}`).toMatch(/^ROW 0 /);
        expect(top(term)).toContain(passage);
      }
      expect(term.buffer.normal.getLine(0)?.translateToString(true)).toBe(oldest);
      expect(term.options.scrollback).toBe(100);
    } finally { term.dispose(); }
  });

  it('retains the passage through desktop, phone, and desktop reflow', async () => {
    const term = new Terminal({ cols: 95, rows: 38, scrollback: 10000, allowProposedApi: true });
    try {
      await write(term, Array.from({ length: 1200 }, (_, i) => `ROW ${i} | ${'word '.repeat(27)}\r\n`).join(''));
      term.scrollToLine(2200);
      const passage = top(term)?.match(/^ROW \d+/)?.[0];
      expect(passage).toBeTruthy();
      for (const [cols, rows] of [[50, 26], [31, 28], [95, 38]]) {
        resizeTerminalPreservingScroll(term, cols, rows, false);
        expect(top(term)).toContain(passage);
        expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY);
        expect(term.markers).toHaveLength(0);
      }
    } finally { term.dispose(); }
  });

  it('keeps a wrapped continuation near the top when it merges into a wider row', async () => {
    const term = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    try {
      await write(term, Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, '0')}:${'abcdefghij'.repeat(6)}\r\n`).join(''));
      term.scrollToLine(41); // second physical row of logical line 10
      resizeTerminalPreservingScroll(term, 80, 8, false);
      expect(top(term)).toMatch(/^10:/);
      expect(term.markers).toHaveLength(0);
    } finally { term.dispose(); }
  });

  it('follows live output through resize when the reader was following', async () => {
    const term = new Terminal({ cols: 80, rows: 20, allowProposedApi: true });
    try {
      await write(term, 'a long line '.repeat(1000));
      resizeTerminalPreservingScroll(term, 30, 10, true);
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
      resizeTerminalPreservingScroll(term, 100, 30, true);
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY);
    } finally { term.dispose(); }
  });
});
