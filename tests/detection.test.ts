import { describe, expect, it } from 'vitest';
import {
  AgentStateDetector,
  DetectionStabilizer,
  chooseStateSignal,
  compileManifest,
  selectDetectionRegion,
} from '../src/detection/index.js';
import type { AgentDetectionResult, AgentStateManifest } from '../src/detection/index.js';
import { BaseAdapter } from '../src/adapters/base.js';
import type { AdapterInfo } from '../src/adapters/types.js';

const detector = new AgentStateDetector();

function input(recent: string, extra: { viewport?: string; oscTitle?: string; oscProgress?: string } = {}) {
  return {
    recent,
    viewport: extra.viewport ?? recent,
    oscTitle: extra.oscTitle,
    oscProgress: extra.oscProgress,
  };
}

function result(
  state: AgentDetectionResult['state'],
  observedAt: number,
  evidence: Partial<Pick<AgentDetectionResult, 'visibleIdle' | 'visibleWorking' | 'visibleBlocker' | 'skipStateUpdate'>> = {},
): AgentDetectionResult {
  return {
    agent: 'test',
    state,
    source: 'screen',
    observedAt,
    visibleIdle: false,
    visibleWorking: false,
    visibleBlocker: false,
    skipStateUpdate: false,
    automationSafe: false,
    reason: 'test',
    ...evidence,
  };
}

class IntegratedDetectionAdapter extends BaseAdapter {
  protected detectSampleIntervalMs = 0;

  get info(): AdapterInfo {
    return {
      name: 'claude',
      displayName: 'Claude Code',
      icon: '',
      command: 'claude',
      supportsStructured: false,
    };
  }

  get isRunning(): boolean {
    return this.status !== 'completed' && this.status !== 'error';
  }

  start(): void {
    this.setStatus('running');
  }

  write(data: string): void {
    this.handleUserInput(data);
  }

  protected applyResize(): void {}

  kill(): void {}

  feed(data: string): void {
    this.handleActivityDetection(data);
  }
}

