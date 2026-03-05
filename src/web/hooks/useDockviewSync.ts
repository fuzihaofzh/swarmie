import { useEffect, useRef } from 'react';
import type { DockviewApi } from 'dockview';
import { useSessionStore, type SessionSummary } from './useSessions';
import { useUIStore } from './useUI';
import { NEW_SESSION_PANEL_ID } from '../components/DockviewCustomTab';

const LAYOUT_KEY = 'swarmie-dockview-layout';

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

  // Save layout on changes (debounced)
  useEffect(() => {
    if (!api) return;

    let timer: ReturnType<typeof setTimeout>;
    const disposable = api.onDidLayoutChange(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
        } catch { /* ignore quota errors */ }
      }, 500);
    });

    return () => {
      clearTimeout(timer);
      disposable.dispose();
    };
  }, [api]);

  // Initialize existing sessions as panels on first api ready
  useEffect(() => {
    if (!api) return;

    const sessions = useSessionStore.getState().sessions;
    const activeId = useSessionStore.getState().activeSessionId;
    const sessionIds = new Set(sessions.map((s: SessionSummary) => s.id));
    let restored = false;

    // Try restoring saved layout
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const savedLayout = JSON.parse(raw);
        api.fromJSON(savedLayout);
        restored = true;

        // Remove the transient new-session panel if it was in the saved layout
        const newSessionPanel = api.getPanel(NEW_SESSION_PANEL_ID);
        if (newSessionPanel) {
          suppressZustandSync.current = true;
          api.removePanel(newSessionPanel);
          suppressZustandSync.current = false;
        }

        // Track all panel IDs that fromJSON restored so the sync
        // subscription can properly diff when sessions arrive from WS.
        const restoredIds = new Set(api.panels.map((p) => p.id));
        prevSessionIdsRef.current = restoredIds;

        // Only reconcile if sessions have already loaded (non-empty).
        // If empty, the sync subscription will handle reconciliation
        // when setSessions fires from WS.
        if (sessions.length > 0) {
          // Remove panels for sessions that no longer exist
          for (const panel of [...api.panels]) {
            if (panel.id !== NEW_SESSION_PANEL_ID && !sessionIds.has(panel.id)) {
              suppressZustandSync.current = true;
              api.removePanel(panel);
              suppressZustandSync.current = false;
            }
          }
          prevSessionIdsRef.current = sessionIds;

          // Add panels for new sessions not in saved layout
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
        }
      }
    } catch {
      restored = false;
    }

    // Fallback: add panels one by one
    if (!restored) {
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
      prevSessionIdsRef.current = sessionIds;
    }

    // Activate the right panel
    if (activeId) {
      const panel = api.getPanel(activeId);
      if (panel) panel.api.setActive();
    }

    if (useUIStore.getState().showNewSession) {
      useUIStore.getState().setShowNewSession(true);
    }
  }, [api]);

  // When sessions change and there are none left, auto-show new session panel.
  // Skip the very first render (sessions empty before WS connects) by using a ref.
  const wsDeliveredRef = useRef(false);
  useEffect(() => {
    if (!api) return;

    const unsub = useSessionStore.subscribe((state, prev) => {
      // Mark that WS has delivered sessions at least once
      if (!wsDeliveredRef.current && (state.sessions !== prev.sessions)) {
        wsDeliveredRef.current = true;
      }
      if (!wsDeliveredRef.current) return;

      // If all sessions removed, show new session panel
      if (state.sessions.length === 0 && !useUIStore.getState().showNewSession) {
        useUIStore.getState().setShowNewSession(true);
      }
    });

    return unsub;
  }, [api]);
}
