import { describe, expect, it } from 'vitest';
import { HeadlessScreen } from '../src/adapters/screen.js';

interface InternalHeadlessTerminal {
  _core: {
    _writeBuffer: {
      writeSync(data: string): void;
    };
  };
}

function internalTerm(screen: HeadlessScreen): InternalHeadlessTerminal {
  return (screen as unknown as { term: InternalHeadlessTerminal }).term;
}

describe('HeadlessScreen', () => {
  it('normalizes unsafe dimensions before giving them to xterm', () => {
    const screen = new HeadlessScreen(Number.NaN, Number.POSITIVE_INFINITY);

    expect(screen.cols).toBe(80);
    expect(screen.rows).toBe(24);

    expect(() => screen.resize(Number.NaN, Number.NEGATIVE_INFINITY)).not.toThrow();
    expect(screen.cols).toBe(80);
    expect(screen.rows).toBe(24);

    screen.resize(10.8, 2.9);
    expect(screen.cols).toBe(20);
    expect(screen.rows).toBe(5);

    screen.resize(5000, 5000);
    expect(screen.cols).toBe(1000);
    expect(screen.rows).toBe(300);

    screen.dispose();
  });

  it('recovers when xterm synchronous writes throw from a bad internal state', () => {
    const screen = new HeadlessScreen(80, 24);
    const brokenTerm = internalTerm(screen);

    brokenTerm._core._writeBuffer.writeSync = () => {
      throw new TypeError('xterm buffer state is broken');
    };

    expect(() => screen.write('hello')).not.toThrow();

    expect(internalTerm(screen)).not.toBe(brokenTerm);
    expect(screen.getViewportText()).toContain('hello');

    screen.dispose();
  });
});
