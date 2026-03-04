import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { unlinkSync, existsSync } from 'node:fs';
import type { IPCClientMessage, IPCServerMessage } from './types.js';

/**
 * IPC server runs on the coordinator process.
 * Non-coordinator polycode instances connect here to register sessions.
 */
export class IPCServer extends EventEmitter {
  private server: Server | null = null;
  private clients = new Map<string, Socket>(); // sessionId -> socket
  private socketPath: string;

  constructor(socketPath: string) {
    super();
    this.socketPath = socketPath;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Remove stale socket file
      if (existsSync(this.socketPath)) {
        try {
          unlinkSync(this.socketPath);
        } catch {
          // ignore
        }
      }

      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  sendToSession(sessionId: string, msg: IPCServerMessage): void {
    const socket = this.clients.get(sessionId);
    if (socket && !socket.destroyed) {
      socket.write(JSON.stringify(msg) + '\n');
    }
  }

  async close(): Promise<void> {
    for (const socket of this.clients.values()) {
      socket.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          // Clean up socket file
          try {
            if (existsSync(this.socketPath)) {
              unlinkSync(this.socketPath);
            }
          } catch {
            // ignore
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: Socket): void {
    let buffer = '';
    let registeredSessionId: string | null = null;

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as IPCClientMessage;
          this.handleMessage(msg, socket, (sid) => {
            registeredSessionId = sid;
          });
        } catch {
          // ignore malformed
        }
      }
    });

    socket.on('close', () => {
      if (registeredSessionId) {
        this.clients.delete(registeredSessionId);
        this.emit('session:disconnected', registeredSessionId);
      }
    });

    socket.on('error', () => {
      if (registeredSessionId) {
        this.clients.delete(registeredSessionId);
        this.emit('session:disconnected', registeredSessionId);
      }
    });
  }

  private handleMessage(
    msg: IPCClientMessage,
    socket: Socket,
    setSessionId: (id: string) => void,
  ): void {
    switch (msg.type) {
      case 'register': {
        this.clients.set(msg.sessionId, socket);
        setSessionId(msg.sessionId);

        // Acknowledge registration
        const ack: IPCServerMessage = { type: 'registered', sessionId: msg.sessionId };
        socket.write(JSON.stringify(ack) + '\n');

        // Emit for the session manager
        this.emit('session:registered', {
          id: msg.sessionId,
          name: msg.name,
          tool: msg.tool,
          adapterInfo: msg.adapterInfo,
          cwd: msg.cwd,
          hostname: msg.hostname,
          command: msg.command,
        });
        break;
      }
      case 'event': {
        this.emit('session:event', msg.event);
        break;
      }
      case 'unregister': {
        this.clients.delete(msg.sessionId);
        this.emit('session:disconnected', msg.sessionId);
        break;
      }
      case 'ping': {
        const pong: IPCServerMessage = { type: 'pong' };
        socket.write(JSON.stringify(pong) + '\n');
        break;
      }
    }
  }
}
