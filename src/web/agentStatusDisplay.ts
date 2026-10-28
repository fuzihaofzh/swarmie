export const IDLE_DISPLAY_CONFIRM_MS = 1500;

interface AgentStatus {
  id: string;
  serverUrl: string;
  status: string;
}

export function isWorkingStatus(status: string): boolean {
  return status === 'running' || status === 'thinking' || status === 'tool_executing';
}

/** Presentation only: older servers may publish idle between partial redraws.
 * Never change acknowledgement state or suppress a Done/approval notification. */
export class AgentStatusDisplay {
  private states = new Map<string, { status: string; idleSince?: number }>();

  update<T extends AgentStatus>(sessions: T[], now: number): { sessions: T[]; nextUpdateAt?: number } {
    const next = new Map<string, { status: string; idleSince?: number }>();
    let nextUpdateAt: number | undefined;
    const displayed = sessions.map((session) => {
      const key = JSON.stringify([session.serverUrl, session.id]);
      const previous = this.states.get(key);
      if (session.status === 'idle' && previous && isWorkingStatus(previous.status)) {
        const idleSince = previous.idleSince ?? now;
        const deadline = idleSince + IDLE_DISPLAY_CONFIRM_MS;
        if (now < deadline) {
          next.set(key, { status: previous.status, idleSince });
          nextUpdateAt = Math.min(nextUpdateAt ?? deadline, deadline);
          return { ...session, status: previous.status };
        }
      }
      next.set(key, { status: session.status });
      return session;
    });
    this.states = next;
    return { sessions: displayed, nextUpdateAt };
  }
}
