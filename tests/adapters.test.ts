import { describe, it, expect } from 'vitest';
import { createAdapter, getAdapterNames } from '../src/adapters/registry.js';
import { RemoteAdapter } from '../src/adapters/remote.js';
import { buildSpawnEnv } from '../src/adapters/base.js';

describe('adapter registry', () => {
  it('keeps interactive PTYs colored even when the outer runner disables color', () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousColorTerm = process.env.COLORTERM;
    const previousSwarmieNoColor = process.env.SWARMIE_NO_COLOR;
    try {
      process.env.NO_COLOR = '1';
      delete process.env.COLORTERM;
      delete process.env.SWARMIE_NO_COLOR;

      const colored = buildSpawnEnv();
      expect(colored.NO_COLOR).toBeUndefined();
      expect(colored.COLORTERM).toBe('truecolor');

      process.env.SWARMIE_NO_COLOR = '1';
      const monochrome = buildSpawnEnv();
      expect(monochrome.NO_COLOR).toBe('1');
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousColorTerm === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = previousColorTerm;
      if (previousSwarmieNoColor === undefined) delete process.env.SWARMIE_NO_COLOR;
      else process.env.SWARMIE_NO_COLOR = previousSwarmieNoColor;
    }
  });

  it('registers claude, codex, gemini', () => {
    const names = getAdapterNames();
    expect(names).toContain('claude');
    expect(names).toContain('codex');
    expect(names).toContain('gemini');
  });

  it('creates a claude adapter', () => {
    const adapter = createAdapter('claude', {
      sessionId: 'test-1',
      toolArgs: ['--help'],
    });
    expect(adapter.info.name).toBe('claude');
    expect(adapter.info.displayName).toBe('Claude Code');
    expect(adapter.status).toBe('starting');
  });

  it('creates a codex adapter', () => {
    const adapter = createAdapter('codex', {
      sessionId: 'test-2',
      toolArgs: [],
    });
    expect(adapter.info.name).toBe('codex');
  });

  it('creates a gemini adapter', () => {
    const adapter = createAdapter('gemini', {
      sessionId: 'test-3',
      toolArgs: [],
    });
    expect(adapter.info.name).toBe('gemini');
  });

  it('falls back to GenericAdapter for unknown commands', () => {
    const adapter = createAdapter('cld', { sessionId: 'x', toolArgs: [] });
    expect(adapter.info.name).toBe('cld');
    expect(adapter.info.command).toBe('cld');
  });

  it('detects generic tools after batched input containing Enter', () => {
    const adapter = createAdapter('mytool', { sessionId: 'generic-batch', toolArgs: [] });
    adapter.write('codex\r');
    (adapter as unknown as { detectTool: (chunk: string) => void }).detectTool(
      '│ >_ OpenAI Codex (v0.144.6)                      │',
    );

    expect(adapter.info.name).toBe('codex');
    expect(adapter.info.displayName).toBe('Codex');
  });

  it('does not detect a tool from a bare directory/path mention', () => {
    const adapter = createAdapter('mytool', { sessionId: 'generic-nofalse', toolArgs: [] });
    adapter.write('ls ~/claude\r');
    (adapter as unknown as { detectTool: (chunk: string) => void }).detectTool(
      'drwxr-xr-x  claude  codex  gemini',
    );

    expect(adapter.info.name).toBe('mytool');
    expect(adapter.info.displayName).toBe('mytool');
  });

  it('detects the startup banner printed before any keystroke', () => {
    const adapter = createAdapter('mytool', { sessionId: 'generic-launch', toolArgs: [] });
    // A wrapper that boots straight into Claude prints its banner with no Enter first.
    (adapter as unknown as { detectTool: (chunk: string) => void }).detectTool(
      ' ▐▛███▜▌   Claude Code v2.1.212\n▝▜█████▛▘  Opus 4.8 (1M context) · Claude Max',
    );

    expect(adapter.info.name).toBe('claude');
    expect(adapter.info.displayName).toBe('Claude Code');
  });

  it('detects Claude through cursor-move word positioning in the raw banner', () => {
    const adapter = createAdapter('mytool', { sessionId: 'generic-nospace', toolArgs: [] });
    // Claude aligns words with \e[NG cursor moves, not spaces (verified against a
    // live PTY capture). detectTool strips CSI, fusing the words: "ClaudeCodev2.1.212".
    (adapter as unknown as { detectTool: (chunk: string) => void }).detectTool(
      ' ▐▛███▜▌   \x1b[2GClaude\x1b[9GCode\x1b[14Gv2.1.212',
    );

    expect(adapter.info.name).toBe('claude');
    expect(adapter.info.displayName).toBe('Claude Code');
  });

  it('locks the tool identity and ignores later mentions of another tool', () => {
    const adapter = createAdapter('mytool', { sessionId: 'generic-lock', toolArgs: [] });
    const detect = (adapter as unknown as { detectTool: (chunk: string) => void }).detectTool.bind(
      adapter,
    );
    detect('Claude Code v2.1.212');
    expect(adapter.info.name).toBe('claude');

    // Claude later prints Codex's banner text (e.g. discussing codex); must not flip.
    adapter.write('tell me about codex\r');
    detect('│ >_ OpenAI Codex (v0.144.6)            │');

    expect(adapter.info.name).toBe('claude');
  });

  it('returns a banner-detected agent session to idle when AgentCruise exits to its shell', () => {
    const adapter = createAdapter('/bin/zsh', { sessionId: 'generic-agentcruise-exit', toolArgs: [] });
    const feed = (adapter as unknown as { handlePtyData: (chunk: string) => void }).handlePtyData.bind(adapter);
    const detected: string[] = [];
    adapter.on('event', (event) => {
      if (event.type === 'tool:detect') detected.push((event.data as { tool: string }).tool);
    });

    adapter.write('agentcruise\r');
    feed('│ >_ OpenAI Codex (v0.144.6) │');
    expect(adapter.info.name).toBe('codex');
    expect(adapter.status).toBe('running');

    feed('\r\nAgentCruise ex');
    expect(adapter.status).toBe('running');
    feed('ited.\r\n%\r\n(base) user@host /work/project\r\n> ');

    expect(adapter.status).toBe('idle');
    expect(adapter.info).toMatchObject({ name: '/bin/zsh', displayName: '/bin/zsh' });
    expect(detected).toEqual(['codex', '/bin/zsh']);

    adapter.write('claude\r');
    feed('Claude Code v2.1.212');
    expect(adapter.info.name).toBe('claude');
    expect(detected).toEqual(['codex', '/bin/zsh', 'claude']);
  });

  it('returns a banner-detected agent session to idle on a shell prompt OSC marker', () => {
    const adapter = createAdapter('/bin/zsh', { sessionId: 'generic-shell-prompt', toolArgs: [] });
    const feed = (adapter as unknown as { handlePtyData: (chunk: string) => void }).handlePtyData.bind(adapter);

    adapter.write('codex\r');
    feed('│ >_ OpenAI Codex (v0.144.6) │');
    feed('\x1b]133;');
    expect(adapter.status).toBe('running');
    feed('A\x07\x1b]7;file://host/work/project\x07% ');

    expect(adapter.status).toBe('idle');
    expect(adapter.info.name).toBe('/bin/zsh');
  });

  it('does not mistake a nested shell OSC marker for the parent prompt while the agent is visibly busy', () => {
    const adapter = createAdapter('/bin/zsh', { sessionId: 'generic-nested-shell', toolArgs: [] });
    const feed = (adapter as unknown as { handlePtyData: (chunk: string) => void }).handlePtyData.bind(adapter);

    adapter.write('codex\r');
    feed('│ >_ OpenAI Codex (v0.144.6) │');
    feed('\x1b]7;file://host/work/project\x07◦ Working (2m 36s • esc to interrupt)');

    expect(adapter.status).toBe('running');
    expect(adapter.info.name).toBe('codex');
  });

  it('settles remote startup output to idle', () => {
    const adapter = new RemoteAdapter(
      { sessionId: 'remote-ready', toolArgs: [] },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: '',
        command: 'codex',
        supportsStructured: true,
      },
    );

    adapter.start();
    adapter.pushEvent({
      type: 'raw:output',
      sessionId: 'remote-ready',
      timestamp: Date.now(),
      data: { data: Buffer.from('startup complete').toString('base64') },
    });

    expect(adapter.status).toBe('idle');
  });

  it('keeps remote adapter info in sync with forwarded tool lifecycle changes', () => {
    const adapter = new RemoteAdapter(
      { sessionId: 'remote-tool-change', toolArgs: [] },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: '',
        command: '/bin/zsh',
        supportsStructured: false,
      },
    );

    adapter.pushEvent({
      type: 'tool:detect',
      sessionId: 'remote-tool-change',
      timestamp: Date.now(),
      data: { tool: '/bin/zsh', displayName: '/bin/zsh' },
    });

    expect(adapter.info).toMatchObject({
      name: '/bin/zsh',
      displayName: '/bin/zsh',
      command: '/bin/zsh',
    });
  });

  it('allows remote running status when no prompt is visible', () => {
    const adapter = new RemoteAdapter(
      { sessionId: 'remote-click', toolArgs: [] },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: '',
        command: 'codex',
        supportsStructured: true,
      },
    );

    adapter.start();
    adapter.pushEvent({
      type: 'raw:output',
      sessionId: 'remote-click',
      timestamp: Date.now(),
      data: { data: Buffer.from('startup complete').toString('base64') },
    });
    adapter.pushEvent({
      type: 'status:change',
      sessionId: 'remote-click',
      timestamp: Date.now(),
      data: { from: 'idle', to: 'running' },
    });

    expect(adapter.status).toBe('running');
  });

  it('does not let remote running status override a visible prompt', () => {
    const adapter = new RemoteAdapter(
      { sessionId: 'remote-prompt-running', toolArgs: [] },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: '',
        command: 'codex',
        supportsStructured: true,
      },
    );

    adapter.start();
    adapter.pushEvent({
      type: 'raw:output',
      sessionId: 'remote-prompt-running',
      timestamp: Date.now(),
      data: { data: Buffer.from('Do you want to proceed?\r\n  1. Yes\r\n  2. No\r\n').toString('base64') },
    });
    expect(adapter.status).toBe('waiting_input');

    adapter.pushEvent({
      type: 'status:change',
      sessionId: 'remote-prompt-running',
      timestamp: Date.now(),
      data: { from: 'waiting_input', to: 'running' },
    });

    expect(adapter.status).toBe('waiting_input');
  });

  it('marks remote sessions running when dashboard submits input', () => {
    const adapter = new RemoteAdapter(
      { sessionId: 'remote-submit', toolArgs: [] },
      {
        name: 'codex',
        displayName: 'Codex',
        icon: '',
        command: 'codex',
        supportsStructured: true,
      },
    );

    adapter.start();
    adapter.pushEvent({
      type: 'raw:output',
      sessionId: 'remote-submit',
      timestamp: Date.now(),
      data: { data: Buffer.from('startup complete').toString('base64') },
    });

    adapter.write('run ls\r');

    expect(adapter.status).toBe('running');
    adapter.pushEvent({
      type: 'status:change',
      sessionId: 'remote-submit',
      timestamp: Date.now(),
      data: { from: 'running', to: 'idle' },
    });
  });
});
