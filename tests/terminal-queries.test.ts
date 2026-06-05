import { describe, expect, it } from 'vitest';
import { protectStatusLineRedraws, stripDeviceQueries } from '../src/web/terminalQueries.js';

describe('terminal escape preprocessing', () => {
  it('keeps short in-viewport status line redraws unchanged', () => {
    const seq = '\x1b[s\x1b[10;1H\x1b[2K\x1b[7mready\x1b[0m\x1b[u';

    expect(protectStatusLineRedraws(seq, 80, 24)).toBe(seq);
  });

  it('disables autowrap around stale-width saved-cursor status redraws', () => {
    const body = `\x1b[7m${'Claude streaming response... '.repeat(6)}\x1b[0m`;
    const seq = `before\x1b[s\x1b[50;1H\x1b[2K${body}\x1b[uafter`;

    expect(protectStatusLineRedraws(seq, 80, 24)).toBe(
      `before\x1b[s\x1b[50;1H\x1b[2K\x1b[?7l${body}\x1b[?7h\x1b[uafter`,
    );
  });

  it('strips replayed terminal device queries', () => {
    expect(stripDeviceQueries('a\x1b[6nb\x1b[>0cc\x1b]10;?\x07d')).toBe('abcd');
  });
});
