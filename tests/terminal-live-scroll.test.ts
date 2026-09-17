import { expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';

it('renders new output while retaining the visible history, including buffer eviction', async () => {
  const term = new Terminal({ cols: 40, rows: 5, scrollback: 100, scrollOnOutput: false, allowProposedApi: true });
  const write = (data: string) => new Promise<void>(resolve => term.write(data, resolve));
  const visible = () => Array.from({ length: term.rows }, (_, i) =>
    term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true));
  try {
    await write(Array.from({ length: 80 }, (_, i) => `line ${i}\r\n`).join(''));
    term.scrollToLine(50);
    const before = visible();
    const previousBottom = term.buffer.active.baseY;
    await write(Array.from({ length: 10 }, (_, i) => `new ${i}\r\n`).join(''));
    expect(term.buffer.active.baseY).toBeGreaterThan(previousBottom);
    expect(visible()).toEqual(before);
    await write(Array.from({ length: 30 }, (_, i) => `tail ${i}\r\n`).join(''));
    expect(term.buffer.active.baseY).toBe(100);
    expect(visible()).toEqual(before);
    term.scrollToBottom();
    expect(visible().join('\n')).toContain('tail 29');
  } finally {
    term.dispose();
  }
});
