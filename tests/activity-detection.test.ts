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
