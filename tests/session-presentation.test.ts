import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../src/web/hooks/useSessions.js';
import {
  sessionDisplayLabel,
  sessionWorkspaceKey,
  sessionWorkspaceLabel,
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
  it('updates local tab/sidebar names from live cwd while workspace identity stays at launch cwd', () => {
    const local = session({ cwd: '/tmp/manually-selected-dir' });
    const sessions = [local];

    expect(sessionWorkspacePath(local, sessions)).toBe('/work/original');
    expect(sessionDisplayLabel(local, sessions)).toBe('manually-selected-dir');
    expect(sessionWorkspaceLabel(local, sessions)).toBe('original');
    expect(sessionWorkspaceKey(local, sessions)).toBe('workspace:cwd:/work/original');
    expect(sessionMatchesTagFilter(local, ['workspace:cwd:/work/original'], sessions)).toBe(true);
    expect(sessionMatchesTagFilter(local, ['workspace:cwd:/tmp/manually-selected-dir'], sessions)).toBe(false);
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
    expect(sessionWorkspaceLabel(remote, sessions)).toBe('gpu-worker:remote-project');
    expect(sessionWorkspaceKey(remote, sessions)).toBe('workspace:hostcwd:gpu-worker:/srv/remote-project');
    expect(sessionMatchesTagFilter(remote, ['workspace:hostcwd:gpu-worker:/srv/remote-project'], sessions)).toBe(true);
  });
});
