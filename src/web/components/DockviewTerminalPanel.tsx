import { useEffect } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { TerminalView } from './TerminalView';
import { useWsContext } from '../contexts/WsContext';
import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';

export interface TerminalPanelParams {
  sessionId: string;
}

export function DockviewTerminalPanel({ api, params }: IDockviewPanelProps<TerminalPanelParams>) {
  const { sendInput, sendResize, sendRedraw } = useWsContext();
  const sessionId = params.sessionId;

  // Track active state from dockview
  useEffect(() => {
    const disposable = api.onDidActiveChange((e) => {
      if (e.isActive) {
        // Update Zustand when dockview activates this panel
        useSessionStore.getState().setActiveSession(sessionId);
        useUIStore.getState().setShowNewSession(false);
      }
    });
    return () => disposable.dispose();
  }, [api, sessionId]);

  return (
    <TerminalView
      sessionId={sessionId}
      isActive={api.isActive}
      onInput={(data) => sendInput(sessionId, data)}
      onResize={(cols, rows) => sendResize(sessionId, cols, rows)}
      onRedraw={() => sendRedraw(sessionId)}
    />
  );
}
