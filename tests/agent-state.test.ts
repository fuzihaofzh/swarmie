import { describe, expect, it } from 'vitest';
import { agentStateGroup, agentStatePriority, countAgentStates } from '../src/web/agentState';

describe('workspace attention states', () => {
  it('keeps errors visible in the blocked filter and ahead of working agents', () => {
    const sessions = ['idle', 'thinking', 'error', 'waiting_input', 'completed', 'blocked'].map((status) => ({ status }));
    const counts = countAgentStates(sessions);
    const blocked = sessions.filter((session) => agentStateGroup(session.status) === 'blocked');
    expect(blocked.map((session) => session.status)).toEqual(['error', 'waiting_input', 'blocked']);
    expect(counts.blocked).toBe(blocked.length);
    expect(counts.idle).toBe(1);
    expect(agentStatePriority('error')).toBeLessThan(agentStatePriority('thinking'));
  });

  it('counts every session exactly once, including startup and unknown states', () => {
    const sessions = ['starting', 'running', 'tool_executing', 'done', 'unknown'].map((status) => ({ status }));
    expect(countAgentStates(sessions)).toEqual({ total: 5, working: 3, blocked: 0, done: 1, idle: 1 });
  });
});
