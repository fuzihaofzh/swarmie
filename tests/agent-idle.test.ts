import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_RETENTION_MS, idleTimeFromHistory, isLongIdle, rememberAgentStatus } from '../src/web/agentIdle';

describe('idle agent retention', () => {
  const now = 10 * IDLE_RETENTION_MS;
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('only hides idle after a full hour; unread Done never expires', () => {
    for (const status of ['done', 'completed', 'waiting_input', 'running', 'thinking', 'error']) {
      expect(isLongIdle({ id: status, status, statusChangedAt: 1 }, now)).toBe(false);
    }
    expect(isLongIdle({ id: 'a', status: 'idle', statusChangedAt: now - IDLE_RETENTION_MS + 1 }, now)).toBe(false);
    expect(isLongIdle({ id: 'a', status: 'idle', statusChangedAt: now - IDLE_RETENTION_MS }, now)).toBe(true);
  });

  it('persists the fallback across reconnects without using session age', () => {
    const session = { id: 'old-server', status: 'idle', startTime: 1, stateChangeSeq: 3 };
    expect(rememberAgentStatus(session, now).statusChangedAt).toBe(now);
    const reconnect = rememberAgentStatus(session, now + IDLE_RETENTION_MS);
    expect(reconnect.statusChangedAt).toBe(now);
    expect(isLongIdle(reconnect, now + IDLE_RETENTION_MS)).toBe(true);
    expect(rememberAgentStatus({ ...session, stateChangeSeq: 5 }, now + IDLE_RETENTION_MS).statusChangedAt)
      .toBe(now + IDLE_RETENTION_MS);
  });

  it('starts the idle hour at acknowledgement, not at task completion', () => {
    rememberAgentStatus({ id: 'done', status: 'done', statusChangedAt: 1 }, now);
    const idle = rememberAgentStatus({ id: 'done', status: 'idle' }, now);
    expect(idle.statusChangedAt).toBe(now);
    expect(isLongIdle(idle, now)).toBe(false);
  });

  it('restores the server clock and migrates previously acknowledged agents', () => {
    localStorage.setItem('swarmie.ackedDoneAt', JSON.stringify({ migrated: now - IDLE_RETENTION_MS }));
    expect(isLongIdle(rememberAgentStatus({ id: 'migrated', status: 'idle' }, now), now)).toBe(true);
    const server = rememberAgentStatus({ id: 'server', status: 'idle', statusChangedAt: now - IDLE_RETENTION_MS }, now);
    expect(isLongIdle(server, now)).toBe(true);
    expect(isLongIdle({ ...server, status: 'running' }, now)).toBe(false);
  });

  it('recovers legacy idle age from the latest transition, ignoring duplicate idle events', () => {
    const event = (from: string, to: string, timestamp: number) => ({ type: 'status:change', timestamp, data: { from, to } });
    const session = { id: 'legacy', status: 'idle', recentEvents: [
      event('running', 'idle', 1), event('idle', 'running', 2),
      event('running', 'done', 3), event('done', 'idle', now - IDLE_RETENTION_MS),
      event('idle', 'idle', now),
    ] };
    expect(idleTimeFromHistory(session)).toBe(now - IDLE_RETENTION_MS);
    expect(idleTimeFromHistory({ ...session, status: 'done' })).toBeUndefined();
    expect(idleTimeFromHistory({ ...session, recentEvents: [event('running', 'done', 3)] })).toBeUndefined();
    expect(idleTimeFromHistory({ ...session, recentEvents: [event('idle', 'idle', now)] })).toBeUndefined();
  });
});
