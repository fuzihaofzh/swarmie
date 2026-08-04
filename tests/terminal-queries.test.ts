import { describe, expect, it } from 'vitest';
import { protectStatusLineRedraws, stripDeviceQueries, stripAlternateScreen } from '../src/web/terminalQueries.js';

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

  it('strips alternate-screen switches so full-screen output stays in scrollback', () => {
    // enter (1049h) … content … leave (1049l) → both switches removed
    expect(stripAlternateScreen('\x1b[?1049hHELLO\x1b[?1049l')).toBe('HELLO');
    // legacy 1047 and bare 47 variants, enter + leave
    expect(stripAlternateScreen('\x1b[?1047hx\x1b[?1047l')).toBe('x');
    expect(stripAlternateScreen('\x1b[?47hy\x1b[?47l')).toBe('y');
  });

  it('leaves the save/restore-cursor (1048) and other DEC modes untouched', () => {
    // 1048 (save cursor) and 25 (cursor visibility) must survive — only the
    // buffer-switch modes are stripped.
    const seq = '\x1b[?1048h\x1b[?25lvim\x1b[?25h\x1b[?1048l';
    expect(stripAlternateScreen(seq)).toBe(seq);
  });

  it('returns input unchanged when there is no escape byte', () => {
    expect(stripAlternateScreen('plain text, no escapes')).toBe('plain text, no escapes');
  });
});
