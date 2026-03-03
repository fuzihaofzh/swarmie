import type { BaseAdapter, AdapterOptions } from './base.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { GenericAdapter } from './generic.js';

type AdapterConstructor = new (options: AdapterOptions) => BaseAdapter;

const registry = new Map<string, AdapterConstructor>();

export function registerAdapter(name: string, ctor: AdapterConstructor): void {
  registry.set(name, ctor);
}

export function getAdapter(name: string): AdapterConstructor | undefined {
  return registry.get(name);
}

export function getAdapterNames(): string[] {
  return Array.from(registry.keys());
}

/**
 * Create an adapter by name.
 * If name matches a registered adapter (claude/codex/gemini), use it.
 * Otherwise treat the name as a command and use GenericAdapter.
 */
export function createAdapter(name: string, options: AdapterOptions): BaseAdapter {
  const Ctor = registry.get(name);
  if (Ctor) {
    return new Ctor(options);
  }
  // Fall back to generic PTY adapter — treat `name` as the command
  return new GenericAdapter(name, options);
}

// Register built-in adapters
registerAdapter('claude', ClaudeAdapter);
registerAdapter('codex', CodexAdapter);
registerAdapter('gemini', GeminiAdapter);
