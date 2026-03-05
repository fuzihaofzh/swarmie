import { useState, useEffect } from 'react';
import { ToolIcon } from './ToolIcon';
import { useServerStore, LOCAL_SERVER } from '../hooks/useServers';
import { useWsContext } from '../contexts/WsContext';

const PRESET_TOOLS = [
  { id: 'claude', label: 'Claude Code', desc: 'Anthropic Claude CLI' },
  { id: 'codex', label: 'Codex', desc: 'OpenAI Codex CLI' },
  { id: 'gemini', label: 'Gemini', desc: 'Google Gemini CLI' },
];

interface SessionConfig {
  tool: string;
  args?: string[];
  cwd?: string;
}

const STORAGE_KEY = 'swarmie-recent-configs';
const MAX_RECENT = 6;

function loadRecentConfigs(): SessionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRecentConfig(config: SessionConfig) {
  const configs = loadRecentConfigs();
  // Deduplicate by tool+args+cwd
  const key = (c: SessionConfig) => `${c.tool}|${(c.args ?? []).join(' ')}|${c.cwd ?? ''}`;
  const newKey = key(config);
  const filtered = configs.filter((c) => key(c) !== newKey);
  filtered.unshift(config);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)));
}

interface NewSessionPageProps {
  onCreateSession: (opts: {
    tool: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
    serverUrl?: string;
  }) => Promise<{ id: string } | null>;
  onCancel?: () => void;
}

export function NewSessionPage({ onCreateSession, onCancel }: NewSessionPageProps) {
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [customCommand, setCustomCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [selectedServer, setSelectedServer] = useState(LOCAL_SERVER);

  // Server list
  const servers = useServerStore((s) => s.servers);
  const multiServer = servers.length > 0;
  const { getConnection } = useWsContext();

  // Recent dirs
  const [recentDirs, setRecentDirs] = useState<string[]>([]);

  // Recent configs (quick start)
  const [recentConfigs, setRecentConfigs] = useState<SessionConfig[]>([]);

  const tool = selectedTool || customCommand;
  const canStart = tool.trim().length > 0 && !creating;

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
    setRecentConfigs(loadRecentConfigs());
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

  const startSession = async (config: {
    tool: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
    serverUrl?: string;
  }) => {
    setCreating(true);
    saveRecentConfig({ tool: config.tool, args: config.args, cwd: config.cwd });
    const result = await onCreateSession(config);
    setCreating(false);
    return result;
  };

  const handleStart = async () => {
    if (!canStart) return;
    const toolArgs = args.trim() ? args.trim().split(/\s+/) : undefined;
    await startSession({
      tool: tool.trim(),
      args: toolArgs,
      cwd: cwd.trim() || undefined,
      sessionName: sessionName.trim() || undefined,
      serverUrl: selectedServer || undefined,
    });
  };

  const handleQuickStart = async (config: SessionConfig) => {
    if (creating) return;
    await startSession(config);
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

        {/* Quick Start */}
        {recentConfigs.length > 0 && (
          <div className="quick-start">
            <label>Quick Start</label>
            <div className="quick-start-list">
              {recentConfigs.map((c, i) => (
                <button
                  key={i}
                  className="quick-start-item"
                  onClick={() => handleQuickStart(c)}
                  disabled={creating}
                  title={[c.tool, ...(c.args ?? [])].join(' ') + (c.cwd ? `  in ${c.cwd}` : '')}
                >
                  <ToolIcon tool={c.tool} brandColor iconSize={16} />
                  <span className="quick-start-tool">{c.tool}</span>
                  {c.args && c.args.length > 0 && (
                    <span className="quick-start-args">{c.args.join(' ')}</span>
                  )}
                  {c.cwd && (
                    <span className="quick-start-cwd">{shortPath(c.cwd)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="tool-grid">
          {PRESET_TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool-card ${selectedTool === t.id ? 'selected' : ''}`}
              onClick={() => {
                setSelectedTool(selectedTool === t.id ? '' : t.id);
                if (selectedTool !== t.id) setCustomCommand('');
              }}
            >
              <ToolIcon tool={t.id} brandColor iconSize={28} />
              <span className="tool-card-label">{t.label}</span>
              <span className="tool-card-desc">{t.desc}</span>
            </button>
          ))}
        </div>

        <div className="form-group">
          <label>Custom Command</label>
          <input
            type="text"
            placeholder="e.g. aider, cursor, or any CLI command"
            value={customCommand}
            onChange={(e) => {
              setCustomCommand(e.target.value);
              if (e.target.value) setSelectedTool('');
            }}
          />
        </div>

        <div className="form-group">
          <label>Arguments</label>
          <input
            type="text"
            placeholder='e.g. -p "fix the bug" --model o3'
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Session Name</label>
          <input
            type="text"
            placeholder="Auto-generated if empty"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
          />
        </div>

        {/* Working Directory — at the bottom */}
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
            onClick={handleStart}
            disabled={!canStart}
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
