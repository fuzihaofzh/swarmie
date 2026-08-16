import { afterEach, describe, expect, it } from 'vitest';
import {
  hostnamesEquivalent,
  isSelfServerUrl,
  remoteHostLabel,
  serverUrlHostname,
  sessionHostLabel,
} from '../src/web/serverHost';

// The helpers read window.location.hostname; the node test env has no window,
// so stub it per-case and clean up.
function withHostname(hostname: string | null, fn: () => void): void {
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  if (hostname === null) {
    delete g.window;
  } else {
    g.window = { location: { hostname } };
  }
  try {
    fn();
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('serverUrlHostname', () => {
  it('extracts the hostname from a server URL', () => {
    expect(serverUrlHostname('http://seis10:3200')).toBe('seis10');
    expect(serverUrlHostname('http://192.168.0.253:3200')).toBe('192.168.0.253');
  });

  it('returns null for empty or unparseable input', () => {
    expect(serverUrlHostname(undefined)).toBeNull();
    expect(serverUrlHostname('')).toBeNull();
    expect(serverUrlHostname('not a url')).toBeNull();
  });
});

describe('isSelfServerUrl', () => {
  it('is true when the URL host matches the page host (ignoring port)', () => {
    withHostname('192.168.0.253', () => {
      expect(isSelfServerUrl('http://192.168.0.253:3200')).toBe(true);
      // A different port on the same box is still self.
      expect(isSelfServerUrl('http://192.168.0.253:9999')).toBe(true);
    });
  });

  it('is false for a genuinely different host', () => {
    withHostname('192.168.0.253', () => {
      expect(isSelfServerUrl('http://seis10:3200')).toBe(false);
    });
  });

  it('is false when there is no window (SSR/node)', () => {
    withHostname(null, () => {
      expect(isSelfServerUrl('http://192.168.0.253:3200')).toBe(false);
    });
  });

  it('treats loopback and harmless local DNS variants as equivalent', () => {
    withHostname('localhost', () => {
      expect(isSelfServerUrl('http://127.0.0.1:3200')).toBe(true);
    });
    withHostname('MacBook-M4-Pro.local', () => {
      expect(isSelfServerUrl('http://macbook-m4-pro:3200')).toBe(true);
    });
  });
});

describe('hostnamesEquivalent', () => {
  it('ignores case, a trailing dot, and the macOS .local suffix', () => {
    expect(hostnamesEquivalent('MacBook-M4-Pro.local', 'macbook-m4-pro.')).toBe(true);
    expect(hostnamesEquivalent('worker-1', 'worker-2')).toBe(false);
  });
});

describe('remoteHostLabel', () => {
  it('returns null for a local (empty) serverUrl', () => {
    expect(remoteHostLabel('')).toBeNull();
    expect(remoteHostLabel(undefined)).toBeNull();
  });

  it('returns null when the serverUrl is this same machine (LAN IP case)', () => {
    withHostname('192.168.0.253', () => {
      // The reported bug: viewing the dashboard by LAN IP tagged local
      // sessions with that IP; we now suppress it.
      expect(remoteHostLabel('http://192.168.0.253:3200')).toBeNull();
    });
  });

  it('returns the hostname for a genuinely remote server', () => {
    withHostname('192.168.0.253', () => {
      expect(remoteHostLabel('http://seis10:3200')).toBe('seis10');
    });
  });
});

describe('sessionHostLabel', () => {
  const localSession = {
    serverUrl: '',
    hostname: 'MacBook-M4-Pro.local',
    initialHostname: 'MacBook-M4-Pro',
  };

  it('does not prefix a local tab for a .local hostname variant', () => {
    withHostname('localhost', () => {
      expect(sessionHostLabel(localSession, [localSession])).toBeNull();
    });
  });

  it('recognizes the local server reached through another alias', () => {
    const sameMachineViaAlias = {
      serverUrl: 'http://Mac:3200',
      hostname: 'MacBook-M4-Pro',
      initialHostname: 'MacBook-M4-Pro',
    };
    withHostname('localhost', () => {
      expect(sessionHostLabel(sameMachineViaAlias, [localSession, sameMachineViaAlias])).toBeNull();
    });
  });

  it('keeps a genuine remote server prefix', () => {
    const remoteSession = {
      serverUrl: 'http://seis10:3200',
      hostname: 'worker-1',
      initialHostname: 'worker-1',
    };
    withHostname('localhost', () => {
      expect(sessionHostLabel(remoteSession, [localSession, remoteSession])).toBe('seis10');
    });
  });

  it('keeps a genuine SSH hostname on a locally sourced session', () => {
    const sshSession = {
      serverUrl: '',
      hostname: 'gpu-worker',
      initialHostname: 'MacBook-M4-Pro',
    };
    withHostname('localhost', () => {
      expect(sessionHostLabel(sshSession, [localSession, sshSession])).toBe('gpu-worker');
    });
  });
});
