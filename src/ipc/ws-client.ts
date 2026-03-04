import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { NormalizedEvent, AdapterInfo } from '../adapters/types.js';

/**
 * WebSocket remote client — connects a local swarmie instance
 * to a remote coordinator's dashboard via WebSocket.
 *
 * Interface mirrors IPCClient: connect/close/register/sendEvent + events.
 */
export class WSRemoteClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private sessionId: string;
  private closed = false;

  /** Info needed for re-registration on reconnect */
  private registrationInfo?: {
    name: string;
    tool: string;
    adapterInfo: AdapterInfo;
    cwd: string;
    hostname: string;
    command: string[];
  };

  /** Reconnect state */
  private reconnectDelay = 3000;
  private readonly maxReconnectDelay = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Buffer messages while disconnected */
  private buffer: string[] = [];
  private readonly maxBufferSize = 1000;

  constructor(url: string, sessionId: string) {
    super();
    this.url = url;
    this.sessionId = sessionId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.doConnect(resolve, reject);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Send unregister before closing
      this.send({ type: 'unregister', sessionId: this.sessionId });
      this.ws.close();
      this.ws = null;
    }
  }

  register(info: {
    name: string;
    tool: string;
    adapterInfo: AdapterInfo;
    cwd: string;
    hostname: string;
    command: string[];
  }): void {
    this.registrationInfo = info;
    this.send({
      type: 'register',
      sessionId: this.sessionId,
      ...info,
    });
  }

  sendEvent(event: NormalizedEvent): void {
    this.send({ type: 'event', event });
  }

  private doConnect(
    resolve?: () => void,
    reject?: (err: Error) => void,
  ): void {
    if (this.closed) return;

    const ws = new WebSocket(this.url);
    let connected = false;

    ws.on('open', () => {
      connected = true;
      this.ws = ws;
      this.reconnectDelay = 3000; // Reset backoff

      // Re-register if reconnecting
      if (this.registrationInfo) {
        this.send({
          type: 'register',
          sessionId: this.sessionId,
          ...this.registrationInfo,
        });
      }

      // Flush buffered messages
      const pending = this.buffer.splice(0);
      for (const msg of pending) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      }

      if (resolve) resolve();
    });

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch {
        // ignore
      }
    });

    ws.on('error', (err) => {
      if (!connected && reject) {
        reject(err as Error);
        resolve = undefined;
        reject = undefined;
      }
    });

    ws.on('close', () => {
      this.ws = null;
      if (!this.closed) {
        this.emit('disconnected');
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        this.doConnect();
      }
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private send(msg: unknown): void {
    const payload = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Buffer while disconnected (skip raw:output to limit buffer size)
      const parsed = msg as { type?: string; event?: { type?: string } };
      if (parsed.type === 'event' && parsed.event?.type === 'raw:output') {
        return; // Don't buffer high-volume output data
      }
      if (this.buffer.length < this.maxBufferSize) {
        this.buffer.push(payload);
      }
    }
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {
      case 'registered':
        this.emit('registered', msg.sessionId);
        break;
      case 'input':
        if (msg.sessionId === this.sessionId) {
          this.emit('input', msg.data);
        }
        break;
      case 'resize':
        if (msg.sessionId === this.sessionId) {
          this.emit('resize', msg.cols, msg.rows);
        }
        break;
      case 'kill':
        if (msg.sessionId === this.sessionId) {
          this.emit('kill', msg.signal);
        }
        break;
    }
  }
}

/**
 * Parse a server address into a WebSocket URL.
 * Supports: `host:port`, `ws://host:port`, `http://host:port`
 */
export function parseServerAddress(addr: string): string {
  if (addr.startsWith('ws://') || addr.startsWith('wss://')) {
    // Ensure /ws path
    const url = new URL(addr);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/ws';
    }
    return url.toString();
  }
  if (addr.startsWith('http://') || addr.startsWith('https://')) {
    const url = new URL(addr);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/ws';
    }
    return url.toString();
  }
  // Plain host:port
  return `ws://${addr}/ws`;
}
