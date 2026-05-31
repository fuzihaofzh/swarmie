import { describe, expect, it } from 'vitest';
import {
  clearTerminalBuffer,
  registerTerminalWriter,
  unregisterTerminalWriter,
  writeToTerminal,
} from '../src/web/terminalBus.js';

function b64(size: number, fill: number): string {
  return Buffer.alloc(size, fill).toString('base64');
}

describe('terminalBus', () => {
  it('delivers buffered output when a writer registers', () => {
    const sessionId = 'terminal-bus-flush';
    const first = b64(16, 65);
    const second = b64(16, 66);
    const received: string[] = [];

    try {
      expect(writeToTerminal(sessionId, first)).toBe(false);
      expect(writeToTerminal(sessionId, second)).toBe(false);

      registerTerminalWriter(sessionId, (chunk) => received.push(chunk));

      expect(received).toEqual([first, second]);
    } finally {
      clearTerminalBuffer(sessionId);
    }
  });

  it('caps buffered output while no writer is registered', () => {
    const sessionId = 'terminal-bus-cap';
    const oldChunk = b64(384 * 1024, 65);
    const latestChunk = b64(384 * 1024, 66);
    const received: string[] = [];

    try {
      expect(writeToTerminal(sessionId, oldChunk)).toBe(false);
      expect(writeToTerminal(sessionId, latestChunk)).toBe(false);

      registerTerminalWriter(sessionId, (chunk) => received.push(chunk));

      expect(received).toEqual([latestChunk]);
    } finally {
      clearTerminalBuffer(sessionId);
    }
  });

  it('does not buffer while a writer is registered', () => {
    const sessionId = 'terminal-bus-live';
    const chunk = b64(16, 67);
    const received: string[] = [];

    try {
      registerTerminalWriter(sessionId, (incoming) => received.push(incoming));

      expect(writeToTerminal(sessionId, chunk)).toBe(true);
      unregisterTerminalWriter(sessionId);
      registerTerminalWriter(sessionId, (incoming) => received.push(incoming));

      expect(received).toEqual([chunk]);
    } finally {
      clearTerminalBuffer(sessionId);
    }
  });

  it('does not let a stale unregister remove a newer writer', () => {
    const sessionId = 'terminal-bus-stale-unregister';
    const chunk = b64(16, 68);
    const received: string[] = [];
    const staleWriter = (incoming: string) => received.push(`stale:${incoming}`);
    const currentWriter = (incoming: string) => received.push(`current:${incoming}`);

    try {
      registerTerminalWriter(sessionId, staleWriter);
      registerTerminalWriter(sessionId, currentWriter);
      unregisterTerminalWriter(sessionId, staleWriter);

      expect(writeToTerminal(sessionId, chunk)).toBe(true);
      expect(received).toEqual([`current:${chunk}`]);
    } finally {
      clearTerminalBuffer(sessionId);
    }
  });
});
