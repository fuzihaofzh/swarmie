export const IDLE_RETENTION_MS = 60 * 60 * 1000;
const STORAGE_KEY = 'swarmie-agent-status-times';

interface AgentStatus {
  id: string;
  status: string;
  statusChangedAt?: number;
  stateChangeSeq?: number;
}
type Stamp = { status: string; since: number; seq?: number };

function readStamps(): Record<string, Stamp> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Recover the current idle period from servers started before statusChangedAt
 * was introduced. A session's creation time says nothing about its idle age. */
export function idleTimeFromHistory(session: AgentStatus & {
  recentEvents?: { type: string; timestamp: number; data: Record<string, unknown> }[];
}): number | undefined {
  if (session.status !== 'idle') return;
  if (validTime(session.statusChangedAt)) return session.statusChangedAt;
  for (const event of [...(session.recentEvents ?? [])].reverse()) {
    if (event.type !== 'status:change') continue;
    if (event.data.to !== 'idle') return;
    if (event.data.from === 'idle') continue;
    if (typeof event.data.from === 'string' && validTime(event.timestamp)) return event.timestamp;
    return;
  }
}

/** Older servers lack status timestamps. Persist the first observation so
 * reconnecting or closing the sidebar doesn't restart the idle hour. */
export function rememberAgentStatus<T extends AgentStatus>(session: T, now = Date.now()): T & { statusChangedAt: number } {
  const stamps = readStamps();
  const previous = stamps[session.id];
  let since = session.statusChangedAt;
  if (!validTime(since)) {
    since = previous?.status === session.status && previous.seq === session.stateChangeSeq && validTime(previous.since)
      ? previous.since : now;
    // Migrate the old Done acknowledgement clock, which already measures
    // entry into idle. Never infer idle time from the session's launch time.
    if (!previous && session.status === 'idle') {
      try {
        const acknowledged = JSON.parse(localStorage.getItem('swarmie.ackedDoneAt') ?? '{}')[session.id];
        if (validTime(acknowledged)) since = acknowledged;
      } catch { /* use the first observation */ }
    }
  }
  if (previous?.status !== session.status || previous.since !== since || previous.seq !== session.stateChangeSeq) {
    stamps[session.id] = { status: session.status, since, seq: session.stateChangeSeq };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stamps)); } catch { /* storage unavailable */ }
  }
  return { ...session, statusChangedAt: since };
}

export function isLongIdle(session: AgentStatus, now: number): boolean {
  // Done is an unread notification, not an idle timeout candidate.
  return session.status === 'idle' && validTime(session.statusChangedAt)
    && now - session.statusChangedAt >= IDLE_RETENTION_MS;
}
