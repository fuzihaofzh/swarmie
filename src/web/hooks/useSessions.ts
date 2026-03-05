import { create } from 'zustand';
import { useUIStore } from './useUI';
import { playBellSound } from '../bellSound';

export interface SessionSummary {
  id: string;
  name: string;
  tool: string;
  status: string;
  startTime: number;
  endTime?: number;
  displayName: string;
  icon: string;
  cwd: string;
  hostname: string;
  autoApprove?: boolean;
}

export interface NormalizedEvent {
  type: string;
  sessionId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

interface SessionState {
  sessions: SessionSummary[];
  /** Plain object instead of Map — avoids zustand snapshot issues */
  events: Record<string, NormalizedEvent[]>;
  activeSessionId: string | null;

  setSessions: (sessions: SessionSummary[]) => void;
  addSession: (session: SessionSummary) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  addEvent: (event: NormalizedEvent) => void;
  addEventBatch: (sessionId: string, events: NormalizedEvent[]) => void;
  updateSessionStatus: (sessionId: string, status: string) => void;
  setSessionAutoApprove: (sessionId: string, value: boolean) => void;
}

const MAX_EVENTS_PER_SESSION = 2000;
const EMPTY_EVENTS: NormalizedEvent[] = [];

/** Stable selector for session events — returns same ref when empty */
export function useSessionEvents(sessionId: string): NormalizedEvent[] {
  return useSessionStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  events: {},
  activeSessionId: null,

  setSessions: (sessions) =>
    set((state) => {
      const activeSessionId = state.activeSessionId ?? sessions[0]?.id ?? null;
      return { sessions, activeSessionId };
    }),

  addSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((s) => s.id === session.id);
      if (exists) return state;
      const sessions = [...state.sessions, session];
      const activeSessionId = state.activeSessionId ?? session.id;
      return { sessions, activeSessionId };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const events = { ...state.events };
      delete events[id];
      const activeSessionId = state.activeSessionId === id ? null : state.activeSessionId;
      return { sessions, events, activeSessionId };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  addEvent: (event) =>
    set((state) => {
      const existing = state.events[event.sessionId] ?? [];
      const updated = [...existing, event];
      const trimmed = updated.length > MAX_EVENTS_PER_SESSION
        ? updated.slice(-MAX_EVENTS_PER_SESSION)
        : updated;

      const events = { ...state.events, [event.sessionId]: trimmed };

      let sessions = state.sessions;
      if (event.type === 'status:change') {
        const newStatus = (event.data as { to: string }).to;
        sessions = sessions.map((s) =>
          s.id === event.sessionId ? { ...s, status: newStatus } : s,
        );
        if (newStatus === 'waiting_input' && useUIStore.getState().bellSound) {
          playBellSound();
        }
      }
      if (event.type === 'session:end') {
        sessions = sessions.map((s) =>
          s.id === event.sessionId ? { ...s, endTime: event.timestamp } : s,
        );
      }

      return { events, sessions };
    }),

  addEventBatch: (sessionId, newEvents) =>
    set((state) => {
      const existing = state.events[sessionId] ?? [];
      const merged = [...existing, ...newEvents];
      const trimmed = merged.length > MAX_EVENTS_PER_SESSION
        ? merged.slice(-MAX_EVENTS_PER_SESSION)
        : merged;
      return { events: { ...state.events, [sessionId]: trimmed } };
    }),

  updateSessionStatus: (sessionId, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
      ),
    })),

  setSessionAutoApprove: (sessionId, value) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: value } : s,
      ),
    })),
}));
