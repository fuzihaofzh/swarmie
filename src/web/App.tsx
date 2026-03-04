import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessions';
import { useUIStore } from './hooks/useUI';
import { themes, applyTheme } from './themes';
import { TabBar } from './components/TabBar';
import { TerminalView } from './components/TerminalView';
import { NewSessionPage } from './components/NewSessionPage';

export function App() {
  const { sendInput, sendResize, createSession } = useWebSocket();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const drawerOpen = useUIStore((s) => s.drawerOpen);
  const toggleDrawer = useUIStore((s) => s.toggleDrawer);
  const themeName = useUIStore((s) => s.theme);
  const showNewSession = useUIStore((s) => s.showNewSession);
  const setShowNewSession = useUIStore((s) => s.setShowNewSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const showNewSessionPage = showNewSession || sessions.length === 0;

  const currentTheme = themes[themeName] ?? themes['github-dark'];

  // Apply theme CSS variables
  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);

  // Cmd+Left / Cmd+Right to switch tabs, Cmd+T to new tab
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === 't' && e.ctrlKey) {
        e.preventDefault();
        useUIStore.getState().setShowNewSession(true);
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const { sessions, activeSessionId } = useSessionStore.getState();
      if (sessions.length < 2) return;
      e.preventDefault();
      const idx = sessions.findIndex((s) => s.id === activeSessionId);
      const next = e.key === 'ArrowRight'
        ? (idx + 1) % sessions.length
        : (idx - 1 + sessions.length) % sessions.length;
      setActiveSession(sessions[next].id);
      useUIStore.getState().setShowNewSession(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveSession]);

  return (
    <div className="app-layout">
      {/* Overlay */}
      <div
        className={`overlay ${drawerOpen ? 'open' : ''}`}
        onClick={toggleDrawer}
      />

      {/* Drawer — fixed overlay mode */}
      <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="drawer-header">
          <h3>swarmie</h3>
          <button className="drawer-close" onClick={toggleDrawer}>
            &times;
          </button>
        </div>
        <div className="drawer-content">
          {/* Settings */}
          <div className="drawer-section">
            <div className="drawer-section-header">Settings</div>
            <DrawerSettings />
          </div>
        </div>
      </div>

      {/* Main area */}
      <div className="app-main">
        {/* Tab Bar */}
        <TabBar />

        {/* Main Content */}
        <div className="terminal-container">
          {showNewSessionPage && (
            <NewSessionPage
              onCreateSession={async (opts) => {
                const result = await createSession(opts);
                if (result) {
                  setShowNewSession(false);
                  setActiveSession(result.id);
                }
                return result;
              }}
              onCancel={sessions.length > 0 ? () => setShowNewSession(false) : undefined}
            />
          )}

          {/* One TerminalView per session, all always mounted, only active one visible */}
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId && !showNewSessionPage;
            return (
            <div
              key={`term-${s.id}`}
              style={{
                position: 'absolute',
                top: 0, left: 0, right: 0, bottom: 0,
                display: 'flex',
                flexDirection: 'column',
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              <TerminalView
                sessionId={s.id}
                isActive={isActive}
                onInput={(data) => sendInput(s.id, data)}
                onResize={(cols, rows) => sendResize(s.id, cols, rows)}
              />
            </div>
            );
          })}

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
