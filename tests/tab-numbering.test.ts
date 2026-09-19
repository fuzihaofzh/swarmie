import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../src/web/hooks/useSessions.js';
import { commandTabNumber, numberedTabIds } from '../src/web/tabNumbering.js';

function session(id: string, tags: string[] = []): SessionSummary {
  return {
    id,
    name: id,
    tool: 'codex',
    status: 'idle',
    startTime: 1,
    displayName: id,
    icon: '',
    cwd: `/work/${id}`,
    hostname: 'local-box',
    initialHostname: 'local-box',
    serverUrl: '',
    tags,
  };
}

describe('tab numbering', () => {
  it('uses Dockview order and excludes hidden or non-session panels', () => {
    const sessions = [session('one', ['blue']), session('two', ['red']), session('three', ['blue'])];

    expect(numberedTabIds(['three', '__new_session__', 'one', 'two'], sessions, [], ['blue']))
      .toEqual(['three', 'one']);
    expect(numberedTabIds(['three', 'one', 'two'], sessions, ['one'], []))
      .toEqual(['three', 'two']);
  });

  it('recognizes only unmodified Cmd+1 through Cmd+9', () => {
    const shortcut = {
      code: 'Digit4',
      altKey: false,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    };

    expect(commandTabNumber(shortcut)).toBe(4);
    expect(commandTabNumber({ ...shortcut, code: 'Digit0' })).toBeNull();
    expect(commandTabNumber({ ...shortcut, ctrlKey: true })).toBeNull();
    expect(commandTabNumber({ ...shortcut, metaKey: false })).toBeNull();
  });
});
