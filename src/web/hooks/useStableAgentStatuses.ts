import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentStatusDisplay, isWorkingStatus } from '../agentStatusDisplay';
import type { SessionSummary } from './useSessions';

export function useStableAgentStatuses(sessions: SessionSummary[]): SessionSummary[] {
  const tracker = useRef(new AgentStatusDisplay());
  const [displayed, setDisplayed] = useState(sessions);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = Date.now();
      const result = tracker.current.update(sessions, now);
      setDisplayed(result.sessions);
      if (result.nextUpdateAt !== undefined) timer = setTimeout(update, result.nextUpdateAt - now);
    };
    update();
    return () => clearTimeout(timer);
  }, [sessions]);

  // Fresh metadata and all non-idle states are visible in the current render;
  // only the transition from working to idle waits for confirmation.
  return useMemo(() => sessions.map((session) => {
    const previous = displayed.find((s) => s.id === session.id && s.serverUrl === session.serverUrl);
    return session.status === 'idle' && previous && isWorkingStatus(previous.status)
      ? { ...session, status: previous.status } : session;
  }), [sessions, displayed]);
}
