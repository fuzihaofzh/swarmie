import { describe, expect, it } from 'vitest';
import { extendFromWord, moveRangeEnd, rangeFromArgs, selectionArgs, wordBoundsAt, type CellText } from '../src/web/touchSelection';

function line(text: string): CellText {
  return (col) => {
    const ch = text[col];
    if (ch === undefined) return undefined;
    // '_' marks the trailing half of a wide character in these fixtures.
    if (ch === '_') return { chars: '', width: 0 };
    return { chars: ch === '~' ? '' : ch, width: 1 };
  };
}

describe('wordBoundsAt', () => {
  it('selects the word under the cell', () => {
    expect(wordBoundsAt(line('ls src/web.ts foo'), 5, 17)).toEqual({ start: 3, end: 12 });
  });

  it('selects a single cell on whitespace or empty cells', () => {
    expect(wordBoundsAt(line('a b'), 1, 3)).toEqual({ start: 1, end: 1 });
    expect(wordBoundsAt(line('ab~~~'), 3, 5)).toEqual({ start: 3, end: 3 });
  });

  it('stops at brackets and quotes', () => {
    expect(wordBoundsAt(line('f("x.y")'), 4, 8)).toEqual({ start: 3, end: 5 });
  });

  it('keeps wide characters together', () => {
    expect(wordBoundsAt(line('中_文_ ok'), 1, 7)).toEqual({ start: 0, end: 3 });
  });
});

describe('selectionArgs', () => {
  it('orders the ends and spans rows', () => {
    expect(selectionArgs({ col: 2, row: 5 }, { col: 1, row: 4 }, 10)).toEqual({ col: 1, row: 4, length: 12 });
    expect(selectionArgs({ col: 3, row: 0 }, { col: 3, row: 0 }, 10)).toEqual({ col: 3, row: 0, length: 1 });
  });
});

describe('extendFromWord', () => {
  const word = { start: { col: 4, row: 2 }, end: { col: 7, row: 2 } };
  it('keeps the word when the finger is inside it', () => {
    expect(extendFromWord(word, { col: 5, row: 2 }, 10)).toEqual({ col: 4, row: 2, length: 4 });
  });
  it('grows backwards and forwards', () => {
    expect(extendFromWord(word, { col: 1, row: 2 }, 10)).toEqual({ col: 1, row: 2, length: 7 });
    expect(extendFromWord(word, { col: 0, row: 3 }, 10)).toEqual({ col: 4, row: 2, length: 7 });
  });
});

describe('rangeFromArgs', () => {
  it('inverts selectionArgs across rows', () => {
    const a = { col: 8, row: 3 };
    const b = { col: 2, row: 5 };
    expect(rangeFromArgs(selectionArgs(a, b, 10), 10)).toEqual({ start: a, end: b });
  });
});

describe('moveRangeEnd', () => {
  const range = { start: { col: 2, row: 1 }, end: { col: 5, row: 1 } };
  it('moves one end in place', () => {
    expect(moveRangeEnd(range, 'end', { col: 0, row: 2 })).toEqual({
      range: { start: { col: 2, row: 1 }, end: { col: 0, row: 2 } },
      active: 'end',
    });
  });
  it('swaps ends when dragged past the other one', () => {
    expect(moveRangeEnd(range, 'start', { col: 7, row: 1 })).toEqual({
      range: { start: { col: 5, row: 1 }, end: { col: 7, row: 1 } },
      active: 'end',
    });
    expect(moveRangeEnd(range, 'end', { col: 0, row: 0 })).toEqual({
      range: { start: { col: 0, row: 0 }, end: { col: 2, row: 1 } },
      active: 'start',
    });
  });
});
