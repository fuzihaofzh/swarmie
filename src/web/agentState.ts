const BUSY = new Set(['starting', 'running', 'thinking', 'tool_executing']);

export function agentStateGroup(status: string): 'working' | 'blocked' | 'done' | 'idle' {
  if (status === 'waiting_input' || status === 'blocked' || status === 'error') return 'blocked';
  if (status === 'done' || status === 'completed') return 'done';
  return BUSY.has(status) ? 'working' : 'idle';
}

export function agentStatePriority(status: string): number {
  return { blocked: 0, working: 1, done: 2, idle: 3 }[agentStateGroup(status)];
}

export function countAgentStates(sessions: { status: string }[]) {
  const counts = { total: sessions.length, working: 0, blocked: 0, done: 0, idle: 0 };
  for (const session of sessions) counts[agentStateGroup(session.status)]++;
  return counts;
}
