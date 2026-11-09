import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => ({
  spawn: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  data: (_data: string) => {},
  exit: (_event: { exitCode: number }) => {},
}));
vi.mock('node-pty', () => ({ spawn: pty.spawn }));

import { createAdapter, getAdapterNames } from '../src/adapters/registry.js';
import { OmpAdapter } from '../src/adapters/omp.js';
import { AgentStateDetector } from '../src/detection/index.js';
import { parseArgs } from '../src/cli/args.js';

const detector = new AgentStateDetector();
const title = (value: string) => `\x1b]0;${value}\x07`;

describe('OMP integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('SWARMIE_DETECTION_MODE', 'active');
    pty.spawn.mockReset();
    pty.spawn.mockReturnValue({
      pid: 0,
      onData: (handler: typeof pty.data) => { pty.data = handler; },
      onExit: (handler: typeof pty.exit) => { pty.exit = handler; },
      write: pty.write, resize: pty.resize, kill: pty.kill,
    });
  });

  afterEach(() => {
    pty.exit({ exitCode: 0 });
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('launches the dedicated PTY adapter with CLI arguments and forwards its lifecycle', () => {
    const parsed = parseArgs(['node', 'swarmie', 'omp', '--', '--model', 'test-model', '--continue']);
    const adapter = createAdapter(parsed.tool!, { sessionId: 'omp-launch', toolArgs: parsed.toolArgs });
    expect(getAdapterNames()).toContain('omp');
    expect(adapter).toBeInstanceOf(OmpAdapter);
    expect(adapter.info).toMatchObject({ name: 'omp', displayName: 'Oh My Pi', supportsStructured: false });
    const events: Array<{ type: string; data: unknown }> = [];
    adapter.on('event', (event) => events.push(event));
    adapter.start();
    expect(pty.spawn).toHaveBeenCalledWith('omp', ['--model', 'test-model', '--continue'], expect.any(Object));
    pty.data('hello');
    expect(events).toContainEqual(expect.objectContaining({ type: 'raw:output', data: { data: Buffer.from('hello').toString('base64') } }));
    adapter.write('task\r');
    expect(pty.write).toHaveBeenCalledWith('task\r');
    adapter.resize(100, 40);
    expect(pty.resize).toHaveBeenCalledWith(100, 40);
    adapter.kill('SIGTERM');
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM');
    pty.exit({ exitCode: 1 });
    expect(adapter.status).toBe('error');
    expect(adapter.isRunning).toBe(false);
  });

  it('tracks idle, submitted work, attention, resumed work and completion without output silence', () => {
    const adapter = createAdapter('omp', { sessionId: 'omp-states', toolArgs: [] });
    adapter.start();
    const feed = (chunk: string) => { pty.data(chunk); vi.advanceTimersByTime(100); };
    feed(title('π > /work/project'));
    expect(adapter.status).toBe('idle');
    adapter.write('fix bug\r');
    feed('old composer redraw');
    expect(adapter.status).toBe('running');
    feed(title('π ⠋ Fix bug'));
    expect(adapter.status).toBe('running');
    feed(title('π ! Fix bug'));
    expect(adapter.status).toBe('waiting_input');
    expect(adapter.getDetectionExplanation().automationSafe).toBe(false);
    adapter.write('yes\r');
    feed(title('π : Fix bug'));
    expect(adapter.status).toBe('running');
    feed('\x1b]0;π');
    feed(' > Fix bug\x07');
    expect(adapter.status).toBe('idle');
    for (let i = 0; i < 5; i++) feed(`\rfooter telemetry ${i}`);
    expect(adapter.status).toBe('idle');
  });

  it.each([
    ['\x1b]0;π ', '> /work/project\x07'],
    ['\x1b]2;π ⠋ Fix bug\x1b', '\\'],
    ['\x1b[36m▄▀▀▄ █▀▄▀▄ ', '█▀▀▄\x1b[0m'],
    ['omp v18.', '18.2'],
  ])('detects OMP across PTY chunks and returns to shell mode', (first, second) => {
    const adapter = createAdapter('my-shell-wrapper', { sessionId: 'omp-detect', toolArgs: [] });
    adapter.start();
    pty.data(first);
    pty.data(second);
    vi.advanceTimersByTime(100);
    expect(adapter.info.name).toBe('omp');
    pty.data(title('π > project'));
    vi.advanceTimersByTime(100);
    pty.data('\x1b]133;A\x07shell> ');
    expect(adapter.info.name).toBe('my-shell-wrapper');
    expect(adapter.status).toBe('idle');
    adapter.write('codex\r');
    pty.data('OpenAI Codex (v0.144.6)');
    expect(adapter.info.name).toBe('codex');
  });

  it('does not identify OMP from paths, prose, or plain title-like text', () => {
    const adapter = createAdapter('my-shell-wrapper', { sessionId: 'omp-no-false-positive', toolArgs: [] });
    adapter.start();
    pty.data('cd /work/omp\r\nOh My Pi is installed.\r\nπ > example\r\n');
    pty.data(title('user@host:/work/omp'));
    expect(adapter.info.name).toBe('my-shell-wrapper');
  });
});

describe('OMP state manifest', () => {
  it.each(['⠋', '⠏', '○', '◑', '●', '⠁', '⠈', '-', '\\', '|', '/', ':'])('recognizes working title separator %s', (separator) => {
    const { result } = detector.detect('omp', { recent: '', viewport: '', oscTitle: `π ${separator} task` });
    expect(result).toMatchObject({ state: 'working', visibleWorking: true });
  });

  it.each(['π', 'π: task', 'omp', 'task with π > example'])('does not infer idle from a title without state: %s', (oscTitle) => {
    expect(detector.detect('omp', { recent: '', viewport: '', oscTitle }).result.state).toBe('unknown');
  });

  it('uses a working row when title state is disabled', () => {
    const recent = ' ⎋ Working…\n────────\n';
    expect(detector.detect('omp', { recent, viewport: recent, oscTitle: 'π: task' }).result.state).toBe('working');
  });
});
