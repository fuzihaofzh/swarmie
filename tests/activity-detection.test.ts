import { describe, expect, it, vi } from 'vitest';
import { BaseAdapter, matchesAgentIdleScreen, matchesBusyScreen } from '../src/adapters/base.js';
import type { AdapterInfo } from '../src/adapters/types.js';

class ActivityDetectionAdapter extends BaseAdapter {
  // These cases assert the classifier's verdict on a screen, not when the
  // sample runs, so they feed chunks and read status synchronously. The
  // throttle itself is covered separately in "screen sample throttling".
  protected detectSampleIntervalMs = 0;

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

  // Override the tool-specific hook, not resize() itself — resize() is where
  // the base class re-baselines screen-movement detection, and stubbing it out
  // meant redraw()/SIGWINCH behavior was never actually exercised.
  protected applyResize(cols: number, rows: number): void {
    void cols;
    void rows;
  }

  kill(signal?: string): void {
    void signal;
  }

  feed(chunk: string): void {
    this.handleActivityDetection(chunk);
  }

  protected shouldDetectWaitingPrompt(): boolean {
    return true;
  }
}

class ShellActivityDetectionAdapter extends ActivityDetectionAdapter {
  get info(): AdapterInfo {
    return {
      name: '/bin/zsh',
      displayName: '/bin/zsh',
      icon: '',
      command: '/bin/zsh',
      supportsStructured: false,
    };
  }

  protected shouldDetectWaitingPrompt(): boolean {
    return false;
  }
}

class DirectCommandActivityDetectionAdapter extends ActivityDetectionAdapter {
  protected shouldSettleVisibleOutputToIdle(): boolean {
    return false;
  }
}

class AgentMovementDetectionAdapter extends ActivityDetectionAdapter {
  get info(): AdapterInfo {
    return {
      name: 'claude',
      displayName: 'Claude Code',
      icon: '',
      command: 'claude',
      supportsStructured: false,
    };
  }
}

function createAdapter(): ActivityDetectionAdapter {
  const adapter = new ActivityDetectionAdapter({ sessionId: 'detect-test', toolArgs: [] });
  adapter.start();
  return adapter;
}

function createShellAdapter(): ShellActivityDetectionAdapter {
  const adapter = new ShellActivityDetectionAdapter({ sessionId: 'shell-detect-test', toolArgs: [] });
  adapter.start();
  return adapter;
}

function createDirectCommandAdapter(): DirectCommandActivityDetectionAdapter {
  const adapter = new DirectCommandActivityDetectionAdapter({ sessionId: 'direct-command-test', toolArgs: [] });
  adapter.start();
  return adapter;
}

function createAgentMovementAdapter(): AgentMovementDetectionAdapter {
  const adapter = new AgentMovementDetectionAdapter({ sessionId: 'movement-agent-test', toolArgs: [] });
  adapter.start();
  return adapter;
}

