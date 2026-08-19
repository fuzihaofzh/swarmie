import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../src/web/hooks/useSessions.js';
import {
  sessionDisplayLabel,
  sessionWorkspaceKey,
  sessionWorkspacePath,
} from '../src/web/sessionPresentation.js';
import { sessionMatchesTagFilter } from '../src/web/tagFilter.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    name: 'Codex session',
    tool: 'codex',
    status: 'idle',
    startTime: 1,
    displayName: 'Codex',
    icon: '',
    cwd: '/work/original',
    workspaceCwd: '/work/original',
    hostname: 'local-box',
    initialHostname: 'local-box',
    serverUrl: '',
    ...overrides,
  };
}

describe('shared session presentation', () => {
  it('binds local tab/sidebar/workspace names and identity to the same live cwd', () => {
    const local = session({ cwd: '/tmp/manually-selected-dir' });
    const sessions = [local];

    expect(sessionWorkspacePath(local, sessions)).toBe('/tmp/manually-selected-dir');
    expect(sessionDisplayLabel(local, sessions)).toBe('manually-selected-dir');
    expect(sessionWorkspaceKey(local, sessions)).toBe('workspace:cwd:/tmp/manually-selected-dir');
    expect(sessionMatchesTagFilter(local, ['workspace:cwd:/tmp/manually-selected-dir'], sessions)).toBe(true);
    expect(sessionMatchesTagFilter(local, ['workspace:cwd:/work/original'], sessions)).toBe(false);
  });

  it('uses one remote host/path label and identity after a real SSH transition', () => {
    const remote = session({
      cwd: '/srv/remote-project',
      workspaceCwd: '/work/original',
      hostname: 'gpu-worker',
    });
    const sessions = [remote];

    expect(sessionWorkspacePath(remote, sessions)).toBe('/srv/remote-project');
    expect(sessionDisplayLabel(remote, sessions)).toBe('gpu-worker:remote-project');
    expect(sessionWorkspaceKey(remote, sessions)).toBe('workspace:hostcwd:gpu-worker:/srv/remote-project');
    expect(sessionMatchesTagFilter(remote, ['workspace:hostcwd:gpu-worker:/srv/remote-project'], sessions)).toBe(true);
  });
});
