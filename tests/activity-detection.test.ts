import { describe, expect, it } from 'vitest';
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
    void data;
    this.handleUserInput();
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
});
