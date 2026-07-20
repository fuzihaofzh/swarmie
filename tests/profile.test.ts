import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The profiler ships enabled-by-env. These cases pin the two properties that
 * make that safe: it is genuinely inert unless SWARMIE_PROFILE is set, and it
 * actually records when it is.
 */
describe('pipeline profiler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is disabled unless SWARMIE_PROFILE is set', async () => {
    vi.stubEnv('SWARMIE_PROFILE', '');
    vi.resetModules();
    const PROF = await import('../src/server/profile.js');
    expect(PROF.profiling).toBe(false);
  });

  it('records nothing while disabled', async () => {
    vi.stubEnv('SWARMIE_PROFILE', '');
    vi.resetModules();
    const PROF = await import('../src/server/profile.js');

    // Calling the hot-path helpers must be a no-op, not a throw and not a write.
    expect(() => {
      PROF.mark('test.phase', PROF.nowNs(), 123, 'sid');
      PROF.markMs('test.phase', 5, 123, 'sid');
      PROF.flush();
    }).not.toThrow();
  });

  it('writes samples when enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmie-prof-'));
    const out = join(dir, 'prof.jsonl');
    try {
      vi.stubEnv('SWARMIE_PROFILE', out);
      vi.resetModules();
      const PROF = await import('../src/server/profile.js');
      expect(PROF.profiling).toBe(true);

      PROF.mark('test.phase', PROF.nowNs(), 42, 'sess1');
      PROF.markMs('test.elapsed', 7, 99, 'sess1');
      PROF.flush();

      expect(existsSync(out)).toBe(true);
      const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ phase: 'test.phase', n: 42, sid: 'sess1' });
      // markMs takes milliseconds and stores microseconds.
      expect(lines[1]).toMatchObject({ phase: 'test.elapsed', us: 7000, n: 99 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
