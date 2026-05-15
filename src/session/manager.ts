import { EventEmitter } from 'node:events';
import { Session, type SessionSettingsPatch } from './session.js';
import type { BaseAdapter } from '../adapters/base.js';
import type { NormalizedEvent } from '../adapters/types.js';
import type { SessionSummary } from './types.js';

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private autoCompactMinutes = 60;

  addSession(id: string, name: string, adapter: BaseAdapter, opts?: { cwd?: string; hostname?: string }): Session {
    const session = new Session(id, name, adapter, opts);
    session.setAutoCompactMinutes(this.autoCompactMinutes);

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

  setSessionSettings(id: string, patch: SessionSettingsPatch): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.setSettings(patch);
    return session;
  }

  setAutoCompactMinutes(minutes: number): number {
    this.autoCompactMinutes = Math.min(24 * 60, Math.max(1, Math.floor(minutes)));
    for (const session of this.sessions.values()) {
      session.setAutoCompactMinutes(this.autoCompactMinutes);
    }
    return this.autoCompactMinutes;
  }

  getAutoCompactMinutes(): number {
    return this.autoCompactMinutes;
  }
}
