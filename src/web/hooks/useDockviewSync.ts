import { useEffect, useRef } from 'react';
import type { DockviewApi } from 'dockview';
import { useSessionStore, type SessionSummary } from './useSessions';
import { useUIStore } from './useUI';
import { NEW_SESSION_PANEL_ID } from '../components/DockviewCustomTab';

/**
 * Syncs Zustand session state ↔ Dockview panels.
 * - Session added → addPanel
 * - Session removed → panel.close()
 * - Zustand activeSessionId changed → panel.setActive()
 * - Dockview active panel changed → update Zustand
 * - showNewSession → add/activate new-session panel
 */
export function useDockviewSync(api: DockviewApi | null) {
  const prevSessionIdsRef = useRef<Set<string>>(new Set());
  const suppressZustandSync = useRef(false);

  // Sync sessions → panels
  useEffect(() => {
    if (!api) return;

    const unsub = useSessionStore.subscribe((state, prev) => {
      const currentIds = new Set(state.sessions.map((s) => s.id));
      const prevIds = prevSessionIdsRef.current;

      // Added sessions
      for (const session of state.sessions) {
        if (!prevIds.has(session.id)) {
          // Check if panel already exists (e.g., from initial load)
          if (!api.getPanel(session.id)) {
            api.addPanel({
              id: session.id,
              component: 'terminal',
              tabComponent: 'sessionTab',
              params: { sessionId: session.id },
              renderer: 'always',
            });
          }
        }
      }

      // Removed sessions
      for (const id of prevIds) {
        if (!currentIds.has(id)) {
          const panel = api.getPanel(id);
          if (panel) {
            suppressZustandSync.current = true;
            api.removePanel(panel);
            suppressZustandSync.current = false;
          }
        }
      }

      prevSessionIdsRef.current = currentIds;

      // Active session changed in Zustand → activate panel in Dockview
      if (state.activeSessionId !== prev.activeSessionId && state.activeSessionId) {
        const panel = api.getPanel(state.activeSessionId);
        if (panel && !panel.api.isActive) {
          suppressZustandSync.current = true;
          panel.api.setActive();
          suppressZustandSync.current = false;
        }
      }
    });

    return unsub;
  }, [api]);

  // Dockview active panel → Zustand
  useEffect(() => {
    if (!api) return;

    const disposable = api.onDidActivePanelChange((e) => {
      if (suppressZustandSync.current) return;
      if (!e) return;

      const panelId = e.id;
      if (panelId === NEW_SESSION_PANEL_ID) {
        useUIStore.getState().setShowNewSession(true);
      } else {
        useSessionStore.getState().setActiveSession(panelId);
        useUIStore.getState().setShowNewSession(false);
      }
    });

    return () => disposable.dispose();
  }, [api]);

  // showNewSession → add/activate new session panel
  useEffect(() => {
    if (!api) return;

    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.showNewSession && !prev.showNewSession) {
        let panel = api.getPanel(NEW_SESSION_PANEL_ID);
        if (!panel) {
          api.addPanel({
            id: NEW_SESSION_PANEL_ID,
            component: 'newSession',
            tabComponent: 'newSessionTab',
            params: {},
            renderer: 'onlyWhenVisible',
          });
          panel = api.getPanel(NEW_SESSION_PANEL_ID);
        }
        if (panel && !panel.api.isActive) {
          panel.api.setActive();
        }
      } else if (!state.showNewSession && prev.showNewSession) {
        const panel = api.getPanel(NEW_SESSION_PANEL_ID);
        if (panel) {
          suppressZustandSync.current = true;
          api.removePanel(panel);
          suppressZustandSync.current = false;
        }
      }
    });

    return unsub;
  }, [api]);

  // Initialize existing sessions as panels on first api ready
  useEffect(() => {
    if (!api) return;

    const sessions = useSessionStore.getState().sessions;
    const activeId = useSessionStore.getState().activeSessionId;

    for (const session of sessions) {
      if (!api.getPanel(session.id)) {
        api.addPanel({
          id: session.id,
          component: 'terminal',
          tabComponent: 'sessionTab',
          params: { sessionId: session.id },
          renderer: 'always',
        });
      }
    }

    prevSessionIdsRef.current = new Set(sessions.map((s: SessionSummary) => s.id));

    // Activate the right panel
    if (activeId) {
      const panel = api.getPanel(activeId);
      if (panel) panel.api.setActive();
    }

    // If showNewSession or no sessions, show new session panel
    if (useUIStore.getState().showNewSession || sessions.length === 0) {
      useUIStore.getState().setShowNewSession(true);
    }
  }, [api]);
}
