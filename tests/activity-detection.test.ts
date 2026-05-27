import { describe, expect, it, vi } from 'vitest';
import { BaseAdapter } from '../src/adapters/base.js';
import type { AdapterInfo } from '../src/adapters/types.js';

class ActivityDetectionAdapter extends BaseAdapter {
  get info(): AdapterInfo {
    return {
      name: 'test',
      displayName: 'Test',
      icon: '',
      command: 'test',
      supportsStructured: false,
    };
  }

  get isRunning(): boolean {
    return !['completed', 'error'].includes(this.status);
  }

  start(): void {
    this.setStatus('running');
  }

  write(data: string): void {
    this.handleUserInput(data);
  }

  resize(cols: number, rows: number): void {
    void cols;
    void rows;
  }

  kill(signal?: string): void {
    void signal;
  }

  feed(chunk: string): void {
    this.handleActivityDetection(chunk);
  }
}

function createAdapter(): ActivityDetectionAdapter {
  const adapter = new ActivityDetectionAdapter({ sessionId: 'detect-test', toolArgs: [] });
  adapter.start();
  return adapter;
}

describe('activity detection', () => {
  it('detects Codex proceed menus rendered by the current CLI', () => {
    const adapter = createAdapter();

    adapter.feed(' > 1. Yes, proceed (y) 2. No, and tell Codex what to do differently ( esc ) ');

    expect(adapter.status).toBe('waiting_input');
  });

  it('detects Codex enter-to-confirm prompts with lowercase esc', () => {
    const adapter = createAdapter();

    adapter.feed('Press enter to confirm or esc to cancel');

    expect(adapter.status).toBe('waiting_input');
  });

  it('detects Codex prompts when truecolor SGR is split across PTY chunks', () => {
    const adapter = createAdapter();

    adapter.feed('\x1b[39;48;2;');
    adapter.feed('242;236;217m > 1. Yes, proceed (y) ');

    expect(adapter.status).toBe('waiting_input');
  });

  it('detects Codex prompts even after the spinner has spammed the detect buffer', () => {
    const adapter = createAdapter();

    // Simulate Codex rendering the approval prompt once, then spamming the
    // ◦ (U+25E6) spinner glyph in subsequent frames. Without stripping the
    // spinner, the prompt text gets evicted from the 1000-char rolling
    // buffer before any chunk-time pattern check can match it.
    adapter.feed(' > 1. Yes, proceed (y) ');
    for (let i = 0; i < 500; i++) {
      adapter.feed('\x1b[1A\x1b[10C◦\x1b[1B');
    }
    adapter.feed('Press enter to confirm or esc to cancel');

    expect(adapter.status).toBe('waiting_input');
  });

  it('detects prompts when kitty keyboard / modifyOtherKeys sequences are interleaved', () => {
    const adapter = createAdapter();

    // Apps that enable the kitty keyboard protocol (CSI > 1 u / CSI < u) or
    // xterm modifyOtherKeys (CSI > 4 ; 2 m) spam these private-prefix CSI
    // sequences around their redraws. They must be stripped, or their literal
    // tails ([>1u, [<u, [>4;2m) wedge between prompt words and break the
    // ".{0,10}"-gap matching, so the session never reaches waiting_input.
    adapter.feed('\x1b[>1u\x1b[>4;2mDo \x1b[<uyou \x1b[>1uwant \x1b[>4;2mto proceed?\x1b[<u');

    expect(adapter.status).toBe('waiting_input');
  });

  it('strips kitty/modifyOtherKeys sequences split across PTY chunks', () => {
    const adapter = createAdapter();

    // The ESC lands at the tail of one chunk; the "[>1u" fragment arrives in
    // the next. CSI_FRAGMENT_RE must cover the private-prefix form too.
    adapter.feed('Do you want \x1b');
    adapter.feed('[>1u\x1b[>4;2mto proceed?');

    expect(adapter.status).toBe('waiting_input');
  });

  it('strips braille spinner glyphs so they do not crowd out prompt text', () => {
    const adapter = createAdapter();

    for (let i = 0; i < 500; i++) {
      adapter.feed('\x1b[1A⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\x1b[1B');
    }
    adapter.feed(' > 1. Yes, proceed (y) ');

    expect(adapter.status).toBe('waiting_input');
  });

  it('settles startup output to idle without treating it as command activity', () => {
    const adapter = createAdapter();

    adapter.feed('startup complete');

    expect(adapter.status).toBe('idle');
  });

  it('does not mark idle sessions running for passive focus input', () => {
    const adapter = createAdapter();

    adapter.feed('startup complete');
    expect(adapter.status).toBe('idle');

    adapter.write('\x1b[I');

    expect(adapter.status).toBe('idle');
  });

  it('marks sessions briefly running while the user types without submitting', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();

      adapter.feed('startup complete');
      expect(adapter.status).toBe('idle');

      adapter.write('\x1b[Ih');
      expect(adapter.status).toBe('running');

      adapter.feed('h');
      expect(adapter.status).toBe('running');

      await vi.advanceTimersByTimeAsync(3_000);
      expect(adapter.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks submitted input as command execution', () => {
    const adapter = createAdapter();

    adapter.feed('startup complete');
    expect(adapter.status).toBe('idle');

    adapter.write('\x1b[Ih\r');

    expect(adapter.status).toBe('running');
  });

  it('does not mark idle sessions running for terminal redraw output', () => {
    const adapter = createAdapter();

    adapter.feed('startup complete');
    expect(adapter.status).toBe('idle');

    adapter.feed('\x1b[?25l\x1b[?25h');
    adapter.feed('gpt-5.5 xhigh · ~');

    expect(adapter.status).toBe('idle');
  });

  it('idles submitted commands after claudemonitor-style quiet timeout', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();

      adapter.feed('startup complete');
      expect(adapter.status).toBe('idle');

      adapter.write('echo test\r');
      expect(adapter.status).toBe('running');

      await vi.advanceTimersByTimeAsync(32_000);
      expect(adapter.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes command activity on output before idling', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();

      adapter.feed('startup complete');
      adapter.write('echo test\r');
      expect(adapter.status).toBe('running');

      await vi.advanceTimersByTimeAsync(29_000);
      adapter.feed('streaming output');
      await vi.advanceTimersByTimeAsync(29_000);
      expect(adapter.status).toBe('running');

      await vi.advanceTimersByTimeAsync(3_000);
      expect(adapter.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});
