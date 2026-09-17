import { afterEach, describe, expect, it } from 'vitest';
import pkg from '@xterm/headless';
import { clearTerminalSize, getTerminalSize, setTerminalSize, subscribeTerminalSize } from '../src/web/terminalSize';

const { Terminal } = pkg;
const id = 'shared-grid';

afterEach(() => clearTerminalSize(id));

describe('shared terminal grid', () => {
  it('keeps desktop and phone cursor-positioned output identical across resize and reload', async () => {
    const desktop = new Terminal({ cols: 140, rows: 45, allowProposedApi: true });
    const phone = new Terminal({ cols: 35, rows: 18, allowProposedApi: true });
    const disposeDesktop = subscribeTerminalSize(id, ({ cols, rows }) => desktop.resize(cols, rows));
    const disposePhone = subscribeTerminalSize(id, ({ cols, rows }) => phone.resize(cols, rows));
    const write = (term: InstanceType<typeof Terminal>, data: string) => new Promise<void>((resolve) => term.write(data, resolve));
    try {
      setTerminalSize(id, { cols: 35, rows: 18 });
      const frame = '\x1b[2J\x1b[H中文完整显示\x1b[3;1HL' + '.'.repeat(33) + 'R\x1b[18;1HBOTTOM';
      await Promise.all([write(desktop, frame), write(phone, frame)]);
      for (let row = 0; row < 18; row++) {
        expect(desktop.buffer.active.getLine(row)?.translateToString(true))
          .toBe(phone.buffer.active.getLine(row)?.translateToString(true));
      }
      expect(desktop.buffer.active.getLine(2)?.translateToString(true)).toBe('L' + '.'.repeat(33) + 'R');
      expect(desktop.buffer.active.getLine(17)?.translateToString(true)).toBe('BOTTOM');

      // A freshly mounted viewer learns the grid before replay starts.
      const reloaded = new Terminal({ cols: 140, rows: 45, allowProposedApi: true });
      const disposeReloaded = subscribeTerminalSize(id, ({ cols, rows }) => reloaded.resize(cols, rows));
      try {
        expect(reloaded.cols).toBe(35);
        await write(reloaded, frame);
        expect(reloaded.buffer.active.getLine(17)?.translateToString(true)).toBe('BOTTOM');
      } finally {
        disposeReloaded();
        reloaded.dispose();
      }
      disposePhone();
      setTerminalSize(id, { cols: 140, rows: 45 });
      expect(desktop.cols).toBe(140);
      expect(desktop.rows).toBe(45);
    } finally {
      disposeDesktop();
      disposePhone();
      desktop.dispose();
      phone.dispose();
    }
  });

  it('rejects invalid grids and forgets removed sessions', () => {
    setTerminalSize(id, { cols: 80, rows: 24 });
    setTerminalSize(id, { cols: NaN, rows: 24 });
    setTerminalSize(id, { cols: 80, rows: -2 });
    expect(getTerminalSize(id)).toEqual({ cols: 80, rows: 24 });
    clearTerminalSize(id);
    expect(getTerminalSize(id)).toBeUndefined();
  });
});
