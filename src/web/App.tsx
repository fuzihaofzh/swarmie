import { useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessionStore } from './hooks/useSessions';
import { useUIStore } from './hooks/useUI';
import { themes, applyTheme } from './themes';
import { SessionList } from './components/SessionList';
import { TerminalView } from './components/TerminalView';
import { StructuredView } from './components/StructuredView';
import { EventTimeline } from './components/EventTimeline';

export function App() {
  const { sendInput, sendResize } = useWebSocket();
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = useSessionStore((s) =>
    s.sessions.find((sess) => sess.id === s.activeSessionId),
  );

  const drawerOpen = useUIStore((s) => s.drawerOpen);
  const closeDrawer = useUIStore((s) => s.closeDrawer);
  const toggleDrawer = useUIStore((s) => s.toggleDrawer);
  const themeName = useUIStore((s) => s.theme);
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  const currentTheme = themes[themeName] ?? themes['github-dark'];

  // Apply theme CSS variables
  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);

  return (
    <div className="app-layout">
      {/* Drawer — push layout, sits alongside main content */}
      <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="drawer-header">
          <h3>polycode</h3>
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

          {/* Sessions */}
          <div className="drawer-section">
            <div className="drawer-section-header">Sessions</div>
            <SessionList />
          </div>
        </div>
      </div>

      {/* Main area */}
      <div className="app-main">
        {/* Header */}
        <div className="header">
          <button className="menu-btn" onClick={toggleDrawer}>
            <span />
            <span />
            <span />
          </button>
          <div className="header-title">
            {activeSession ? (
              <>
                <span className="tool-name">{activeSession.displayName}</span>
                <span className="sep">@</span>
                <span className="host-name">{activeSession.hostname}</span>
                <span className="sep">:</span>
                <span className="session-cwd">{shortPath(activeSession.cwd)}</span>
              </>
            ) : (
              <span className="no-session">No active session</span>
            )}
          </div>
          {activeSessionId && (
            <div className="header-tabs">
              <button
                className={`tab-btn ${activeTab === 'terminal' ? 'active' : ''}`}
                onClick={() => setActiveTab('terminal')}
              >
                Terminal
              </button>
              <button
                className={`tab-btn ${activeTab === 'structured' ? 'active' : ''}`}
                onClick={() => setActiveTab('structured')}
              >
                Structured
              </button>
              <button
                className={`tab-btn ${activeTab === 'events' ? 'active' : ''}`}
                onClick={() => setActiveTab('events')}
              >
                Events
              </button>
            </div>
          )}
        </div>

        {/* Main Content */}
        <div className="terminal-container">
          {sessions.length === 0 && <EmptyState />}

          {/* One TerminalView per session, all always mounted, only active one visible */}
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId && activeTab === 'terminal';
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

          {activeSessionId && activeTab === 'structured' && (
            <StructuredView sessionId={activeSessionId} />
          )}
          {activeSessionId && activeTab === 'events' && (
            <EventTimeline sessionId={activeSessionId} />
          )}
        </div>
      </div>
    </div>
  );
}

function DrawerSettings() {
  const themeName = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const setTheme = useUIStore((s) => s.setTheme);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setFontFamily = useUIStore((s) => s.setFontFamily);

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
    </div>
  );
}

/** Shorten home dir to ~ */
function shortPath(p: string): string {
  const home = '/Users/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return '~';
    return '~' + rest.slice(slashIdx);
  }
  return p;
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div>
        <div className="icon">&gt;_</div>
        <h2>No active sessions</h2>
        <p>Start a session from the terminal:</p>
        <code>polycode claude -- -p "fix the bug"</code>
        <code>polycode codex -- "add tests"</code>
        <code>polycode gemini -- -p "refactor utils"</code>
      </div>
    </div>
  );
}
