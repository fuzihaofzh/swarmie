import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli/args.js';

describe('parseArgs', () => {
  it('parses tool name', () => {
    const result = parseArgs(['node', 'polycode', 'claude']);
    expect(result.tool).toBe('claude');
    expect(result.toolArgs).toEqual([]);
  });

  it('parses polycode options', () => {
    const result = parseArgs(['node', 'polycode', 'claude', '--port', '4000', '--record']);
    expect(result.tool).toBe('claude');
    expect(result.polycodeOptions.port).toBe(4000);
    expect(result.polycodeOptions.record).toBe(true);
  });

  it('splits args at --', () => {
    const result = parseArgs(['node', 'polycode', 'claude', '--port', '3200', '--', '-p', 'fix bug']);
    expect(result.tool).toBe('claude');
    expect(result.polycodeOptions.port).toBe(3200);
    expect(result.toolArgs).toEqual(['-p', 'fix bug']);
  });

  it('passes all args after -- to tool', () => {
    const result = parseArgs(['node', 'polycode', 'codex', '--', '--model', 'o3', 'add tests']);
    expect(result.tool).toBe('codex');
    expect(result.toolArgs).toEqual(['--model', 'o3', 'add tests']);
  });

  it('defaults port to 3200', () => {
    const result = parseArgs(['node', 'polycode', 'gemini']);
    expect(result.polycodeOptions.port).toBe(3200);
  });

  it('defaults web to true', () => {
    const result = parseArgs(['node', 'polycode', 'claude']);
    expect(result.polycodeOptions.web).toBe(true);
  });

  it('handles --no-web', () => {
    const result = parseArgs(['node', 'polycode', 'claude', '--no-web']);
    expect(result.polycodeOptions.web).toBe(false);
  });

  it('handles --session-name', () => {
    const result = parseArgs(['node', 'polycode', 'claude', '--session-name', 'my-feature']);
    expect(result.polycodeOptions.sessionName).toBe('my-feature');
  });
});
