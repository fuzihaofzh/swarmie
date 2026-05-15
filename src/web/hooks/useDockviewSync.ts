import { useEffect, useRef } from 'react';
import type { DockviewApi } from 'dockview';
import { useSessionStore, type SessionSummary } from './useSessions';
import { useUIStore } from './useUI';
import { NEW_SESSION_PANEL_ID } from '../components/DockviewCustomTab';

const LAYOUT_KEY_DESKTOP = 'swarmie-dockview-layout';
const LAYOUT_KEY_MOBILE = 'swarmie-dockview-layout-mobile';
const MOBILE_VIEWPORT_BREAKPOINT = 768;

function getLayoutKey(): string {
  if (typeof window === 'undefined') return LAYOUT_KEY_DESKTOP;
  return window.innerWidth < MOBILE_VIEWPORT_BREAKPOINT ? LAYOUT_KEY_MOBILE : LAYOUT_KEY_DESKTOP;
}

function sessionMatchesTagFilter(session: SessionSummary, tagFilter: string[]): boolean {
  if (tagFilter.length === 0) return true;
  return (session.tags ?? []).some((tag) => tagFilter.includes(tag));
}

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

  // Filter changes never add/remove panels — panels stay alive for all
  // sessions, the tab header is hidden via CSS for filtered-out sessions.
  // Destroying the panel would dispose its xterm and lose terminal content.
  // We only enforce that the active session matches the filter, so a hidden
  // tab doesn't end up as the visible content.
  const reconcileActiveForFilter = (sessions: SessionSummary[], tagFilter: string[]) => {
    if (!api) return;
    const activeId = useSessionStore.getState().activeSessionId;
    const activeSession = activeId ? sessions.find((s) => s.id === activeId) : undefined;
    if (activeSession && !sessionMatchesTagFilter(activeSession, tagFilter)) {
      const firstVisible = sessions.find((s) => sessionMatchesTagFilter(s, tagFilter));
      useSessionStore.getState().setActiveSession(firstVisible?.id ?? null);
      if (firstVisible) {
        const panel = api.getPanel(firstVisible.id);
        if (panel && !panel.api.isActive) {
          suppressZustandSync.current = true;
          panel.api.setActive();
          suppressZustandSync.current = false;
        }
      }
    }
  };

  // Sync sessions → panels
  useEffect(() => {
    if (!api) return;

    const unsub = useSessionStore.subscribe((state, prev) => {
      const currentIds = new Set(state.sessions.map((s) => s.id));
      const prevIds = prevSessionIdsRef.current;

      // Added sessions — create a panel regardless of filter; the tab is
      // hidden via CSS if the session doesn't match the active filter.
      for (const session of state.sessions) {
        if (!prevIds.has(session.id) && !api.getPanel(session.id)) {
          api.addPanel({
            id: session.id,
            component: 'terminal',
            tabComponent: 'sessionTab',
            params: { sessionId: session.id },
            renderer: 'always',
          });
        }
      }

      // Removed sessions (truly removed from the store — kill/end)
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
        const tagFilter = useUIStore.getState().tagFilter;
        const activeSession = state.sessions.find((s) => s.id === state.activeSessionId);
        if (activeSession && !sessionMatchesTagFilter(activeSession, tagFilter)) return;
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

  // showNewSession/tag filter → add/activate new session panel or reconcile visible tabs
  useEffect(() => {
    if (!api) return;

    const unsub = useUIStore.subscribe((state, prev) => {
      if (state.tagFilter !== prev.tagFilter) {
        reconcileActiveForFilter(useSessionStore.getState().sessions, state.tagFilter);
      }
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
          localStorage.setItem(getLayoutKey(), JSON.stringify(api.toJSON()));
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
    const tagFilter = useUIStore.getState().tagFilter;
    const sessionIds = new Set(sessions.map((s: SessionSummary) => s.id));
    let restored = false;

    // Try restoring saved layout
    try {
      const raw = localStorage.getItem(getLayoutKey());
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

          // Add panels for new sessions not in saved layout (all sessions,
          // not just filter-visible — filter only hides the tab header).
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

    // Fallback: add panels one by one (all sessions; filter only hides tabs)
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

    // Activate the right panel — must satisfy the active tag filter so a
    // CSS-hidden tab doesn't end up as the visible content.
    const firstVisible = sessions.find((s) => sessionMatchesTagFilter(s, tagFilter));
    const activeSession = activeId ? sessions.find((s) => s.id === activeId) : undefined;
    const activeIsVisible = activeSession ? sessionMatchesTagFilter(activeSession, tagFilter) : false;
    if (activeId && activeIsVisible) {
      const panel = api.getPanel(activeId);
      if (panel) panel.api.setActive();
    } else if (firstVisible) {
      useSessionStore.getState().setActiveSession(firstVisible.id);
      const panel = api.getPanel(firstVisible.id);
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