describe('activity detection', () => {
  it('does not mark generic shell output as waiting_input', () => {
    const adapter = createShellAdapter();

    adapter.feed('Press enter to confirm or esc to cancel');

    expect(adapter.status).toBe('idle');
  });

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
    adapter.feed('\x1b[>1u\x1b[>4;2m1. \x1b[<uYes, \x1b[>1uproceed\x1b[>4;2m\x1b[<u');

    expect(adapter.status).toBe('waiting_input');
  });

  it('strips kitty/modifyOtherKeys sequences split across PTY chunks', () => {
    const adapter = createAdapter();

    // The ESC lands at the tail of one chunk; the "[>1u" fragment arrives in
    // the next. CSI_FRAGMENT_RE must cover the private-prefix form too.
    adapter.feed('1. Yes\x1b');
    adapter.feed('[>1u\x1b[>4;2m, proceed');

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

  it('keeps direct command output running without submitted user input', () => {
    const adapter = createDirectCommandAdapter();

    adapter.feed('0123456789abcdef\n');

    expect(adapter.status).toBe('running');
  });

  it('marks visible agent working status as running', () => {
    const adapter = createAdapter();

    adapter.feed('◦ Working (20m 05s • esc to interrupt)');

    expect(adapter.status).toBe('running');
  });

  it('marks Claude in-progress verb status lines as running even with an idle prompt visible', () => {
    const adapter = createAdapter();

    adapter.feed('──────────────────────────────\n❯ 写进 instruction.md\n? for shortcuts');
    expect(adapter.status).toBe('idle');

    adapter.feed('\x1b[1;1HGerminating… (5s · esc to interrupt)\n──────────────────────────────\n❯ 写进 instruction.md\n? for shortcuts');

    expect(adapter.status).toBe('running');
  });

  it('marks repeated visible agent screen movement as running without knowing the status word', () => {
    const adapter = createAgentMovementAdapter();

    adapter.feed('──────────────────────────────\n❯ 写进 instruction.md\n? for shortcuts');
    expect(adapter.status).toBe('idle');

    adapter.feed('\x1b[1;1HShimmering…\n──────────────────────────────\n❯ 写进 instruction.md\n? for shortcuts');

    expect(adapter.status).toBe('running');
  });

  it('settles movement-based running back to idle after the screen stops moving', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    try {
      const adapter = createAgentMovementAdapter();

      adapter.feed('──────────────────────────────\n❯ 写进 instruction.md\n? for shortcuts');
      adapter.feed('\x1b[1;1HShimmering…\n──────────────────────────────\n❯ 写进 instruction.md\n? for shortcuts');
      expect(adapter.status).toBe('running');

      await vi.advanceTimersByTimeAsync(5_000);

      expect(adapter.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat completed Claude timing summaries as busy', () => {
    const adapter = createAdapter();

    adapter.feed('✻ Baked for 5m 2s\n──────────────────────────────\n❯ \n? for shortcuts');

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

  it('does not idle a submitted command while the screen still says the agent is working', async () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();

      adapter.feed('startup complete');
      adapter.write('start agent\r');
      adapter.feed('◦ Working (2m 10s • esc to interrupt)');

      await vi.advanceTimersByTimeAsync(32_000);

      expect(adapter.status).toBe('running');
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

  it('keeps waiting_input set across cursor-only redraw frames (Codex static prompt)', () => {
    const adapter = createAdapter();

    // Paint the prompt on row 5, then put streaming sub-agent output on row 10.
    adapter.feed('\x1b[5;1H\x1b[KPress enter to confirm or esc to cancel');
    expect(adapter.status).toBe('waiting_input');

    // Subsequent frames rewrite a different row only — the prompt text on row 5
    // stays in the headless buffer. With the old rolling stripped-text detector
    // the prompt would have been aged out of the 1000-char window and the next
    // prompt detection would never re-fire. With the screen-based detector,
    // the prompt is still visible so status is sticky.
    for (let i = 0; i < 1000; i++) {
      adapter.feed(`\x1b[10;1H\x1b[Kspinner frame ${i}`);
    }
    expect(adapter.status).toBe('waiting_input');
  });

  it('leaves waiting_input once the prompt is cleared from the screen', () => {
    const adapter = createAdapter();

    adapter.feed('Press enter to confirm or esc to cancel');
    expect(adapter.status).toBe('waiting_input');

    // Full screen clear + new content overwriting the prompt area.
    adapter.feed('\x1b[2J\x1b[H');
    adapter.feed('Working on it…');
    expect(adapter.status).toBe('idle');
  });
});

describe('screen sample throttling', () => {
  // A redrawing spinner delivers dozens of chunks a second and each sample
  // builds two full-screen strings plus ~20 regexes, so sampling per chunk
  // pins the event loop. Bursts collapse to a leading + trailing sample.
  class ThrottledAdapter extends ActivityDetectionAdapter {
    protected detectSampleIntervalMs = 80;
    samples = 0;

    protected shouldDetectWaitingPrompt(): boolean {
      return true;
    }

    getScreenSnapshot() {
      return super.getScreenSnapshot();
    }
  }

  function createThrottled(): ThrottledAdapter {
    const adapter = new ThrottledAdapter({ sessionId: 'throttle-test', toolArgs: [] });
    adapter.start();
    return adapter;
  }

  it('defers a prompt that lands inside the window, then classifies it', () => {
    vi.useFakeTimers();
    try {
      const adapter = createThrottled();

      // Leading edge: the first chunk samples immediately, settling the
      // 'running' that start() set into 'idle' for plain visible output.
      expect(adapter.status).toBe('running');
      adapter.feed('booting…');
      expect(adapter.status).toBe('idle');

      // Same window — the prompt is on the virtual screen but not yet sampled.
      adapter.feed('Press enter to confirm or esc to cancel');
      expect(adapter.status).not.toBe('waiting_input');

      // The trailing sample runs on the settled screen.
      vi.advanceTimersByTime(80);
      expect(adapter.status).toBe('waiting_input');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the screen in sync even for chunks it does not sample', () => {
    vi.useFakeTimers();
    try {
      const adapter = createThrottled();
      adapter.feed('first');

      // Writes are never throttled — only sampling is — so a prompt split
      // across deferred chunks must still be whole on the screen.
      adapter.feed('Press enter to confirm');
      adapter.feed(' or esc to cancel');
      expect(adapter.getScreenSnapshot().recent).toContain('Press enter to confirm or esc to cancel');

      vi.advanceTimersByTime(80);
      expect(adapter.status).toBe('waiting_input');
    } finally {
      vi.useRealTimers();
    }
  });

  it('samples once per window under a sustained burst', () => {
    vi.useFakeTimers();
    try {
      const adapter = createThrottled();
      const transitions: string[] = [];
      adapter.on('event', (e: { type: string }) => {
        if (e.type === 'status:change') transitions.push(e.type);
      });

      // 200 chunks inside one window must not produce 200 samples; the
      // trailing timer is armed once and re-armed only after it fires.
      for (let i = 0; i < 200; i++) adapter.feed(`\x1b[2K\rworking ${i}`);
      vi.advanceTimersByTime(80);

      expect(adapter.getScreenSnapshot().recent).toContain('working 199');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stuck-busy watchdog', () => {
  // A session whose screen still shows a busy affordance but has stopped
  // repainting is finished, not working. Before this, the idle sweep saw
  // "esc to interrupt" on the frozen screen, pushed _lastActivity forward on
  // every 2s tick, and pinned the tab busy forever.
  it('settles a frozen busy screen to idle', () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      adapter.feed('✳ Working… (12s · esc to interrupt)');
      expect(adapter.status).toBe('running');

      // Screen never changes again — the process died mid-frame.
      vi.advanceTimersByTime(120_000);

      expect(adapter.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a repainting busy screen running', () => {
    vi.useFakeTimers();
    try {
      const adapter = createAdapter();
      // The elapsed counter ticks, so the screen keeps changing.
      for (let s = 1; s <= 120; s++) {
        adapter.feed(`\x1b[1;1H✳ Working… (${s}s · esc to interrupt)`);
        vi.advanceTimersByTime(1_000);
      }

      expect(adapter.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tab switch repaint', () => {
  // Switching tabs sends an explicit redraw, which SIGWINCHes the CLI into
  // repainting its whole screen. That repaint is our own doing, so it must not
  // read as the session working — otherwise every tab switch flashed the icon
  // busy for 5s. Re-baselining a single frame was not enough: an ink repaint
  // spans several 80ms sample windows.
  it('does not mark an idle session busy on redraw', () => {
    const adapter = createAgentMovementAdapter();
    adapter.feed('──────────\n❯ \n? for shortcuts');
    expect(adapter.status).toBe('idle');

    adapter.redraw();
    // A multi-frame repaint: cleared, then partially drawn, then complete.
    adapter.feed('\x1b[2J\x1b[1;1H');
    adapter.feed('\x1b[1;1H────');
    adapter.feed('\x1b[1;1H──────────\n❯ \n? for shortcuts');

    expect(adapter.status).toBe('idle');
  });

  it('still detects real movement once the repaint window passes', () => {
    vi.useFakeTimers();
    try {
      const adapter = createAgentMovementAdapter();
      adapter.feed('──────────\n❯ \n? for shortcuts');
      adapter.redraw();
      vi.advanceTimersByTime(2_000);

      adapter.feed('\x1b[1;1Hsome real output');
      adapter.feed('\x1b[1;1Hmore real output');

      expect(adapter.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('codex idle screen', () => {
  // Captured from a real `codex` process. Codex renders a rotating placeholder
  // after its "›" prompt, so a bare-prompt-only idle pattern matched nothing:
  // Codex had no idle marker at all and every visible screen fell through to
  // running, which lit the tab busy on every tab switch.
  const CODEX_IDLE = [
    '╭─────────────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.144.6)                      │',
    '│ model:     gpt-5.6-sol xhigh   /model to change │',
    '╰─────────────────────────────────────────────────╯',
    '• You have 3 usage limit resets available. Run /usage to use one.',
    '› Find and fix a bug in @filename',
    '  gpt-5.6-sol xhigh · ~',
  ].join('\n');

  it('recognizes the codex prompt as idle even with a placeholder', () => {
    expect(matchesAgentIdleScreen(CODEX_IDLE)).toBe(true);
    expect(matchesBusyScreen(CODEX_IDLE)).toBe(false);
  });

  it('lets a busy codex screen win over the idle prompt', () => {
    const busy = `${CODEX_IDLE}\n• Running (12s • esc to interrupt)`;
    expect(matchesBusyScreen(busy)).toBe(true);
  });
});
