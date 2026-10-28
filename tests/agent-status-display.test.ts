import { describe, expect, it } from 'vitest';
import { AgentStatusDisplay, IDLE_DISPLAY_CONFIRM_MS } from '../src/web/agentStatusDisplay';

describe('sidebar idle confirmation', () => {
  const sample = (status: string) => ({ id: 'agent', serverUrl: '', status });

  it('holds short idle redraws but settles a real idle without resetting the deadline', () => {
    const display = new AgentStatusDisplay();
    const update = (status: string, now: number) => display.update([sample(status)], now);
    update('running', 0);
    for (let now = 100; now < 10000; now += 1000) {
      expect(update('idle', now).sessions[0].status).toBe('running');
      expect(update('running', now + 100).sessions[0].status).toBe('running');
    }
    expect(update('idle', 10000).nextUpdateAt).toBe(10000 + IDLE_DISPLAY_CONFIRM_MS);
    expect(update('idle', 11000).nextUpdateAt).toBe(10000 + IDLE_DISPLAY_CONFIRM_MS);
    expect(update('idle', 10000 + IDLE_DISPLAY_CONFIRM_MS)).toEqual({ sessions: [sample('idle')], nextUpdateAt: undefined });
  });

  it.each(['done', 'waiting_input', 'completed', 'error'])('publishes %s immediately, cancelling any idle hold', (status) => {
    const display = new AgentStatusDisplay();
    display.update([sample('running')], 0);
    display.update([sample('idle')], 1);
    expect(display.update([sample(status)], 2)).toEqual({ sessions: [sample(status)], nextUpdateAt: undefined });
    expect(display.update([sample('idle')], 3).sessions[0].status).toBe('idle');
  });

  it('does not inherit working state across removal or another server', () => {
    const display = new AgentStatusDisplay();
    display.update([sample('running')], 0);
    expect(display.update([{ ...sample('idle'), serverUrl: 'remote' }], 1).sessions[0].status).toBe('idle');
    display.update([], 2);
    expect(display.update([sample('idle')], 3).sessions[0].status).toBe('idle');
  });
});
