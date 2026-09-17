import { describe, expect, it } from 'vitest';
import { TerminalFrameBuffer } from '../src/web/terminalFrames.js';

const begin = '\x1b[?2026h';
const end = '\x1b[?2026l';
// Codex moves through its status rows before restoring the input cursor.
const frame = `${begin}\x1b[26;8HWorking\x1b[20;1H \x1b[32;3H\x1b[?25h${end}`;

describe('synchronized terminal frames', () => {
  it('never exposes an intermediate cursor position across any PTY split', () => {
    for (let split = 1; split < frame.length; split++) {
      const buffer = new TerminalFrameBuffer();
      expect(buffer.write(frame.slice(0, split)), `split ${split}`).toBe('');
      expect(buffer.write(frame.slice(split))).toBe(frame);
      expect(buffer.hasPending).toBe(false);
    }
  });

  it('releases complete frames and ordinary output without waiting for the next frame', () => {
    const buffer = new TerminalFrameBuffer();
    expect(buffer.write(`shell\r\n${frame}${begin}partial`)).toBe(`shell\r\n${frame}`);
    expect(buffer.write(`rest${end}tail`)).toBe(`${begin}partialrest${end}tail`);
  });

  it('preserves all bytes when fed one at a time', () => {
    const source = `\x1b[31m中文\x1b[0m${frame}${frame}\x1b]0;title\x07`;
    const buffer = new TerminalFrameBuffer();
    expect([...source].map((c) => buffer.write(c)).join('') + buffer.flush()).toBe(source);
  });

  it('allows the timeout to release a missing end marker or a partial escape', () => {
    const buffer = new TerminalFrameBuffer();
    expect(buffer.write(`${begin}unfinished`)).toBe('');
    expect(buffer.flush()).toBe(`${begin}unfinished`);
    expect(buffer.write('ordinary output')).toBe('ordinary output');
    expect(buffer.write('\x1b')).toBe('');
    expect(buffer.flush()).toBe('\x1b');
  });

  it('bounds buffering if an application never closes its frame', () => {
    const buffer = new TerminalFrameBuffer();
    const oversized = begin + 'x'.repeat(1024 * 1024);
    expect(buffer.write(oversized)).toBe(oversized);
    expect(buffer.hasPending).toBe(false);
  });

  it('discards an unfinished old frame at a resync boundary', () => {
    const buffer = new TerminalFrameBuffer();
    buffer.write(`${begin}stale`);
    buffer.reset();
    expect(buffer.write(frame)).toBe(frame);
  });
});
