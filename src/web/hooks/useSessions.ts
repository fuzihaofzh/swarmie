import { create } from 'zustand';
import { useUIStore } from './useUI';
import { playBellSound } from '../bellSound';
import { saveRecentDir, setLocalHostname } from '../recentDirs';

export interface SessionSummary {
  id: string;
  name: string;
  tool: string;
  status: string;
  seen?: boolean;
  stateChangeSeq?: number;
  startTime: number;
  endTime?: number;
  displayName: string;
  icon: string;
  cwd: string;
  workspaceCwd?: string;
  hostname: string;
  initialHostname: string;
  autoApprove?: boolean;
  autoCompact?: boolean;
  repeatEnabled?: boolean;
  repeatCommand?: string;
  repeatIntervalSeconds?: number;
  repeatClear?: boolean;
  nextRepeatAt?: number | null;
  nextAutoCompactAt?: number | null;
  tags?: string[];
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
  archivedSessionIds: string[];

  setSessions: (sessions: SessionSummary[]) => void;
  addSession: (session: SessionSummary) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  archiveSessions: (ids: string[]) => void;
  unarchiveSessions: (ids: string[]) => void;
  archiveCompletedSessions: () => void;
  addEvent: (event: NormalizedEvent) => void;
  addEventBatch: (sessionId: string, events: NormalizedEvent[]) => void;
  updateSessionStatus: (sessionId: string, status: string) => void;
  setSessionAutoApprove: (sessionId: string, value: boolean) => void;
  setSessionAutoCompact: (sessionId: string, value: boolean) => void;
  setSessionRepeat: (sessionId: string, patch: RepeatSettingsPatch) => void;
  setSessionTags: (sessionId: string, tags: string[]) => void;
  /** Update auto-approve from server broadcast (no sync back) */
  _setAutoApproveLocal: (sessionId: string, value: boolean) => void;
  _setSeenLocal: (sessionId: string) => void;
  _applySessionSettingsLocal: (sessionId: string, patch: SessionSettingsPatch) => void;
  /** Replace all sessions from a given server */
  setServerSessions: (serverUrl: string, sessions: SessionSummary[]) => void;
  /** Remove all sessions for a disconnected server */
  removeServerSessions: (serverUrl: string) => void;
}

const MAX_EVENTS_PER_SESSION = 2000;
const EMPTY_EVENTS: NormalizedEvent[] = [];

const SESSION_SETTINGS_KEY = 'swarmie-session-settings-map';
const ARCHIVED_SESSIONS_KEY = 'swarmie-archived-session-ids';

export interface SessionSettingsPatch {
  autoApprove?: boolean;
  autoCompact?: boolean;
  repeatEnabled?: boolean;
  repeatCommand?: string;
  repeatIntervalSeconds?: number;
  repeatClear?: boolean;
  nextRepeatAt?: number | null;
  nextAutoCompactAt?: number | null;
  tags?: string[];
}

type SavedSessionSettings = Record<string, SessionSettingsPatch>;
export interface RepeatSettingsPatch {
  enabled?: boolean;
  command?: string;
  intervalSeconds?: number;
  clear?: boolean;
}

function loadSessionSettingsMap(): SavedSessionSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_SETTINGS_KEY) || '{}') as SavedSessionSettings;
    if (Object.keys(saved).length > 0) return saved;
    const legacy = JSON.parse(localStorage.getItem('swarmie-auto-approve-map') || '{}') as Record<string, boolean>;
    return Object.fromEntries(
      Object.entries(legacy)
        .filter(([, value]) => value)
        .map(([id]) => [id, { autoApprove: true }]),
    );
  } catch {
    return {};
  }
}

function loadArchivedSessionIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ARCHIVED_SESSIONS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveArchivedSessionIds(ids: string[]) {
  localStorage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify(ids));
}

function saveSessionSettingsMap(sessions: SessionSummary[]) {
  const map: SavedSessionSettings = {};
  for (const s of sessions) {
    const settings: SessionSettingsPatch = {};
    if (s.autoApprove) settings.autoApprove = true;
    if (s.autoCompact) settings.autoCompact = true;
    if (s.repeatEnabled) settings.repeatEnabled = true;
    if (s.repeatCommand) settings.repeatCommand = s.repeatCommand;
    if (s.repeatIntervalSeconds !== undefined && s.repeatIntervalSeconds !== 60) {
      settings.repeatIntervalSeconds = s.repeatIntervalSeconds;
    }
    if (s.repeatClear) settings.repeatClear = true;
    if (s.tags && s.tags.length > 0) settings.tags = s.tags;
    if (Object.keys(settings).length > 0) map[s.id] = settings;
  }
  localStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(map));
}

