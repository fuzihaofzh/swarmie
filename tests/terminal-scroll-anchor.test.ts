import { describe, expect, it } from 'vitest';
import {
  captureTerminalScrollAnchor,
  nextTerminalFollowState,
  resolveTerminalScrollAnchor,
} from '../src/web/terminalScrollAnchor.js';

function buffer(lines: string[], viewportY: number, rows = 4) {
  return {
    baseY: Math.max(0, lines.length - rows),
    viewportY,
    length: lines.length,
    getLine: (index: number) => lines[index] === undefined
      ? undefined
      : { translateToString: () => lines[index] },
  };
}

describe('terminal scroll anchor', () => {
  it('keeps following while replay output temporarily moves the live edge', () => {
    let following = true;

    // Each replay batch advances baseY before TerminalView can scroll the
    // viewport. These are output-driven transitions, not user scrolls.
    for (let batch = 0; batch < 4; batch++) {
      following = nextTerminalFollowState(following, false, false);
      expect(following).toBe(true);
      following = nextTerminalFollowState(following, true, false);
    }

    // A real reader scroll pauses output, and returning to the bottom resumes.
    following = nextTerminalFollowState(following, false, true);
    expect(following).toBe(false);
    following = nextTerminalFollowState(following, true, false);
    expect(following).toBe(true);
  });

  it('keeps the same visible passage when older rows are prepended', () => {
    const original = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    const before = buffer(original, 8);
    const anchor = captureTerminalScrollAnchor(before);
    const rebuilt = buffer([
      ...Array.from({ length: 17 }, (_, i) => `older-${i}`),
      ...original,
    ], 0);

    expect(resolveTerminalScrollAnchor(rebuilt, anchor)).toBe(25);
  });

  it('uses content instead of a drifting distance-from-bottom estimate', () => {
    const original = Array.from({ length: 30 }, (_, i) => `row-${i}`);
    const anchor = captureTerminalScrollAnchor(buffer(original, 10));
    // Rebuild added five real rows at the front but terminal redraw controls also
    // removed two rows near the bottom. A pure distance anchor would land at 13;
    // the same visible content is at 15.
    const rebuiltLines = [
      ...Array.from({ length: 5 }, (_, i) => `old-${i}`),
      ...original.slice(0, -2),
    ];
    const rebuilt = buffer(rebuiltLines, 0);

    expect(rebuilt.baseY - anchor.linesFromBottom).toBe(13);
    expect(resolveTerminalScrollAnchor(rebuilt, anchor)).toBe(15);
  });
});
