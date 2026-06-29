import { describe, it, expect } from 'vitest';
import { detectMathSpans, detectMath, renderMath, cellWidthOf, _clearRenderCache } from '../src/web/latex';

const texOf = (line: string) => detectMathSpans(line).map((s) => ({ tex: s.tex, display: s.display }));

describe('detectMathSpans — should detect real math', () => {
  it('inline $…$ with a superscript', () => {
    expect(texOf('the area is $x^2$ units')).toEqual([{ tex: 'x^2', display: false }]);
  });
  it('inline $…$ with a command', () => {
    expect(texOf('$\\alpha + \\beta$')).toEqual([{ tex: '\\alpha + \\beta', display: false }]);
  });
  it('display $$…$$', () => {
    expect(texOf('$$E = mc^2$$')).toEqual([{ tex: 'E = mc^2', display: true }]);
  });
  it('\\(…\\) inline and \\[…\\] display', () => {
    expect(texOf('\\(a_i\\)')).toEqual([{ tex: 'a_i', display: false }]);
    expect(texOf('\\[\\frac{1}{2}\\]')).toEqual([{ tex: '\\frac{1}{2}', display: true }]);
  });
  it('multiple spans on one line', () => {
    expect(texOf('$x^2$ and $y_1$')).toEqual([
      { tex: 'x^2', display: false },
      { tex: 'y_1', display: false },
    ]);
  });
  it('reports correct column range', () => {
    const [s] = detectMathSpans('ab $x^2$ cd');
    expect([s.start, s.end]).toEqual([3, 8]); // "$x^2$" occupies cols 3..7, end exclusive = 8
  });
  it('$$ wins over $ (no nested mis-parse)', () => {
    expect(texOf('$$a^2$$')).toEqual([{ tex: 'a^2', display: true }]);
  });
});

describe('detectMathSpans — should NOT detect shell/terminal noise', () => {
  it('shell variable', () => {
    expect(detectMathSpans('echo $PATH done')).toEqual([]);
  });
  it('prices', () => {
    expect(detectMathSpans('it costs $5 and $10 total')).toEqual([]);
  });
  it('a bare $$ (shell PID) with no close', () => {
    expect(detectMathSpans('echo $$')).toEqual([]);
  });
  it('a plain sentence between dollars without math signal', () => {
    expect(detectMathSpans('$ a plain sentence $')).toEqual([]);
  });
  it('empty delimiters', () => {
    expect(detectMathSpans('$$$$')).toEqual([]);
    expect(detectMathSpans('$$')).toEqual([]);
  });
  it('prompt line', () => {
    expect(detectMathSpans('bash-5.3$ ls')).toEqual([]);
  });
});

describe('detectMathSpans — single-letter variables', () => {
  it('renders bare variables $C$ $H$ $h$', () => {
    expect(texOf('概念类 $C$ 是 PAC')).toEqual([{ tex: 'C', display: false }]);
    expect(texOf('当 $H$ 有限')).toEqual([{ tex: 'H', display: false }]);
    expect(texOf('输出 $h$ 满足')).toEqual([{ tex: 'h', display: false }]);
  });
  it('still rejects multi-letter barewords and numbers', () => {
    expect(detectMathSpans('echo $PATH end')).toEqual([]);
    expect(detectMathSpans('costs $5 and $10')).toEqual([]);
    expect(detectMathSpans('$HOME$')).toEqual([]);
  });
});

describe('cellWidthOf', () => {
  it('ASCII is one cell each', () => {
    expect(cellWidthOf('abc$x$')).toBe(6);
  });
  it('CJK chars are two cells each', () => {
    expect(cellWidthOf('概念类')).toBe(6);
    expect(cellWidthOf('当 $H$')).toBe(2 + 1 + 3); // 当=2, space=1, $H$=3
  });
});

describe('detectMath — multi-line blocks', () => {
  it('detects a $$ block spanning three lines', () => {
    const lines = ['Quadratic:', '$$', '\\frac{-b}{2a}', '$$', 'done'];
    const items = detectMath(lines);
    expect(items).toHaveLength(1);
    const b = items[0];
    expect({ tex: b.tex, display: b.display, startLine: b.startLine, endLine: b.endLine }).toEqual({
      tex: '\\frac{-b}{2a}', display: true, startLine: 1, endLine: 3,
    });
  });
  it('detects a \\[ … \\] block across lines', () => {
    const items = detectMath(['\\[', 'x^2 + y^2', '\\]']);
    expect(items).toHaveLength(1);
    expect(items[0].tex).toBe('x^2 + y^2');
    expect(items[0].display).toBe(true);
  });
  it('single-line $$…$$ still works and is not double-counted', () => {
    const items = detectMath(['here $$E=mc^2$$ ok']);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tex: 'E=mc^2', display: true, startLine: 0, endLine: 0 });
  });
  it('mixes a block and inline math without overlap', () => {
    const items = detectMath(['intro $a^2$', '$$', '\\sum_i x_i', '$$']);
    const texs = items.map((i) => i.tex).sort();
    expect(texs).toEqual(['\\sum_i x_i', 'a^2']);
  });
  it('does not treat shell noise as a block', () => {
    expect(detectMath(['echo $$', 'PID is set', 'done'])).toEqual([]);
  });
});

describe('renderMath', () => {
  it('renders valid LaTeX to HTML', () => {
    _clearRenderCache();
    const html = renderMath('x^2', false);
    expect(html).toBeTruthy();
    expect(html).toContain('katex');
  });
  it('returns null for invalid LaTeX', () => {
    _clearRenderCache();
    expect(renderMath('\\frac{1}{', false)).toBeNull();
  });
  it('caches results (same reference logic, no throw on repeat)', () => {
    _clearRenderCache();
    const a = renderMath('a_i', true);
    const b = renderMath('a_i', true);
    expect(a).toBe(b);
  });
});
