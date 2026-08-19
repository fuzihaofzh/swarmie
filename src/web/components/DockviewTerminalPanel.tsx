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
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const tileLayoutEnabled = useUIStore((s) => s.tileLayoutEnabled);
  const [dockActive, setDockActive] = useState(api.isActive);
  // Zustand is the cross-component source of truth; fall back to dockview
  // only before the initial session selection has been established.
  // In tiled mode every pane must stay mounted and visible. The normal
  // tabbed mode still keeps a single focused terminal for keyboard input.
  const active = tileLayoutEnabled || (activeSessionId ? activeSessionId === sessionId : dockActive);
  const { sendInput, sendResize, sendRedraw, sendLoadHistory, sendClipboardImage } = useTerminalWebSocket(sessionId, active);

  // Track active state from dockview
  useEffect(() => {
    setDockActive(api.isActive);
    if (api.isActive) {
      useSessionStore.getState().setActiveSession(sessionId);
    }
    const disposable = api.onDidActiveChange((e) => {
      setDockActive(e.isActive);
      if (e.isActive) {
        // Update Zustand when dockview activates this panel
        useSessionStore.getState().setActiveSession(sessionId);
      }
    });
    return () => disposable.dispose();
  }, [api, sessionId]);

  useEffect(() => {
    if (activeSessionId === sessionId && !api.isActive) {
      api.setActive();
    }
  }, [activeSessionId, api, sessionId]);

  return (
    <TerminalView
      sessionId={sessionId}
      isActive={active}
      onInput={sendInput}
      onResize={sendResize}
      onRedraw={sendRedraw}
      onLoadHistory={sendLoadHistory}
      onClipboardImagePaste={sendClipboardImage}
    />
  );
}
