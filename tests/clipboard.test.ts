import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { syncClipboardImageToRemote } from '../src/server/clipboard.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('clipboard image sync', () => {
  it('does not create a fallback file when the remote clipboard accepts the image bytes', async () => {
    const sessionId = `clipboard-memory-${Date.now()}`;
    const result = await syncClipboardImageToRemote(sessionId, 'image/png', PNG_1X1, {
      setRemoteImageClipboard: async () => true,
    });

    expect(result).toEqual({ ok: true, mode: 'remote-clipboard' });
    expect(existsSync(join(homedir(), '.swarmie', 'clipboard', sessionId))).toBe(false);
  });
});