describe('agent state detector', () => {
  it('detects a structurally visible Claude approval card', () => {
    const screen = [
      'Bash command',
      '  npm test',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No',
      'Esc to cancel · Tab to amend',
    ].join('\n');

    const detection = detector.detect('claude', input(screen));
    expect(detection.result.state).toBe('blocked');
    expect(detection.result.visibleBlocker).toBe(true);
    expect(detection.result.matchedRuleId).toBe('selected-approval');
    expect(detection.result.automationSafe).toBe(true);
  });

  it('reports a blocker but denies automation when the cursor is on No', () => {
    const screen = [
      'Do you want to proceed?',
      '  1. Yes',
      '❯ 2. No',
      'Esc to cancel · Tab to amend',
    ].join('\n');
    const detection = detector.detect('claude', input(screen));
    expect(detection.result.state).toBe('blocked');
    expect(detection.result.visibleBlocker).toBe(true);
    expect(detection.result.automationSafe).toBe(false);
  });

  it('does not treat an ordinary question or prose list as a blocker', () => {
    const screen = [
      'I updated the implementation.',
      'Do you want me to add another test?',
      'Steps:',
      '1. Build the project',
      '2. Run the tests',
    ].join('\n');

    const detection = detector.detect('claude', input(screen));
    expect(detection.result.state).toBe('unknown');
    expect(detection.result.visibleBlocker).toBe(false);
  });

  it('distinguishes visible working and idle UI', () => {
    const working = detector.detect('claude', input('✳ Working… (12s · esc to interrupt)'));
    expect(working.result.state).toBe('working');
    expect(working.result.visibleWorking).toBe(true);

    const idle = detector.detect('claude', input('────────────\n❯ Ask about this repository\n? for shortcuts'));
    expect(idle.result.state).toBe('idle');
    expect(idle.result.visibleIdle).toBe(true);
  });

  it('uses OSC title as an independent Codex signal', () => {
    const blocked = detector.detect('codex', input('', { oscTitle: 'Action Required' }));
    expect(blocked.result.state).toBe('blocked');
    expect(blocked.result.matchedRuleId).toBe('title-action-required');

    const working = detector.detect('codex', input('', { oscTitle: 'Working' }));
    expect(working.result.state).toBe('working');
    expect(working.result.visibleWorking).toBe(true);
  });

  it('recognizes spinner-only titles used by current agent releases', () => {
    const codex = detector.detect('codex', input('', { oscTitle: '⠋ Codex' }));
    expect(codex.result).toMatchObject({
      state: 'working',
      matchedRuleId: 'title-busy-spinner',
      visibleWorking: true,
    });

    const claude = detector.detect('claude', input('', { oscTitle: '◐ Claude Code' }));
    expect(claude.result).toMatchObject({
      state: 'working',
      matchedRuleId: 'title-busy-spinner',
      visibleWorking: true,
    });
  });

  it('recognizes Claude ready progress and keeps non-lifecycle menus from changing state', () => {
    const ready = detector.detect('claude', input('', { oscProgress: '4;0;ready' }));
    expect(ready.result).toMatchObject({ state: 'idle', visibleIdle: true, matchedRuleId: 'progress-ready' });

    const picker = detector.detect('claude', input([
      'Select model',
      '❯ Opus',
      'Enter to set as default · Esc to cancel',
    ].join('\n')));
    expect(picker.result).toMatchObject({
      state: 'unknown',
      skipStateUpdate: true,
      matchedRuleId: 'model-selection-overlay',
    });
  });

  it('recognizes side-question overlays and workflow confirmations', () => {
    const overlay = detector.detect('claude', input('/btw explain this line\nEsc to close'));
    expect(overlay.result).toMatchObject({ state: 'working', visibleWorking: true });

    const workflow = detector.detect('claude', input('Run a dynamic workflow?\nEsc to cancel'));
    expect(workflow.result).toMatchObject({ state: 'blocked', visibleBlocker: true });
  });

  it('recognizes Gemini approval structure without matching arbitrary output', () => {
    const blocked = detector.detect('gemini', input([
      'Apply this change?',
      '1. Allow',
      '2. No',
      'Press enter to confirm',
    ].join('\n')));
    expect(blocked.result.state).toBe('blocked');

    const prose = detector.detect('gemini', input('The tool can apply this change after review.'));
    expect(prose.result.state).toBe('unknown');
  });

  it('preserves state while a transcript viewer is visible', () => {
    const detection = detector.detect('claude', input('Showing detailed transcript\nCtrl+O to hide transcript'));
    expect(detection.result.state).toBe('unknown');
    expect(detection.result.skipStateUpdate).toBe(true);
    expect(detection.result.matchedRuleId).toBe('transcript-viewer');
  });

  it('returns a rule trace without terminal text unless requested', () => {
    const hidden = detector.detect('codex', input('› Explain this codebase'));
    expect(hidden.evaluatedRules.length).toBeGreaterThan(0);
    expect(hidden.evaluatedRules.every((rule) => rule.regionPreview === undefined)).toBe(true);

    const visible = detector.detect('codex', input('› Explain this codebase'), { includeText: true });
    expect(visible.evaluatedRules.some((rule) => rule.regionPreview?.includes('Explain this codebase'))).toBe(true);
  });

  it('uses the highest priority matching rule and earlier rule for ties', () => {
    const manifest: AgentStateManifest = {
      id: 'priority-test',
      version: 1,
      rules: [
        { id: 'first', state: 'idle', priority: 10, region: { kind: 'whole_recent' }, contains: ['ready'] },
        { id: 'second', state: 'working', priority: 10, region: { kind: 'whole_recent' }, contains: ['ready'] },
        { id: 'winner', state: 'blocked', priority: 20, region: { kind: 'whole_recent' }, contains: ['confirm'] },
      ],
    };
    const custom = new AgentStateDetector([manifest]);
    expect(custom.detect('priority-test', input('ready')).result.matchedRuleId).toBe('first');
    expect(custom.detect('priority-test', input('ready confirm')).result.matchedRuleId).toBe('winner');
  });

  it('rejects unsafe or malformed manifest definitions', () => {
    expect(() => compileManifest({
      id: 'bad',
      version: 1,
      rules: [{
        id: 'skip-with-state',
        state: 'idle',
        priority: 1,
        region: { kind: 'whole_recent' },
        contains: ['x'],
        skipStateUpdate: true,
      }],
    })).toThrow(/skipped rules must use unknown state/);

    expect(() => compileManifest({
      id: 'bad-regex',
      version: 1,
      rules: [{
        id: 'broken',
        state: 'idle',
        priority: 1,
        region: { kind: 'whole_recent' },
        regex: ['['],
      }],
    })).toThrow(/invalid regular expression/);

    expect(() => compileManifest({
      id: 'unsafe-automation',
      version: 1,
      rules: [{
        id: 'idle-action',
        state: 'idle',
        priority: 1,
        region: { kind: 'whole_recent' },
        contains: ['ready'],
        automationSafe: true,
      }],
    })).toThrow(/automation-safe rules/);
  });
});

describe('detection regions', () => {
  it('selects status text after the last horizontal separator', () => {
    const screen = 'old transcript\n────────\nnew status\n❯ prompt';
    expect(selectDetectionRegion(input(screen), { kind: 'after_last_horizontal_rule' }))
      .toBe('new status\n❯ prompt');
  });

  it('finds the prompt block near the bottom without returning old transcript', () => {
    const screen = 'secret from old output\n────────\n❯ New task\n? for shortcuts';
    const region = selectDetectionRegion(input(screen), { kind: 'prompt_box_body' });
    expect(region).toContain('❯ New task');
    expect(region).not.toContain('secret from old output');
  });

  it('only returns output produced after the latest live prompt marker', () => {
    const screen = [
      'Allow command?',
      'press enter to confirm or esc to cancel',
      '› explain the current change',
      '• Working (2s · esc to interrupt)',
    ].join('\n');
    const region = selectDetectionRegion(input(screen), { kind: 'after_last_prompt_marker' });
    expect(region).toBe('• Working (2s · esc to interrupt)');
    expect(region).not.toContain('Allow command?');
  });
});