function clampRepeatIntervalSeconds(seconds: number | undefined): number {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 60;
  return Math.min(24 * 60 * 60, Math.max(1, Math.floor(value)));
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, '-').slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized.slice(0, 12);
}

function isArchivableStatus(status: string): boolean {
  return status === 'completed' || status === 'error';
}

function firstUnarchivedSessionId(sessions: SessionSummary[], archivedIds: Set<string>): string | null {
  return sessions.find((s) => !archivedIds.has(s.id))?.id ?? null;
}

function activeSessionIdFor(
  sessions: SessionSummary[],
  activeSessionId: string | null,
  archivedIds: Set<string>,
): string | null {
  if (activeSessionId && sessions.some((s) => s.id === activeSessionId) && !archivedIds.has(activeSessionId)) {
    return activeSessionId;
  }
  return firstUnarchivedSessionId(sessions, archivedIds);
}

function applySavedSettings(session: SessionSummary, saved: SavedSessionSettings): SessionSummary {
  const patch = saved[session.id] ?? {};
  return {
    ...session,
    serverUrl: session.serverUrl ?? '',
    autoApprove: session.autoApprove || patch.autoApprove || false,
    autoCompact: session.autoCompact || patch.autoCompact || false,
    repeatEnabled: session.repeatEnabled || patch.repeatEnabled || false,
    repeatCommand: session.repeatCommand ?? patch.repeatCommand ?? '',
    repeatIntervalSeconds: clampRepeatIntervalSeconds(session.repeatIntervalSeconds ?? patch.repeatIntervalSeconds),
    repeatClear: session.repeatClear || patch.repeatClear || false,
    tags: normalizeTags(session.tags ?? patch.tags ?? []),
  };
}

/** Module-level callback to sync auto-approve state to server */
let autoApproveSync: ((sessionId: string, value: boolean) => void) | null = null;
export function registerAutoApproveSync(fn: ((sessionId: string, value: boolean) => void) | null) {
  autoApproveSync = fn;
}

let sessionSettingsSync: ((sessionId: string, patch: SessionSettingsPatch) => void) | null = null;
export function registerSessionSettingsSync(fn: ((sessionId: string, patch: SessionSettingsPatch) => void) | null) {
  sessionSettingsSync = fn;
}

