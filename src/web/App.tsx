import { useEffect, useState, useMemo } from 'react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewHeaderActionsProps } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessions';
import { useUIStore } from './hooks/useUI';
import { themes, applyTheme } from './themes';
import { WsContext, type WsFunctions } from './contexts/WsContext';
import { DockviewTerminalPanel } from './components/DockviewTerminalPanel';
import { DockviewNewSessionPanel } from './components/DockviewNewSessionPanel';
import { DockviewCustomTab, DockviewNewSessionTab } from './components/DockviewCustomTab';
import { useDockviewSync } from './hooks/useDockviewSync';

const components = {
  terminal: DockviewTerminalPanel,
  newSession: DockviewNewSessionPanel,
};

const tabComponents = {
  sessionTab: DockviewCustomTab,
  newSessionTab: DockviewNewSessionTab,
};

function NewTabButton(_props: IDockviewHeaderActionsProps) {
  return (
    <button
      className="dv-new-tab-btn"
      onClick={() => useUIStore.getState().setShowNewSession(true)}
      title="New Session"
    >
      +
    </button>
  );
}

export function App() {
  const wsFunctions = useWebSocket();
  const [api, setApi] = useState<DockviewApi | null>(null);

  const drawerOpen = useUIStore((s) => s.drawerOpen);
  const toggleDrawer = useUIStore((s) => s.toggleDrawer);
  const themeName = useUIStore((s) => s.theme);
  const currentTheme = themes[themeName] ?? themes['github-dark'];

  const wsContext = useMemo<WsFunctions>(() => ({
    sendInput: wsFunctions.sendInput,
    sendResize: wsFunctions.sendResize,
    sendRedraw: wsFunctions.sendRedraw,
    createSession: wsFunctions.createSession,
  }), [wsFunctions.sendInput, wsFunctions.sendResize, wsFunctions.sendRedraw, wsFunctions.createSession]);

  // Apply theme CSS variables
  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);

  // Sync Zustand ↔ Dockview
  useDockviewSync(api);

  // Cmd+Left / Cmd+Right to switch tabs within active group, Ctrl+Cmd+T for new tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === 't' && e.ctrlKey) {
        e.preventDefault();
        useUIStore.getState().setShowNewSession(true);
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (!api) return;
      const group = api.activeGroup;
      if (!group) return;
      const panels = group.panels;
      if (panels.length < 2) return;
      e.preventDefault();
      const activePanel = api.activePanel;
      const idx = panels.findIndex((p) => p === activePanel);
      const next = e.key === 'ArrowRight'
        ? (idx + 1) % panels.length
        : (idx - 1 + panels.length) % panels.length;
      panels[next].api.setActive();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [api]);

  const onReady = (event: DockviewReadyEvent) => {
    setApi(event.api);
  };

  return (
    <WsContext value={wsContext}>
      <div className="app-layout">
        {/* Overlay */}
        <div
          className={`overlay ${drawerOpen ? 'open' : ''}`}
          onClick={toggleDrawer}
        />

        {/* Drawer */}
        <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
          <div className="drawer-header">
            <h3>swarmie</h3>
            <button className="drawer-close" onClick={toggleDrawer}>
              &times;
            </button>
          </div>
          <div className="drawer-content">
            <div className="drawer-section">
              <div className="drawer-section-header">Settings</div>
              <DrawerSettings />
            </div>
          </div>
        </div>

        {/* Main area */}
        <div className="app-main">
          {/* Hamburger menu — global, not per-group */}
          <button className="dv-menu-btn-global" onClick={toggleDrawer} title="Settings">
            <span /><span /><span />
          </button>
          <DockviewReact
            className={`dockview-container ${currentTheme.isDark ? 'dockview-theme-dark' : 'dockview-theme-light'}`}
            onReady={onReady}
            components={components}
            tabComponents={tabComponents}
            rightHeaderActionsComponent={NewTabButton}
          />
        </div>
      </div>
    </WsContext>
  );
}

function DrawerSettings() {
  const themeName = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const bellSound = useUIStore((s) => s.bellSound);
  const setTheme = useUIStore((s) => s.setTheme);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const setBellSound = useUIStore((s) => s.setBellSound);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId),
  );
  const setSessionAutoApprove = useSessionStore((s) => s.setSessionAutoApprove);
  const autoApprove = !!activeSession?.autoApprove;

  return (
    <div className="settings-section">
      <div className="setting-group">
        <label>Theme</label>
        <select value={themeName} onChange={(e) => setTheme(e.target.value)}>
          {Object.values(themes).map((t) => (
            <option key={t.name} value={t.name}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-group">
        <label>Font Size</label>
        <div className="font-size-row">
          <input
            type="range"
            min="10"
            max="24"
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
          <span>{fontSize}px</span>
        </div>
      </div>
      <div className="setting-group">
        <label>Font</label>
        <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}>
          <option value="'SF Mono', Monaco, Menlo, monospace">SF Mono</option>
          <option value="'Fira Code', monospace">Fira Code</option>
          <option value="'JetBrains Mono', monospace">JetBrains Mono</option>
          <option value="'Cascadia Code', monospace">Cascadia Code</option>
          <option value="'Source Code Pro', monospace">Source Code Pro</option>
          <option value="Consolas, monospace">Consolas</option>
          <option value="monospace">System Monospace</option>
        </select>
      </div>
      <div className="setting-group">
        <label className="toggle-label">
          <span>Bell Sound</span>
          <button
            className={`toggle-switch ${bellSound ? 'on' : ''}`}
            onClick={() => setBellSound(!bellSound)}
            aria-label="Toggle bell sound"
          >
            <span className="toggle-knob" />
          </button>
        </label>
      </div>
      <div className="setting-group">
        <label className="toggle-label">
          <span>Auto-approve</span>
          <button
            className={`toggle-switch ${autoApprove ? 'on' : ''}`}
            onClick={() => activeSessionId && setSessionAutoApprove(activeSessionId, !autoApprove)}
            disabled={!activeSessionId}
            aria-label="Toggle auto-approve for active session"
          >
            <span className="toggle-knob" />
          </button>
        </label>
      </div>
    </div>
  );
}
