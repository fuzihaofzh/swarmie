import type { IDockviewPanelProps } from 'dockview';
import { NewSessionPage } from './NewSessionPage';
import { useWsContext } from '../contexts/WsContext';
import { useSessionStore } from '../hooks/useSessions';

export function DockviewNewSessionPanel({ api }: IDockviewPanelProps) {
  const { createSession } = useWsContext();
  const sessions = useSessionStore((s) => s.sessions);

  return (
    <NewSessionPage
      onCreateSession={async (opts) => {
        const result = await createSession(opts);
        if (result) {
          useSessionStore.getState().setActiveSession(result.id);
          // Close the new-session panel
          api.close();
        }
        return result;
      }}
      onCancel={sessions.length > 0 ? () => api.close() : undefined}
    />
  );
}
