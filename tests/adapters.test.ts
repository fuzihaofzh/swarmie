import { describe, it, expect } from 'vitest';
import { createAdapter, getAdapterNames } from '../src/adapters/registry.js';

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
});
