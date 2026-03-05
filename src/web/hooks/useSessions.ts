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

const AUTO_APPROVE_KEY = 'swarmie-auto-approve-map';

function loadAutoApproveMap(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(AUTO_APPROVE_KEY) || '{}'); }
  catch { return {}; }
}

function saveAutoApproveMap(sessions: SessionSummary[]) {
  const map: Record<string, boolean> = {};
  for (const s of sessions) { if (s.autoApprove) map[s.id] = true; }
  localStorage.setItem(AUTO_APPROVE_KEY, JSON.stringify(map));
}

/** Module-level callback set by useWebSocket to send auto-approve input */
let autoApproveSend: ((sessionId: string) => void) | null = null;
export function registerAutoApproveSend(fn: ((sessionId: string) => void) | null) {
  autoApproveSend = fn;
}

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
      const saved = loadAutoApproveMap();
      const merged = sessions.map((s) =>
        saved[s.id] ? { ...s, autoApprove: true } : s,
      );
      const activeSessionId = state.activeSessionId ?? merged[0]?.id ?? null;
      return { sessions: merged, activeSessionId };
    }),

  addSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((s) => s.id === session.id);
      if (exists) return state;
      const saved = loadAutoApproveMap();
      const merged = saved[session.id] ? { ...session, autoApprove: true } : session;
      const sessions = [...state.sessions, merged];
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
        if (newStatus === 'waiting_input') {
          const sess = sessions.find((s) => s.id === event.sessionId);
          if (sess?.autoApprove && autoApproveSend) {
            const sid = event.sessionId;
            queueMicrotask(() => autoApproveSend?.(sid));
          } else if (useUIStore.getState().bellSound) {
            playBellSound();
          }
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
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: value } : s,
      );
      saveAutoApproveMap(sessions);
      return { sessions };
    }),
}));
