import { describe, it, expect } from 'vitest';
import { createAdapter, getAdapterNames } from '../src/adapters/registry.js';
import { RemoteAdapter } from '../src/adapters/remote.js';

describe('adapter registry', () => {
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
    const adapter = createAdapter('cld', { sessionId: 'generic-batch', toolArgs: [] });
    adapter.write('codex\r');
    (adapter as unknown as { detectTool: (chunk: string) => void }).detectTool('Welcome to Codex');

    expect(adapter.info.name).toBe('codex');
    expect(adapter.info.displayName).toBe('Codex');
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
