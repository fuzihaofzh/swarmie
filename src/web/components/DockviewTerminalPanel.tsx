import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { TerminalView } from './TerminalView';
import { useTerminalWebSocket } from '../hooks/useTerminalWebSocket';
import { useSessionStore } from '../hooks/useSessions';
import { useUIStore } from '../hooks/useUI';

export interface TerminalPanelParams {
  sessionId: string;
}

export function DockviewTerminalPanel({ api, params }: IDockviewPanelProps<TerminalPanelParams>) {
  const sessionId = params.sessionId;
  const [active, setActive] = useState(api.isActive);
  const { sendInput, sendResize, sendRedraw, sendLoadHistory } = useTerminalWebSocket(sessionId, active);

  // Track active state from dockview
  useEffect(() => {
    const disposable = api.onDidActiveChange((e) => {
      setActive(e.isActive);
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
      isActive={active}
      onInput={sendInput}
      onResize={sendResize}
      onRedraw={sendRedraw}
      onLoadHistory={sendLoadHistory}
    />
  );
}
