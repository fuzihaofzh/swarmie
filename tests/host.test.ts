import { describe, it, expect, vi } from 'vitest';

let currentHostname = 'MacBook-M4-Pro';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: () => currentHostname };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => {
      throw new Error('no external hostname commands in this test');
    },
  };
});

const { isLocalHostname } = await import('../src/session/host.js');

describe('isLocalHostname', () => {
  it('recognizes hostnames the machine takes on after startup', () => {
    expect(isLocalHostname('MacBook-M4-Pro')).toBe(true);
    expect(isLocalHostname('Mac')).toBe(false);

    // macOS renamed the box after a network change; a newly started shell
    // reports the new name in OSC 7.
    currentHostname = 'Mac';
    expect(isLocalHostname('Mac')).toBe(true);

    // Later it moves on again, but that shell keeps reporting "Mac".
    currentHostname = '192.168.124.2';
    expect(isLocalHostname('Mac')).toBe(true);
    expect(isLocalHostname('seis10')).toBe(false);
  });
});
