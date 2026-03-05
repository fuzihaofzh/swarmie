import { useState, useEffect } from 'react';
import { useServerStore, LOCAL_SERVER } from '../hooks/useServers';
import { useWsContext } from '../contexts/WsContext';

const STORAGE_KEY = 'swarmie-recent-cwds';
const MAX_RECENT = 8;

function loadRecentCwds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecentCwd(cwd: string) {
  if (!cwd) return;
  const cwds = loadRecentCwds().filter((c) => c !== cwd);
  cwds.unshift(cwd);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cwds.slice(0, MAX_RECENT)));
}

interface NewSessionPageProps {
  onCreateSession: (opts: {
    cwd?: string;
    serverUrl?: string;
  }) => Promise<{ id: string } | null>;
  onCancel?: () => void;
}

export function NewSessionPage({ onCreateSession, onCancel }: NewSessionPageProps) {
  const [cwd, setCwd] = useState('');
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selectedServer, setSelectedServer] = useState(LOCAL_SERVER);

  // Server list
  const servers = useServerStore((s) => s.servers);
  const multiServer = servers.length > 0;
  const { getConnection } = useWsContext();

  // Recent dirs from server + localStorage
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [recentCwds, setRecentCwds] = useState<string[]>(loadRecentCwds);

  useEffect(() => {
    const conn = getConnection(selectedServer);
    if (conn) {
      conn.fetchRecentDirs().then(setRecentDirs);
    } else {
      fetch('/api/recent-dirs')
        .then((r) => r.json())
        .then((dirs) => setRecentDirs(dirs))
        .catch(() => {});
    }
  }, [selectedServer, getConnection]);

  const pickFolder = async () => {
    setPicking(true);
    try {
      const conn = getConnection(selectedServer);
      if (conn) {
        const path = await conn.pickFolder();
        if (path) setCwd(path);
      } else {
        const r = await fetch('/api/pick-folder', { method: 'POST' });
        if (r.ok) {
          const data = await r.json();
          if (data?.path) setCwd(data.path);
        }
      }
    } catch {
      // user cancelled or error
    }
    setPicking(false);
  };

  const handleStart = async (dir?: string) => {
    if (creating) return;
    const targetCwd = dir ?? (cwd.trim() || undefined);
    setCreating(true);
    if (targetCwd) {
      saveRecentCwd(targetCwd);
      setRecentCwds(loadRecentCwds());
    }
    await onCreateSession({
      cwd: targetCwd,
      serverUrl: selectedServer || undefined,
    });
    setCreating(false);
  };

  return (
    <div className="new-session-page">
      <div className="new-session-content">
        <h2>New Session</h2>

        {/* Server selector — only shown when multiple servers */}
        {multiServer && (
          <div className="form-group">
            <label>Server</label>
            <select
              value={selectedServer}
              onChange={(e) => setSelectedServer(e.target.value)}
            >
              <option value="">Local ({window.location.host})</option>
              {servers.map((s) => (
                <option key={s.url} value={s.url}>{s.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Quick Start — recent working directories */}
        {recentCwds.length > 0 && (
          <div className="quick-start">
            <label>Recent</label>
            <div className="quick-start-list">
              {recentCwds.map((dir) => (
                <button
                  key={dir}
                  className="quick-start-item"
                  onClick={() => { handleStart(dir); }}
                  disabled={creating}
                  title={dir}
                >
                  <span className="quick-start-tool">{shortPath(dir)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Working Directory */}
        <div className="form-group">
          <label>Working Directory</label>
          <div className="cwd-input-row">
            <input
              type="text"
              placeholder="Leave empty for server default"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
            <button
              className="cwd-browse-btn"
              onClick={pickFolder}
              type="button"
              disabled={picking}
              title="Browse directories"
            >
              {picking ? '...' : '...'}
            </button>
          </div>

          {/* Recent directories */}
          {recentDirs.length > 0 && (
            <div className="cwd-recent">
              {recentDirs.map((dir) => (
                <button
                  key={dir}
                  className="cwd-recent-item"
                  onClick={() => setCwd(dir)}
                  title={dir}
                >
                  {shortPath(dir)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="form-actions">
          {onCancel && (
            <button className="cancel-btn" onClick={onCancel} disabled={creating}>
              Cancel
            </button>
          )}
          <button
            className="start-btn"
            onClick={() => handleStart()}
            disabled={creating}
          >
            {creating ? 'Starting...' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
