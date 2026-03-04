import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { NormalizedEvent, AdapterInfo } from '../adapters/types.js';
import type { IPCClientMessage, IPCServerMessage } from './types.js';

/**
 * IPC client runs on non-coordinator swarmie instances.
 * Connects to the coordinator's Unix socket to register sessions
 * and forward events.
 */
export class IPCClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private sessionId: string;
  private buffer = '';

  constructor(socketPath: string, sessionId: string) {
    super();
    this.socketPath = socketPath;
    this.sessionId = sessionId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = connect(this.socketPath);

      this.socket.on('connect', () => {
        resolve();
      });

      this.socket.on('error', (err) => {
        reject(err);
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as IPCServerMessage;
            this.handleMessage(msg);
          } catch {
            // ignore
          }
        }
      });

      this.socket.on('close', () => {
        this.emit('disconnected');
      });
    });
  }

  register(info: {
    name: string;
    tool: string;
    adapterInfo: AdapterInfo;
    cwd: string;
    hostname: string;
    command: string[];
  }): void {
    this.send({
      type: 'register',
      sessionId: this.sessionId,
      ...info,
    });
  }

  sendEvent(event: NormalizedEvent): void {
    this.send({ type: 'event', event });
  }

  unregister(): void {
    this.send({ type: 'unregister', sessionId: this.sessionId });
  }

  close(): void {
    this.unregister();
    this.socket?.destroy();
    this.socket = null;
  }

  private send(msg: IPCClientMessage): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(msg) + '\n');
    }
  }

  private handleMessage(msg: IPCServerMessage): void {
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
      case 'pong':
        this.emit('pong');
        break;
      case 'error':
        this.emit('error', new Error(msg.message));
        break;
    }
  }
}
