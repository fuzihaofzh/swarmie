import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  inspect: vi.fn(),
  foreground: 'zsh',
  data: (_data: string) => {},
  exit: (_event: { exitCode: number }) => {},
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: mock.inspect });
  return { ...original, execFile };
});
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 100,
    onData: (handler: typeof mock.data) => { mock.data = handler; },
    onExit: (handler: typeof mock.exit) => { mock.exit = handler; },
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    get process() { return mock.foreground; },
  }),
}));
import { GenericAdapter } from '../src/adapters/generic.js';

function launch() {
  const adapter = new GenericAdapter('/bin/zsh', { sessionId: 'shell-return', toolArgs: [] });
  adapter.start();
  mock.data('OpenAI Codex (v0.144.6)\r\n• Working (1s • esc to interrupt)');
  return adapter;
}

describe('agent exit without shell integration', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    // These tests exercise the POSIX foreground-process-group fallback.
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.useFakeTimers();
    mock.inspect.mockReset();
    mock.foreground = 'zsh';
    mock.inspect.mockResolvedValue({ stdout: '100 200\n' });
  });
  afterEach(() => {
    mock.exit({ exitCode: 0 });
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it('detects a normal exit long after launch without Ctrl+C or OSC markers', async () => {
    const adapter = launch();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(adapter.info.name).toBe('codex');
    expect(adapter.status).toBe('running');
    mock.data('\r\nToken usage: total=14,275\r\nTo continue this session, run codex resume\r\n% ');
    mock.inspect.mockResolvedValue({ stdout: '100 100\n' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.info.name).toBe('/bin/zsh');
    expect(adapter.status).toBe('idle');
    const calls = mock.inspect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mock.inspect).toHaveBeenCalledTimes(calls);
  });

  it('does not treat exit-like tool output as an exit while the agent owns the terminal', async () => {
    const adapter = launch();
    mock.data('\r\nTo continue this session, run codex resume\r\n');
    // A wrapper script run by the same shell shares its name; only the
    // process-group check can tell them apart.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(adapter.info.name).toBe('codex');
    expect(adapter.status).toBe('running');
  });

  it('does not overwrite process completion with an in-flight shell check', async () => {
    let resolve!: (result: { stdout: string }) => void;
    mock.inspect.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const adapter = launch();
    mock.exit({ exitCode: 0 });
    resolve({ stdout: '100 100\n' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.status).toBe('completed');
  });

  it('does not spawn ps while an agent owns the terminal', async () => {
    mock.foreground = 'node';
    const adapter = launch();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.inspect).not.toHaveBeenCalled();
    expect(adapter.info.name).toBe('codex');
  });
});
