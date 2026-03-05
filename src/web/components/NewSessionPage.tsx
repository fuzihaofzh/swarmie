import { useState } from 'react';
import { useServerStore, LOCAL_SERVER } from '../hooks/useServers';

interface NewSessionPageProps {
  onCreateSession: (opts: {
    serverUrl?: string;
  }) => Promise<{ id: string } | null>;
  onCancel?: () => void;
}

export function NewSessionPage({ onCreateSession, onCancel }: NewSessionPageProps) {
  const [creating, setCreating] = useState(false);
  const [selectedServer, setSelectedServer] = useState(LOCAL_SERVER);
  const servers = useServerStore((s) => s.servers);

  const handleStart = async () => {
    if (creating) return;
    setCreating(true);
    await onCreateSession({
      serverUrl: selectedServer || undefined,
    });
    setCreating(false);
  };

  return (
    <div className="new-session-page">
      <div className="new-session-content">
        <h2>New Session</h2>

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

        <div className="form-actions">
          {onCancel && (
            <button className="cancel-btn" onClick={onCancel} disabled={creating}>
              Cancel
            </button>
          )}
          <button
            className="start-btn"
            onClick={handleStart}
            disabled={creating}
          >
            {creating ? 'Starting...' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  );
}
