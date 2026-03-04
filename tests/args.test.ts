import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('parses tool name', () => {
    const result = parseArgs(['node', 'swarmie', 'claude']);
    expect(result.tool).toBe('claude');
    expect(result.toolArgs).toEqual([]);
  });

  it('parses swarmie options', () => {
    const result = parseArgs(['node', 'swarmie', 'claude', '--port', '4000', '--record']);
    expect(result.tool).toBe('claude');
    expect(result.swarmieOptions.port).toBe(4000);
    expect(result.swarmieOptions.record).toBe(true);
  });

  it('splits args at --', () => {
    const result = parseArgs(['node', 'swarmie', 'claude', '--port', '3200', '--', '-p', 'fix bug']);
    expect(result.tool).toBe('claude');
    expect(result.swarmieOptions.port).toBe(3200);
    expect(result.toolArgs).toEqual(['-p', 'fix bug']);
  });

  it('passes all args after -- to tool', () => {
    const result = parseArgs(['node', 'swarmie', 'codex', '--', '--model', 'o3', 'add tests']);
    expect(result.tool).toBe('codex');
    expect(result.toolArgs).toEqual(['--model', 'o3', 'add tests']);
  });

  it('defaults port to 3200', () => {
    const result = parseArgs(['node', 'swarmie', 'gemini']);
    expect(result.swarmieOptions.port).toBe(3200);
  });

  it('defaults web to true', () => {
    const result = parseArgs(['node', 'swarmie', 'claude']);
    expect(result.swarmieOptions.web).toBe(true);
  });

  it('handles --no-web', () => {
    const result = parseArgs(['node', 'swarmie', 'claude', '--no-web']);
    expect(result.swarmieOptions.web).toBe(false);
  });

  it('handles --session-name', () => {
    const result = parseArgs(['node', 'swarmie', 'claude', '--session-name', 'my-feature']);
    expect(result.swarmieOptions.sessionName).toBe('my-feature');
  });

  it('defaults host to 127.0.0.1', () => {
    const result = parseArgs(['node', 'swarmie', 'claude']);
    expect(result.swarmieOptions.host).toBe('127.0.0.1');
  });

  it('handles --host', () => {
    const result = parseArgs(['node', 'swarmie', 'claude', '--host', '0.0.0.0']);
    expect(result.swarmieOptions.host).toBe('0.0.0.0');
  });

  it('defaults server to undefined', () => {
    const result = parseArgs(['node', 'swarmie', 'claude']);
    expect(result.swarmieOptions.server).toBeUndefined();
  });

  it('handles --server', () => {
    const result = parseArgs(['node', 'swarmie', 'codex', '--server', '192.168.1.10:3200']);
    expect(result.swarmieOptions.server).toBe('192.168.1.10:3200');
  });

  it('allows no tool argument (server-only mode)', () => {
    const result = parseArgs(['node', 'swarmie']);
    expect(result.tool).toBeUndefined();
    expect(result.toolArgs).toEqual([]);
  });

  it('allows no tool with options', () => {
    const result = parseArgs(['node', 'swarmie', '--port', '4000']);
    expect(result.tool).toBeUndefined();
    expect(result.swarmieOptions.port).toBe(4000);
  });
});