describe('detection stabilizer', () => {
  it('holds weak working-to-idle transitions until repeated', () => {
    const stabilizer = new DetectionStabilizer(0);
    expect(stabilizer.observe(result('working', 5_000, { visibleWorking: true })).state).toBe('working');
    expect(stabilizer.observe(result('idle', 5_100)).decision).toBe('held');
    expect(stabilizer.observe(result('idle', 5_200)).decision).toBe('held');
    expect(stabilizer.observe(result('idle', 5_300)).state).toBe('idle');
  });

  it('accepts explicit idle immediately and skips temporary viewers', () => {
    const stabilizer = new DetectionStabilizer(0);
    stabilizer.observe(result('working', 5_000, { visibleWorking: true }));
    expect(stabilizer.observe(result('unknown', 5_100, { skipStateUpdate: true }))).toMatchObject({
      state: 'working',
      decision: 'skipped',
    });
    expect(stabilizer.observe(result('idle', 5_200, { visibleIdle: true }))).toMatchObject({
      state: 'idle',
      decision: 'accepted',
    });
  });
});

describe('state source arbiter', () => {
  it('lets a visible blocker beat non-authoritative activity reports', () => {
    const chosen = chooseStateSignal([
      { state: 'working', source: 'structured', observedAt: 1_000 },
      { state: 'blocked', source: 'screen', observedAt: 900, visibleBlocker: true },
    ], { now: 1_100 });
    expect(chosen?.state).toBe('blocked');
  });

  it('keeps an authoritative lifecycle report above screen evidence', () => {
    const chosen = chooseStateSignal([
      { state: 'working', source: 'hook', observedAt: 1_000, authoritative: true },
      { state: 'blocked', source: 'screen', observedAt: 1_050, visibleBlocker: true },
    ], { now: 1_100 });
    expect(chosen?.source).toBe('hook');
  });

  it('ignores stale reports', () => {
    expect(chooseStateSignal([
      { state: 'working', source: 'hook', observedAt: 1_000 },
    ], { now: 10_000, maxAgeMs: 1_000 })).toBeUndefined();
  });
});

describe('adapter detection integration', () => {
  it('records shadow decisions without exposing screen text', () => {
    const previousMode = process.env.SWARMIE_DETECTION_MODE;
    process.env.SWARMIE_DETECTION_MODE = 'shadow';
    try {
      const adapter = new IntegratedDetectionAdapter({ sessionId: 'shadow-detect', toolArgs: [] });
      const stateEvents: Array<{ type: string; data: unknown }> = [];
      adapter.on('event', (event: { type: string; data: unknown }) => {
        if (event.type === 'agent:state') stateEvents.push(event);
      });
      adapter.start();
      adapter.feed('❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend');

      const explanation = adapter.getDetectionExplanation();
      expect(explanation).toMatchObject({
        mode: 'shadow',
        state: 'blocked',
        matchedRuleId: 'selected-approval',
        visibleBlocker: true,
        automationSafe: true,
      });
      expect(explanation.evaluatedRules.every((rule) => rule.regionPreview === undefined)).toBe(true);
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].data).toMatchObject({
        state: 'blocked',
        ruleId: 'selected-approval',
        automationSafe: true,
      });
      expect(JSON.stringify(stateEvents[0])).not.toContain('Esc to cancel');
    } finally {
      if (previousMode === undefined) delete process.env.SWARMIE_DETECTION_MODE;
      else process.env.SWARMIE_DETECTION_MODE = previousMode;
    }
  });

  it('preserves the published status for skip-state rules in active mode', () => {
    const previousMode = process.env.SWARMIE_DETECTION_MODE;
    process.env.SWARMIE_DETECTION_MODE = 'active';
    try {
      const adapter = new IntegratedDetectionAdapter({ sessionId: 'active-detect', toolArgs: [] });
      adapter.start();
      adapter.feed('❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend');
      expect(adapter.status).toBe('waiting_input');

      adapter.feed('\x1b[2J\x1b[HShowing detailed transcript\nCtrl+O to hide transcript');
      expect(adapter.status).toBe('waiting_input');
      expect(adapter.getDetectionExplanation()).toMatchObject({
        rawState: 'unknown',
        state: 'blocked',
        stabilization: 'skipped',
      });
    } finally {
      if (previousMode === undefined) delete process.env.SWARMIE_DETECTION_MODE;
      else process.env.SWARMIE_DETECTION_MODE = previousMode;
    }
  });
});
