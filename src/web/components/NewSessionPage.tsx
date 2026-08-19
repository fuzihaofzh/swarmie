import { useState } from 'react';
import { useServerStore, LOCAL_SERVER } from '../hooks/useServers';
import { useSessionStore } from '../hooks/useSessions';
import { saveRecentDir, getRecentEntries } from '../recentDirs';
import { hostnamesEquivalent, serverUrlHostname } from '../serverHost';

interface NewSessionPageProps {
  onCreateSession: (opts: {
    serverUrl?: string;
    cwd?: string;
  }) => Promise<{ id: string }>;
  onCancel?: () => void;
  initialCwd?: string;
  initialServerUrl?: string;
  initialError?: string;
}

export function NewSessionPage({
  onCreateSession,
  onCancel,
  initialCwd,
  initialServerUrl,
  initialError,
}: NewSessionPageProps) {
  const servers = useServerStore((s) => s.servers);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(initialError ?? '');
  const [showAll, setShowAll] = useState(false);
  const [selectedServer, setSelectedServer] = useState(initialServerUrl ?? LOCAL_SERVER);
  const sessions = useSessionStore((s) => s.sessions);

  const recentEntries = getRecentEntries(sessions.map((s) => ({ cwd: s.cwd, hostname: s.hostname })));

  const handleStart = async (cwd?: string, hostname?: string) => {
    if (creating) return;
    const targetCwd = cwd ?? initialCwd;
    let targetServer = selectedServer;
    // Recent entries remember the machine that owns the directory. When that
    // machine is a configured Swarmie server, route the create request there
    // instead of trying the path on Local. An SSH-only host has no coordinator
    // we can spawn through, so explain that rather than sending a doomed POST.
    if (!targetServer && hostname) {
      const matchingServer = servers.find((server) => {
        const serverHost = serverUrlHostname(server.url);
        return !!serverHost && hostnamesEquivalent(serverHost, hostname);
      });
      if (!matchingServer) {
        setCreateError(`The directory belongs to ${hostname}. Select or add that Swarmie server before creating a session there.`);
        return;
      }
      targetServer = matchingServer.url;
      setSelectedServer(targetServer);
    }
    setCreateError('');
    setCreating(true);
    try {
      await onCreateSession({
        serverUrl: targetServer || undefined,
        cwd: targetCwd,
      });
      // A failed path must not poison the recent-directory list.
      if (targetCwd) saveRecentDir({ dir: targetCwd, hostname });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="new-session-page">
      <div className="new-session-content">
        <h2>New Session</h2>

        {createError && (
          <div className="new-session-error" role="alert">
            {createError}
          </div>
        )}

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

        {recentEntries.length > 0 && (
          <div className="recent-section">
            <h3>Recent</h3>
            <div className="recent-list">
              {recentEntries.slice(0, showAll ? undefined : 5).map((entry) => {
                const short = entry.dir.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
                const name = entry.dir.split('/').pop() || entry.dir;
                const parent = short.split('/').slice(0, -1).join('/');
                const host = entry.hostname && entry.hostname !== 'local' ? entry.hostname : '';
                return (
                  <button
                    key={`${entry.hostname || ''}:${entry.dir}`}
                    className="recent-item"
                    onClick={() => handleStart(entry.dir, entry.hostname)}
                    disabled={creating}
                    title={entry.dir}
                  >
                    <span className="recent-item-name">{name}</span>
                    <span className="recent-item-path">
                      {host && <span className="recent-item-host">{host}:</span>}
                      {parent}
                    </span>
                  </button>
                );
              })}
              {recentEntries.length > 5 && !showAll && (
                <button className="recent-item recent-more" onClick={() => setShowAll(true)}>
                  More...
                </button>
              )}
            </div>
          </div>
        )}

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
            {creating ? 'Starting...' : 'New Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
