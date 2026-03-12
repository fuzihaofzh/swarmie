import { create } from 'zustand';
import { useUIStore } from './useUI';
import { playBellSound } from '../bellSound';
import { saveRecentDir } from '../recentDirs';

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
  initialHostname: string;
  autoApprove?: boolean;
  /** '' for local server, absolute URL for remote */
  serverUrl: string;
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
  /** Update auto-approve from server broadcast (no sync back) */
  _setAutoApproveLocal: (sessionId: string, value: boolean) => void;
  /** Replace all sessions from a given server */
  setServerSessions: (serverUrl: string, sessions: SessionSummary[]) => void;
  /** Remove all sessions for a disconnected server */
  removeServerSessions: (serverUrl: string) => void;
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

/** Module-level callback to sync auto-approve state to server */
let autoApproveSync: ((sessionId: string, value: boolean) => void) | null = null;
export function registerAutoApproveSync(fn: ((sessionId: string, value: boolean) => void) | null) {
  autoApproveSync = fn;
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
      const merged = sessions.map((s) => ({
        ...s,
        serverUrl: s.serverUrl ?? '',
        autoApprove: s.autoApprove || saved[s.id] || false,
      }));
      const activeSessionId = state.activeSessionId ?? merged[0]?.id ?? null;
      return { sessions: merged, activeSessionId };
    }),

  addSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((s) => s.id === session.id);
      if (exists) return state;
      const saved = loadAutoApproveMap();
      const tagged = {
        ...session,
        serverUrl: session.serverUrl ?? '',
        autoApprove: session.autoApprove || saved[session.id] || false,
      };
      const sessions = [...state.sessions, tagged];
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
          // Auto-approve is now handled server-side; frontend only plays bell
          if (!sess?.autoApprove && useUIStore.getState().bellSound) {
            playBellSound();
          }
        }
      }
      if (event.type === 'tool:detect') {
        const { tool: detectedTool, displayName } = event.data as { tool: string; displayName: string };
        sessions = sessions.map((s) =>
          s.id === event.sessionId ? { ...s, tool: detectedTool, displayName } : s,
        );
      }
      if (event.type === 'cwd:change') {
        const { cwd, hostname } = event.data as { cwd: string; hostname?: string };
        if (cwd && cwd !== '~') {
          saveRecentDir({ dir: cwd, hostname: hostname ?? sessions.find((s) => s.id === event.sessionId)?.hostname });
        }
        sessions = sessions.map((s) =>
          s.id === event.sessionId ? { ...s, cwd, ...(hostname ? { hostname } : {}) } : s,
        );
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

      // Apply tool:detect and cwd:change from batch (e.g. on page refresh)
      let sessions = state.sessions;
      const detectEvt = newEvents.findLast((e) => e.type === 'tool:detect');
      if (detectEvt) {
        const { tool: detectedTool, displayName } = detectEvt.data as { tool: string; displayName: string };
        sessions = sessions.map((s) =>
          s.id === sessionId ? { ...s, tool: detectedTool, displayName } : s,
        );
      }
      const cwdEvt = newEvents.findLast((e) => e.type === 'cwd:change');
      if (cwdEvt) {
        const { cwd, hostname } = cwdEvt.data as { cwd: string; hostname?: string };
        sessions = sessions.map((s) =>
          s.id === sessionId ? { ...s, cwd, ...(hostname ? { hostname } : {}) } : s,
        );
      }

      return { events: { ...state.events, [sessionId]: trimmed }, sessions };
    }),

  updateSessionStatus: (sessionId, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
      ),
    })),

  setSessionAutoApprove: (sessionId, value) => {
    autoApproveSync?.(sessionId, value);
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: value } : s,
      );
      saveAutoApproveMap(sessions);
      return { sessions };
    });
  },

  _setAutoApproveLocal: (sessionId, value) =>
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: value } : s,
      );
      saveAutoApproveMap(sessions);
      return { sessions };
    }),

  setServerSessions: (serverUrl, incoming) =>
    set((state) => {
      const saved = loadAutoApproveMap();
      const tagged = incoming.map((s) => {
        const merged = saved[s.id] ? { ...s, autoApprove: true, serverUrl } : { ...s, serverUrl };
        return merged;
      });
      // Keep sessions from other servers, replace sessions from this server
      const others = state.sessions.filter((s) => s.serverUrl !== serverUrl);
      const sessions = [...others, ...tagged];
      const activeSessionId = state.activeSessionId ?? sessions[0]?.id ?? null;
      return { sessions, activeSessionId };
    }),

  removeServerSessions: (serverUrl) =>
    set((state) => {
      const removed = state.sessions.filter((s) => s.serverUrl === serverUrl);
      const sessions = state.sessions.filter((s) => s.serverUrl !== serverUrl);
      const events = { ...state.events };
      for (const s of removed) delete events[s.id];
      const activeSessionId =
        removed.some((s) => s.id === state.activeSessionId)
          ? (sessions[0]?.id ?? null)
          : state.activeSessionId;
      return { sessions, events, activeSessionId };
    }),
}));