/** Stable selector for session events — returns same ref when empty */
export function useSessionEvents(sessionId: string): NormalizedEvent[] {
  return useSessionStore((state) => state.events[sessionId] ?? EMPTY_EVENTS);
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  events: {},
  activeSessionId: null,
  archivedSessionIds: loadArchivedSessionIds(),

  setSessions: (sessions) =>
    set((state) => {
      const local = sessions.find((s) => !s.serverUrl || s.serverUrl === '');
      if (local?.initialHostname) setLocalHostname(local.initialHostname);
      const saved = loadSessionSettingsMap();
      const merged = sessions.map((s) => applySavedSettings(s, saved));
      const archived = new Set(state.archivedSessionIds);
      const activeSessionId = activeSessionIdFor(merged, state.activeSessionId, archived);
      return { sessions: merged, activeSessionId };
    }),

  addSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((s) => s.id === session.id);
      if (exists) return state;
      const saved = loadSessionSettingsMap();
      const tagged = applySavedSettings(session, saved);
      const sessions = [...state.sessions, tagged];
      const archived = new Set(state.archivedSessionIds);
      const activeSessionId = activeSessionIdFor(sessions, state.activeSessionId, archived);
      return { sessions, activeSessionId };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const events = { ...state.events };
      delete events[id];
      const archivedSessionIds = state.archivedSessionIds.filter((archivedId) => archivedId !== id);
      if (archivedSessionIds.length !== state.archivedSessionIds.length) {
        saveArchivedSessionIds(archivedSessionIds);
      }
      const archived = new Set(archivedSessionIds);
      const activeSessionId = state.activeSessionId === id
        ? firstUnarchivedSessionId(sessions, archived)
        : state.activeSessionId;
      return { sessions, events, activeSessionId, archivedSessionIds };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  archiveSessions: (ids) =>
    set((state) => {
      const requested = new Set(ids);
      const archivable = state.sessions
        .filter((s) => requested.has(s.id) && isArchivableStatus(s.status))
        .map((s) => s.id);
      if (archivable.length === 0) return state;
      const archived = new Set(state.archivedSessionIds);
      for (const id of archivable) archived.add(id);
      const archivedSessionIds = [...archived];
      saveArchivedSessionIds(archivedSessionIds);
      const activeSessionId = state.activeSessionId && archived.has(state.activeSessionId)
        ? firstUnarchivedSessionId(state.sessions, archived)
        : state.activeSessionId;
      return { archivedSessionIds, activeSessionId };
    }),

  unarchiveSessions: (ids) =>
    set((state) => {
      const toRestore = new Set(ids);
      const archivedSessionIds = state.archivedSessionIds.filter((id) => !toRestore.has(id));
      if (archivedSessionIds.length === state.archivedSessionIds.length) return state;
      saveArchivedSessionIds(archivedSessionIds);
      const activeSessionId = state.activeSessionId ?? ids.find((id) => state.sessions.some((s) => s.id === id)) ?? null;
      return { archivedSessionIds, activeSessionId };
    }),

  archiveCompletedSessions: () =>
    set((state) => {
      const archived = new Set(state.archivedSessionIds);
      let changed = false;
      for (const session of state.sessions) {
        if (!isArchivableStatus(session.status)) continue;
        if (!archived.has(session.id)) {
          archived.add(session.id);
          changed = true;
        }
      }
      if (!changed) return state;
      const archivedSessionIds = [...archived];
      saveArchivedSessionIds(archivedSessionIds);
      const activeSessionId = state.activeSessionId && archived.has(state.activeSessionId)
        ? firstUnarchivedSessionId(state.sessions, archived)
        : state.activeSessionId;
      return { archivedSessionIds, activeSessionId };
    }),

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
        const statusData = event.data as { to: string; seen?: boolean; stateChangeSeq?: number };
        const newStatus = statusData.to;
        sessions = sessions.map((s) =>
          s.id === event.sessionId
            ? {
                ...s,
                status: newStatus,
                ...(statusData.seen !== undefined ? { seen: statusData.seen } : {}),
                ...(statusData.stateChangeSeq !== undefined
                  ? { stateChangeSeq: statusData.stateChangeSeq }
                  : {}),
              }
            : s,
        );
        if (newStatus === 'waiting_input') {
          const sess = sessions.find((s) => s.id === event.sessionId);
          // Auto-approve is now handled server-side; frontend only plays bell
          if (!sess?.autoApprove && useUIStore.getState().bellSound) {
            playBellSound();
          }
        }
        if (newStatus === 'done' && useUIStore.getState().bellSound) {
          const activelyVisible = typeof document !== 'undefined'
            && !document.hidden
            && state.activeSessionId === event.sessionId;
          if (!activelyVisible) playBellSound();
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

      // Apply structured state from batch (e.g. on page refresh or replay).
      let sessions = state.sessions;
      const statusEvt = newEvents.findLast((e) => e.type === 'status:change');
      if (statusEvt) {
        const statusData = statusEvt.data as { to: string; seen?: boolean; stateChangeSeq?: number };
        const newStatus = statusData.to;
        sessions = sessions.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                status: newStatus,
                ...(statusData.seen !== undefined ? { seen: statusData.seen } : {}),
                ...(statusData.stateChangeSeq !== undefined
                  ? { stateChangeSeq: statusData.stateChangeSeq }
                  : {}),
              }
            : s,
        );
      }
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
      const endEvt = newEvents.findLast((e) => e.type === 'session:end');
      if (endEvt) {
        sessions = sessions.map((s) =>
          s.id === sessionId ? { ...s, endTime: endEvt.timestamp } : s,
        );
      }

      return { events: { ...state.events, [sessionId]: trimmed }, sessions };
  }),

  _setSeenLocal: (sessionId) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, seen: true } : session),
  })),

  updateSessionStatus: (sessionId, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, status } : s,
      ),
    })),

  setSessionAutoApprove: (sessionId, value) => {
    if (sessionSettingsSync) {
      sessionSettingsSync(sessionId, { autoApprove: value });
    } else {
      autoApproveSync?.(sessionId, value);
    }
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: value } : s,
      );
      saveSessionSettingsMap(sessions);
      return { sessions };
    });
  },

  setSessionAutoCompact: (sessionId, value) => {
    sessionSettingsSync?.(sessionId, { autoCompact: value });
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoCompact: value } : s,
      );
      saveSessionSettingsMap(sessions);
      return { sessions };
    });
  },

  setSessionRepeat: (sessionId, incoming) => {
    const patch: SessionSettingsPatch = {
      ...(incoming.enabled !== undefined ? { repeatEnabled: incoming.enabled } : {}),
      ...(incoming.command !== undefined ? { repeatCommand: incoming.command } : {}),
      ...(incoming.intervalSeconds !== undefined
        ? { repeatIntervalSeconds: clampRepeatIntervalSeconds(incoming.intervalSeconds) }
        : {}),
      ...(incoming.clear !== undefined ? { repeatClear: incoming.clear } : {}),
    };
    sessionSettingsSync?.(sessionId, patch);
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...patch } : s,
      );
      saveSessionSettingsMap(sessions);
      return { sessions };
    });
  },

  setSessionTags: (sessionId, tags) => {
    const normalized = normalizeTags(tags);
    sessionSettingsSync?.(sessionId, { tags: normalized });
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, tags: normalized } : s,
      );
      saveSessionSettingsMap(sessions);
      return { sessions };
    });
  },

  _setAutoApproveLocal: (sessionId, value) =>
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === sessionId ? { ...s, autoApprove: value } : s,
      );
      saveSessionSettingsMap(sessions);
      return { sessions };
    }),

  _applySessionSettingsLocal: (sessionId, patch) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          ...(patch.autoApprove !== undefined ? { autoApprove: patch.autoApprove } : {}),
          ...(patch.autoCompact !== undefined ? { autoCompact: patch.autoCompact } : {}),
          ...(patch.repeatEnabled !== undefined ? { repeatEnabled: patch.repeatEnabled } : {}),
          ...(patch.repeatCommand !== undefined ? { repeatCommand: patch.repeatCommand } : {}),
          ...(patch.repeatIntervalSeconds !== undefined ? { repeatIntervalSeconds: patch.repeatIntervalSeconds } : {}),
          ...(patch.repeatClear !== undefined ? { repeatClear: patch.repeatClear } : {}),
          ...(patch.nextRepeatAt !== undefined ? { nextRepeatAt: patch.nextRepeatAt } : {}),
          ...(patch.nextAutoCompactAt !== undefined ? { nextAutoCompactAt: patch.nextAutoCompactAt } : {}),
          ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
        };
      });
      saveSessionSettingsMap(sessions);
      return { sessions };
    }),

  setServerSessions: (serverUrl, incoming) =>
    set((state) => {
      const saved = loadSessionSettingsMap();
      const tagged = incoming.map((s) => applySavedSettings({ ...s, serverUrl }, saved));
      // Keep sessions from other servers, replace sessions from this server
      const others = state.sessions.filter((s) => s.serverUrl !== serverUrl);
      const sessions = [...others, ...tagged];
      const archived = new Set(state.archivedSessionIds);
      const activeSessionId = activeSessionIdFor(sessions, state.activeSessionId, archived);
      return { sessions, activeSessionId };
    }),

  removeServerSessions: (serverUrl) =>
    set((state) => {
      const removed = state.sessions.filter((s) => s.serverUrl === serverUrl);
      const sessions = state.sessions.filter((s) => s.serverUrl !== serverUrl);
      const events = { ...state.events };
      for (const s of removed) delete events[s.id];
      const removedIds = new Set(removed.map((s) => s.id));
      const archivedSessionIds = state.archivedSessionIds.filter((id) => !removedIds.has(id));
      if (archivedSessionIds.length !== state.archivedSessionIds.length) {
        saveArchivedSessionIds(archivedSessionIds);
      }
      const archived = new Set(archivedSessionIds);
      const activeSessionId =
        removed.some((s) => s.id === state.activeSessionId)
          ? firstUnarchivedSessionId(sessions, archived)
          : state.activeSessionId;
      return { sessions, events, activeSessionId, archivedSessionIds };
    }),
}));
