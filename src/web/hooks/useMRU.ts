import { useEffect, useRef } from 'react';
import { useSessionStore } from './useSessions';

/**
 * Tracks most-recently-used session order.
 * Returns a ref to the MRU list (array of session IDs, most recent first).
 */
export function useMRU() {
  const mruRef = useRef<string[]>([]);

  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      // Active session changed → move to front of MRU
      if (state.activeSessionId && state.activeSessionId !== prev.activeSessionId) {
        const mru = mruRef.current.filter((id) => id !== state.activeSessionId);
        mru.unshift(state.activeSessionId);
        mruRef.current = mru;
      }

      // Remove sessions that no longer exist
      const ids = new Set(state.sessions.map((s) => s.id));
      mruRef.current = mruRef.current.filter((id) => ids.has(id));

      // Add any new sessions not yet in MRU
      for (const s of state.sessions) {
        if (!mruRef.current.includes(s.id)) {
          mruRef.current.push(s.id);
        }
      }
    });

    // Initialize with current sessions
    const { sessions, activeSessionId } = useSessionStore.getState();
    const ids = sessions.map((s) => s.id);
    if (activeSessionId) {
      mruRef.current = [activeSessionId, ...ids.filter((id) => id !== activeSessionId)];
    } else {
      mruRef.current = ids;
    }

    return unsub;
  }, []);

  return mruRef;
}
