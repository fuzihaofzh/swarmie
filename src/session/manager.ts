import { EventEmitter } from 'node:events';
import { Session } from './session.js';
import type { BaseAdapter } from '../adapters/base.js';
import type { NormalizedEvent } from '../adapters/types.js';
import type { SessionSummary } from './types.js';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();

  addSession(id: string, name: string, adapter: BaseAdapter): Session {
    const session = new Session(id, name, adapter);

    session.on('event', (event: NormalizedEvent) => {
      this.emit('event', event);
    });

    this.sessions.set(id, session);
    this.emit('session:added', session.summary);

    return session;
  }

  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.removeAllListeners();
      this.sessions.delete(id);
      this.emit('session:removed', id);
    }
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getSessionSummaries(): SessionSummary[] {
    return this.getAllSessions().map((s) => s.summary);
  }

  get size(): number {
    return this.sessions.size;
  }
}
