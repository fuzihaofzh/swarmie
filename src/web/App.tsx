import { useEffect, useState, useMemo, useCallback } from 'react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewHeaderActionsProps } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { useMultiWebSocket } from './hooks/useMultiWebSocket';
import { useSessionStore } from './hooks/useSessions';
import { useUIStore } from './hooks/useUI';
import { useServerStore, type ConnectionStatus } from './hooks/useServers';
import { themes, applyTheme } from './themes';
import { useKeybindingStore, matchesBinding, formatBinding, DEFAULT_BINDINGS, ACTION_LABELS, type ActionId, type KeyBinding } from './hooks/useKeybindings';
import { WsContext, type WsFunctions } from './contexts/WsContext';
import { DockviewTerminalPanel } from './components/DockviewTerminalPanel';
import { DockviewNewSessionPanel } from './components/DockviewNewSessionPanel';
import { DockviewCustomTab, DockviewNewSessionTab } from './components/DockviewCustomTab';
import { useDockviewSync } from './hooks/useDockviewSync';
import { useMRU } from './hooks/useMRU';
import { TabSwitcher } from './components/TabSwitcher';

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

function MenuButton(_props: IDockviewHeaderActionsProps) {
  const toggleDrawer = useUIStore((s) => s.toggleDrawer);
  return (
    <button className="dv-menu-btn" onClick={toggleDrawer} title="Settings">
      <span /><span /><span />
    </button>
  );
}

export function App() {
  const wsFunctions = useMultiWebSocket();
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
    killSession: wsFunctions.killSession,
    getConnection: wsFunctions.getConnection,
  }), [wsFunctions.sendInput, wsFunctions.sendResize, wsFunctions.sendRedraw, wsFunctions.createSession, wsFunctions.killSession, wsFunctions.getConnection]);

  // Apply theme CSS variables
  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);

  // Sync Zustand ↔ Dockview
  useDockviewSync(api);

  // MRU tracking for Ctrl+Tab switcher
  const mruRef = useMRU();

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

  // Forward horizontal trackpad deltaX to tab bar scrollLeft
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      const target = e.target as HTMLElement;
      const container = target.closest('.dv-tabs-container') as HTMLElement;
      if (!container) return;
      container.scrollLeft += e.deltaX;
      e.preventDefault();
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

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
              <div className="drawer-section-header">Servers</div>
              <DrawerServers />
            </div>
            <div className="drawer-section">
              <div className="drawer-section-header">Settings</div>
              <DrawerSettings />
            </div>
            <div className="drawer-section">
              <div className="drawer-section-header">Keybindings</div>
              <KeybindingSettings />
            </div>
            <div className="drawer-section">
              <a href="/change-password" className="drawer-link">Change Password</a>
            </div>
          </div>
        </div>

        {/* Main area */}
        <div className="app-main">
          <DockviewReact
            className={`dockview-container ${currentTheme.isDark ? 'dockview-theme-dark' : 'dockview-theme-light'}`}
            onReady={onReady}
            components={components}
            tabComponents={tabComponents}
            prefixHeaderActionsComponent={MenuButton}
            rightHeaderActionsComponent={NewTabButton}
          />
        </div>
      </div>
      <TabSwitcher mruRef={mruRef} />
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

function KeybindingRecorder({ value, onChange, onCancel }: {
  value: KeyBinding;
  onChange: (b: KeyBinding) => void;
  onCancel: () => void;
}) {
  const [recording, setRecording] = useState(false);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Ignore bare modifier presses
    if (['Alt', 'Control', 'Meta', 'Shift'].includes(e.key)) return;
    onChange({
      code: e.code,
      alt: e.altKey || undefined,
      ctrl: e.ctrlKey || undefined,
      meta: e.metaKey || undefined,
      shift: e.shiftKey || undefined,
    });
    setRecording(false);
  }, [onChange]);

  useEffect(() => {
    if (!recording) return;
    window.addEventListener('keydown', handleKeyDown, true);
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setRecording(false); onCancel(); }
    };
    window.addEventListener('keyup', handleEsc, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleEsc, true);
    };
  }, [recording, handleKeyDown, onCancel]);

  return (
    <button
      className={`keybinding-key ${recording ? 'recording' : ''}`}
      onClick={() => setRecording(true)}
      title="Click to rebind, Esc to cancel"
    >
      {recording ? 'Press keys...' : formatBinding(value)}
    </button>
  );
}

function KeybindingSettings() {
  const getBinding = useKeybindingStore((s) => s.getBinding);
  const setBinding = useKeybindingStore((s) => s.setBinding);
  const resetBinding = useKeybindingStore((s) => s.resetBinding);
  const overrides = useKeybindingStore((s) => s.overrides);

  const actions = Object.keys(DEFAULT_BINDINGS) as ActionId[];

  return (
    <div className="settings-section">
      {actions.map((action) => {
        const binding = getBinding(action);
        const isCustom = !!overrides[action];
        return (
          <div key={action} className="setting-group keybinding-row">
            <label>{ACTION_LABELS[action]}</label>
            <div className="keybinding-controls">
              <KeybindingRecorder
                value={binding}
                onChange={(b) => setBinding(action, b)}
                onCancel={() => {}}
              />
              {isCustom && (
                <button
                  className="keybinding-reset"
                  onClick={() => resetBinding(action)}
                  title="Reset to default"
                >
                  &times;
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function statusDotColor(status: ConnectionStatus | undefined): string {
  switch (status) {
    case 'connected': return '#3fb950';
    case 'connecting': return '#d29922';
    case 'error': return '#f85149';
    default: return '#8b949e';
  }
}

function DrawerServers() {
  const servers = useServerStore((s) => s.servers);
  const connectionStatus = useServerStore((s) => s.connectionStatus);
  const addServer = useServerStore((s) => s.addServer);
  const removeServer = useServerStore((s) => s.removeServer);
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const normalized = trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;

    setAdding(true);
    setAuthError('');
    try {
      // Authenticate with remote server
      const res = await fetch(`${normalized}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setAuthError('Authentication failed');
        setAdding(false);
        return;
      }
      const data = await res.json();
      addServer(normalized, undefined, data.token);
      setUrl('');
      setPassword('');
    } catch {
      setAuthError('Cannot connect to server');
    }
    setAdding(false);
  };

  const localStatus = connectionStatus[''] ?? 'connecting';

  return (
    <div className="settings-section">
      {/* Local server — always shown, not removable */}
      <div className="server-entry">
        <span className="server-dot" style={{ background: statusDotColor(localStatus) }} />
        <span className="server-label">Local</span>
        <span className="server-url">{window.location.host}</span>
      </div>

      {/* Remote servers */}
      {servers.map((s) => (
        <div key={s.url} className="server-entry">
          <span className="server-dot" style={{ background: statusDotColor(connectionStatus[s.url]) }} />
          <span className="server-label">{s.label}</span>
          <button
            className="server-remove"
            onClick={() => removeServer(s.url)}
            title="Remove server"
          >
            &times;
          </button>
        </div>
      ))}

      {/* Add server input */}
      <div className="server-add-row">
        <input
          type="text"
          placeholder="host:port or URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button onClick={handleAdd} disabled={!url.trim() || !password || adding}>
          {adding ? '...' : 'Add'}
        </button>
      </div>
      {authError && <div className="server-auth-error">{authError}</div>}
    </div>
  );
}
