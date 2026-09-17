import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { TerminalUtf8Decoder } from '../src/web/base64.js';

describe('terminal UTF-8 streaming', () => {
  const text = '• 中文🙂 ─ ⠀ 𐀀 end';
  const binary = Buffer.from(text).toString('latin1');

  it('preserves every codepoint at every two-chunk boundary', () => {
    for (let split = 0; split <= binary.length; split++) {
      const decoder = new TerminalUtf8Decoder();
      expect(decoder.write(binary.slice(0, split)) + decoder.write(binary.slice(split))).toBe(text);
    }
  });

  it('renders one-byte writes without losing characters or shifting subsequent text', async () => {
    const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    const decoder = new TerminalUtf8Decoder();
    try {
      for (const byte of binary) term.write(decoder.write(byte));
      await new Promise<void>((resolve) => term.write('', resolve));
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(text);
      term.write('\r\x1b[2C!');
      await new Promise<void>((resolve) => term.write('', resolve));
      expect(term.buffer.active.getLine(0)?.translateToString(true).startsWith('• !')).toBe(true);
    } finally {
      term.dispose();
    }
  });

  it('keeps a character split at the history replay byte budget', () => {
    const decoder = new TerminalUtf8Decoder();
    const input = 'x'.repeat(16382) + Buffer.from('• done').toString('latin1');
    expect(decoder.write(input.slice(0, 16384)) + decoder.write(input.slice(16384)))
      .toBe('x'.repeat(16382) + '• done');
  });

  it('discards an unfinished old stream when a resync or history rebuild begins', () => {
    const decoder = new TerminalUtf8Decoder();
    expect(decoder.write('\xe2\x80')).toBe('');
    decoder.reset();
    expect(decoder.write(Buffer.from('新内容').toString('latin1'))).toBe('新内容');
  });
});
