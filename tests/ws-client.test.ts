import { describe, it, expect } from 'vitest';
import { parseServerAddress } from '../src/ipc/ws-client.js';

describe('parseServerAddress', () => {
  it('parses host:port', () => {
    expect(parseServerAddress('192.168.1.10:3200')).toBe('ws://192.168.1.10:3200/ws');
  });

  it('parses localhost:port', () => {
    expect(parseServerAddress('localhost:3200')).toBe('ws://localhost:3200/ws');
  });

  it('parses ws:// URL', () => {
    expect(parseServerAddress('ws://example.com:3200')).toBe('ws://example.com:3200/ws');
  });

  it('parses ws:// URL with existing path', () => {
    expect(parseServerAddress('ws://example.com:3200/custom')).toBe('ws://example.com:3200/custom');
  });

  it('parses http:// URL and converts to ws://', () => {
    expect(parseServerAddress('http://example.com:3200')).toBe('ws://example.com:3200/ws');
  });

  it('parses https:// URL and converts to wss://', () => {
    expect(parseServerAddress('https://example.com:3200')).toBe('wss://example.com:3200/ws');
  });

  it('parses wss:// URL', () => {
    // Port 443 is the default for wss, so URL normalizes it away
    expect(parseServerAddress('wss://example.com:443')).toBe('wss://example.com/ws');
    expect(parseServerAddress('wss://example.com:4443')).toBe('wss://example.com:4443/ws');
  });
});
