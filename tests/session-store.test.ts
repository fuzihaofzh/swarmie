import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeLocalStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
    clear: () => items.clear(),
  };
}

function sessionSummary(id: string) {
  return {
    id,
    name: id,
    tool: 'codex',
    status: 'idle',
    startTime: 1,
    displayName: 'Codex',
    icon: '',
    cwd: `/work/${id}`,
    workspaceCwd: `/work/${id}`,
    hostname: 'local',
    initialHostname: 'local',
    serverUrl: '',
  };
}

describe('session store active tab persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', makeLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores the selected tab when the session list arrives after a refresh', async () => {
    const firstModule = await import('../src/web/hooks/useSessions.js');
    firstModule.useSessionStore.getState().setActiveSession('session-2');
    expect(localStorage.getItem('swarmie-active-session-id')).toBe('session-2');

    vi.resetModules();
    const refreshedModule = await import('../src/web/hooks/useSessions.js');
    expect(refreshedModule.useSessionStore.getState().activeSessionId).toBe('session-2');

    refreshedModule.useSessionStore.getState().setServerSessions('', [
      sessionSummary('session-1'),
      sessionSummary('session-2'),
      sessionSummary('session-3'),
    ]);

    expect(refreshedModule.useSessionStore.getState().activeSessionId).toBe('session-2');
  });
});
