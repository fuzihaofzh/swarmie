import { useEffect, useState, useMemo, useCallback } from 'react';
import { DockviewReact, type DockviewReadyEvent, type DockviewApi, type IDockviewHeaderActionsProps } from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { useMultiWebSocket } from './hooks/useMultiWebSocket';
import { useSessionStore } from './hooks/useSessions';
import { useUIStore } from './hooks/useUI';
import { useServerStore, type ConnectionStatus } from './hooks/useServers';
import { themes, applyTheme } from './themes';
import { useKeybindingStore, matchesBinding, formatBinding, DEFAULT_BINDINGS, ACTION_LABELS, type ActionId, type KeyBinding } from './hooks/useKeybindings';
import { WsContext, useWsContext, type WsFunctions } from './contexts/WsContext';
import { DockviewTerminalPanel } from './components/DockviewTerminalPanel';
import { DockviewNewSessionPanel } from './components/DockviewNewSessionPanel';
import { DockviewCustomTab, DockviewNewSessionTab } from './components/DockviewCustomTab';
import { useDockviewSync } from './hooks/useDockviewSync';
import { useMRU } from './hooks/useMRU';
import { TabSwitcher } from './components/TabSwitcher';
import { TagSwitcher } from './components/TagSwitcher';
import { sessionMatchesTagFilter } from './tagFilter';

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
  const openSettings = useUIStore((s) => s.openSettings);
  return (
    <button className="dv-menu-btn" onClick={openSettings} title="Settings">
      <span /><span /><span />
    </button>
  );
}

export function App() {
  const wsFunctions = useMultiWebSocket();
  const [api, setApi] = useState<DockviewApi | null>(null);

  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const themeName = useUIStore((s) => s.theme);
  const currentTheme = themes[themeName] ?? themes['github-dark'];

  const wsContext = useMemo<WsFunctions>(() => ({
    createSession: wsFunctions.createSession,
    killSession: wsFunctions.killSession,
    getConnection: wsFunctions.getConnection,
  }), [wsFunctions.createSession, wsFunctions.killSession, wsFunctions.getConnection]);

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
      // Skip panels hidden by the tag filter — otherwise arrow-switching
      // lands on tabs whose headers are CSS-hidden, which looks like jumping
      // to nowhere. Non-session panels (e.g. the new-session panel) always
      // pass since they have no tags to match against.
      const tagFilter = useUIStore.getState().tagFilter;
      const sessions = useSessionStore.getState().sessions;
      const panels = tagFilter.length === 0
        ? group.panels
        : group.panels.filter((p) => {
            const session = sessions.find((s) => s.id === p.id);
            // Non-session panels (e.g. the new-session panel) always pass.
            return !session || sessionMatchesTagFilter(session, tagFilter);
          });
      if (panels.length < 2) return;
      e.preventDefault();
      const activePanel = api.activePanel;
      const idx = panels.findIndex((p) => p === activePanel);
      // Active panel itself filtered out (shouldn't normally happen, the sync
      // hook reconciles it) — fall back to the first visible panel.
      if (idx === -1) {
        panels[0].api.setActive();
        return;
      }
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
      {settingsOpen && <SettingsModal onClose={closeSettings} />}
      <TabSwitcher mruRef={mruRef} />
      <TagSwitcher />
    </WsContext>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h2>Settings</h2>
          <button className="settings-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-modal-body">
          <section className="settings-panel-section settings-panel-section-wide">
            <h3>Servers</h3>
            <DrawerServers />
          </section>
          <section className="settings-panel-section">
            <h3>Automation</h3>
            <AutomationSettings />
          </section>
          <section className="settings-panel-section">
            <h3>Appearance</h3>
            <DrawerSettings />
          </section>
          <section className="settings-panel-section">
            <h3>Tags</h3>
            <TagFilterSettings />
          </section>
          <section className="settings-panel-section">
            <h3>Keybindings</h3>
            <KeybindingSettings />
          </section>
          <section className="settings-panel-section">
            <h3>Account</h3>
            <a href="/change-password" className="drawer-link">Change Password</a>
          </section>
        </div>
      </div>
    </div>
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
    </div>
  );
}

function AutomationSettings() {
  const autoCompactMinutes = useUIStore((s) => s.autoCompactMinutes);
  const setAutoCompactMinutes = useUIStore((s) => s.setAutoCompactMinutes);

  return (
    <div className="settings-section">
      <div className="setting-group">
        <label>Auto Compact Time</label>
        <div className="number-row">
          <input
            type="number"
            min="1"
            max="1440"
            value={autoCompactMinutes}
            onChange={(e) => setAutoCompactMinutes(Number(e.target.value))}
          />
          <span>minutes</span>
        </div>
      </div>
    </div>
  );
}

function TagFilterSettings() {
  const sessions = useSessionStore((s) => s.sessions);
  const tagFilter = useUIStore((s) => s.tagFilter);
  const toggleTagFilter = useUIStore((s) => s.toggleTagFilter);
  const clearTagFilter = useUIStore((s) => s.clearTagFilter);

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      for (const tag of session.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions]);

  const visibleCount = tagFilter.length === 0
    ? sessions.length
    : sessions.filter((session) => sessionMatchesTagFilter(session, tagFilter)).length;

  return (
    <div className="settings-section">
      <div className="tag-filter-summary">
        Showing {visibleCount} of {sessions.length} sessions
      </div>
      <div className="tag-filter-grid">
        <button
          className={`tag-filter-chip ${tagFilter.length === 0 ? 'active' : ''}`}
          onClick={clearTagFilter}
        >
          All
        </button>
        {tagCounts.map(([tag, count]) => (
          <button
            key={tag}
            className={`tag-filter-chip ${tagFilter.includes(tag) ? 'active' : ''}`}
            onClick={() => toggleTagFilter(tag)}
          >
            {tag}<span>{count}</span>
          </button>
        ))}
      </div>
      {tagCounts.length === 0 && (
        <div className="tag-filter-empty">No tags have been added yet.</div>
      )}
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
  const { getConnection } = useWsContext();
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
          {(() => {
            const status = connectionStatus[s.url];
            return (
              <>
                <span className="server-dot" style={{ background: statusDotColor(status) }} />
                <span className="server-label">{s.label}</span>
                {(status === 'error' || status === 'disconnected') && (
                  <button
                    className="server-retry"
                    onClick={() => getConnection(s.url)?.retry()}
                    title="Retry connection"
                  >
                    Retry
                  </button>
                )}
              </>
            );
          })()}
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
