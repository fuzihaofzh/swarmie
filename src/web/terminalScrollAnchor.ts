interface BufferLineLike {
  translateToString(trimRight?: boolean): string;
}

interface TerminalBufferLike {
  baseY: number;
  viewportY: number;
  length: number;
  getLine(index: number): BufferLineLike | undefined;
}

export interface TerminalScrollAnchor {
  linesFromBottom: number;
  rows: string[];
  pivotIndex: number;
}

const ANCHOR_ROWS = 6;
const SEARCH_RADIUS = 5000;

/**
 * Resolve whether a terminal should keep following its live edge.
 *
 * xterm briefly reports viewportY < baseY while output, fit(), or another
 * programmatic operation moves the buffer. That transient must not look like a
 * reader scrolling up: only a user-originated scroll may turn following off.
 * Reaching the bottom by any route turns it back on.
 */
export function nextTerminalFollowState(
  currentlyFollowing: boolean,
  atBottom: boolean,
  userInitiated: boolean,
): boolean {
  if (atBottom) return true;
  if (userInitiated) return false;
  return currentlyFollowing;
}

/** Capture visible content as well as the traditional distance-from-bottom. */
export function captureTerminalScrollAnchor(buffer: TerminalBufferLike): TerminalScrollAnchor {
  const rows: string[] = [];
  for (let i = 0; i < ANCHOR_ROWS; i++) {
    rows.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
  }
  let pivotIndex = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length > rows[pivotIndex].length) pivotIndex = i;
  }
  return {
    linesFromBottom: Math.max(0, buffer.baseY - buffer.viewportY),
    rows,
    pivotIndex,
  };
}

/**
 * Resolve the viewport after a reset + history replay.
 *
 * Distance-from-bottom is a good fallback, but terminal control sequences can
 * make the rebuilt prefix change the final line count. Prefer the same visible
 * text near that fallback so loading an older page does not jump to a different
 * passage. The bounded search avoids scanning a 100k-line scrollback in full.
 */
export function resolveTerminalScrollAnchor(
  buffer: TerminalBufferLike,
  anchor: TerminalScrollAnchor,
): number {
  const fallback = Math.max(0, Math.min(buffer.baseY, buffer.baseY - anchor.linesFromBottom));
  const pivot = anchor.rows[anchor.pivotIndex];
  if (!pivot) return fallback;

  const minTop = Math.max(0, fallback - SEARCH_RADIUS);
  const maxTop = Math.min(buffer.baseY, fallback + SEARCH_RADIUS);
  let bestTop = fallback;
  let bestScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let top = minTop; top <= maxTop; top++) {
    const pivotLine = buffer.getLine(top + anchor.pivotIndex)?.translateToString(true) ?? '';
    if (pivotLine !== pivot) continue;
    let score = 0;
    for (let i = 0; i < anchor.rows.length; i++) {
      const line = buffer.getLine(top + i)?.translateToString(true) ?? '';
      if (line === anchor.rows[i]) score++;
    }
    const distance = Math.abs(top - fallback);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      bestTop = top;
      bestScore = score;
      bestDistance = distance;
    }
  }
  return bestScore >= 0 ? bestTop : fallback;
}
