import { describe, expect, it } from 'vitest';
import {
  clearTerminalBuffer,
  registerTerminalWriter,
  unregisterTerminalWriter,
  writeToTerminal,
  getRawCacheStart,
  getRawCacheEnd,
  getRawCacheChunks,
  prependRawCache,
  isRawCacheFull,
  getSessionMeta,
  writeResyncToTerminal,
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

  describe('raw history cache', () => {
    // The cache exists so "load earlier" fetches only the older delta. Its one
    // invariant: it must stay a contiguous run ending at the newest byte seen —
    // a rebuild renders it, so a gap or a missing tail is a corrupt terminal.
    const bin = (size: number, fill: number) => String.fromCharCode(fill).repeat(size);

    it('tracks start and end as output streams in', () => {
      const sessionId = 'raw-cache-track';
      try {
        expect(getRawCacheStart(sessionId)).toBe(null);
        expect(getRawCacheEnd(sessionId)).toBe(null);

        // A client that joins mid-session starts at a non-zero offset.
        writeToTerminal(sessionId, bin(100, 65), 1100);
        expect(getRawCacheStart(sessionId)).toBe(1000);
        expect(getRawCacheEnd(sessionId)).toBe(1100);

        writeToTerminal(sessionId, bin(50, 66), 1150);
        expect(getRawCacheStart(sessionId)).toBe(1000);
        expect(getRawCacheEnd(sessionId)).toBe(1150);
        expect(getRawCacheChunks(sessionId).join('')).toBe(bin(100, 65) + bin(50, 66));
      } finally {
        clearTerminalBuffer(sessionId);
      }
    });

    it('prepends a fetched page and stays contiguous through to the live edge', () => {
      const sessionId = 'raw-cache-prepend';
      try {
        writeToTerminal(sessionId, bin(100, 65), 1100);
        expect(getRawCacheStart(sessionId)).toBe(1000);

        // Server returns the page below the cache start.
        prependRawCache(sessionId, bin(400, 67), 600, 1000);
        expect(getRawCacheStart(sessionId)).toBe(600);
        expect(getRawCacheEnd(sessionId)).toBe(1100);
        expect(getRawCacheChunks(sessionId).join('')).toBe(bin(400, 67) + bin(100, 65));

        // Live output after a page-in still lands at the end.
        writeToTerminal(sessionId, bin(10, 68), 1110);
        expect(getRawCacheStart(sessionId)).toBe(600);
        expect(getRawCacheEnd(sessionId)).toBe(1110);
        expect(getRawCacheChunks(sessionId).join('').length).toBe(510);

        // A second page stacks below the first.
        prependRawCache(sessionId, bin(600, 69), 0, 600);
        expect(getRawCacheStart(sessionId)).toBe(0);
        expect(getRawCacheEnd(sessionId)).toBe(1110);
        expect(getRawCacheChunks(sessionId).join('')).toBe(
          bin(600, 69) + bin(400, 67) + bin(100, 65) + bin(10, 68),
        );
      } finally {
        clearTerminalBuffer(sessionId);
      }
    });

    it('deduplicates overlapping reconnect replay before caching and rendering', () => {
      const sessionId = 'raw-cache-overlap';
      const received: string[] = [];
      try {
        registerTerminalWriter(sessionId, (chunk) => received.push(chunk));
        writeToTerminal(sessionId, 'abcdefghij', 110);
        // [105, 115) overlaps five bytes already seen; only [110, 115) is new.
        writeToTerminal(sessionId, 'fghijklmno', 115, true);
        // A wholly stale retry must not be rendered at all.
        writeToTerminal(sessionId, 'ijklm', 113, true);

        expect(received).toEqual(['abcdefghij', 'klmno']);
        expect(getRawCacheStart(sessionId)).toBe(100);
        expect(getRawCacheEnd(sessionId)).toBe(115);
        expect(getRawCacheChunks(sessionId).join('')).toBe('abcdefghijklmno');
      } finally {
        clearTerminalBuffer(sessionId);
      }
    });

    it('keeps only a contiguous suffix when a forward gap is observed', () => {
      const sessionId = 'raw-cache-gap';
      try {
        writeToTerminal(sessionId, 'old', 103);
        writeToTerminal(sessionId, 'new', 203);

        expect(getRawCacheStart(sessionId)).toBe(200);
        expect(getRawCacheEnd(sessionId)).toBe(203);
        expect(getRawCacheChunks(sessionId).join('')).toBe('new');
        expect(getSessionMeta(sessionId).reachedEarliest).toBe(false);
      } finally {
        clearTerminalBuffer(sessionId);
      }
    });

    it('does not count a resync control prefix as raw session history', () => {
      const sessionId = 'raw-cache-resync';
      const reset = '\x1b[!p\x1b[0m';
      const received: Array<{ data: string; isResync?: boolean }> = [];
      try {
        writeToTerminal(sessionId, 'stale', 105);
        registerTerminalWriter(sessionId, (data, _end, _replay, isResync) => {
          received.push({ data, isResync });
        });
        writeResyncToTerminal(sessionId, reset + 'TAIL', 200, 204);

        expect(received.at(-1)).toEqual({ data: reset + 'TAIL', isResync: true });
        expect(getRawCacheStart(sessionId)).toBe(200);
        expect(getRawCacheEnd(sessionId)).toBe(204);
        expect(getRawCacheChunks(sessionId).join('')).toBe('TAIL');
      } finally {
        clearTerminalBuffer(sessionId);
      }
    });

    it('evicts from the front so the cache always reaches the newest byte', () => {
      const sessionId = 'raw-cache-evict';
      try {
        // Overrun the cap: the tail must survive, the head must go, and
        // startOffset must advance to match what is actually still held.
        const chunk = 1024 * 1024;
        let offset = 0;
        for (let i = 0; i < 30; i++) {
          offset += chunk;
          writeToTerminal(sessionId, bin(chunk, 65 + (i % 26)), offset);
        }
        const start = getRawCacheStart(sessionId);
        const end = getRawCacheEnd(sessionId);
        expect(end).toBe(offset); // still reaches the live edge
        expect(start).toBeGreaterThan(0); // old bytes were dropped
        // startOffset must equal end minus what is actually retained, or a
        // "load earlier" would ask for a range the client already has (or skip
        // one it doesn't).
        const held = getRawCacheChunks(sessionId).join('').length;
        expect((end as number) - (start as number)).toBe(held);
        expect(isRawCacheFull(sessionId)).toBe(true);
      } finally {
        clearTerminalBuffer(sessionId);
      }
    });

    it('is dropped with the session', () => {
      const sessionId = 'raw-cache-clear';
      writeToTerminal(sessionId, bin(10, 65), 10);
      expect(getRawCacheStart(sessionId)).toBe(0);
      clearTerminalBuffer(sessionId);
      expect(getRawCacheStart(sessionId)).toBe(null);
    });
  });
});
