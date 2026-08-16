import { create } from 'zustand';

interface UIState {
  theme: string;
  fontSize: number;
  fontFamily: string;
  bellSound: boolean;
  mathRender: boolean;
  keepAltScreenInScrollback: boolean;
  showNewSession: boolean;
  settingsOpen: boolean;
  agentOverlayMode: 'overview' | 'switcher' | null;
  autoCompactMinutes: number;
  tileLayoutEnabled: boolean;
  tileColumns: number;
  tileHeight: number;
  tagFilter: string[];
  workspacePanelOpen: boolean;
  workspacePanelWidth: number;
  openSettings: () => void;
  closeSettings: () => void;
  openAgentOverview: () => void;
  openAgentSwitcher: () => void;
  closeAgentOverlay: () => void;
  setTheme: (theme: string) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setBellSound: (enabled: boolean) => void;
  setMathRender: (enabled: boolean) => void;
  setKeepAltScreenInScrollback: (enabled: boolean) => void;
  setShowNewSession: (show: boolean) => void;
  setAutoCompactMinutes: (minutes: number) => void;
  _setAutoCompactMinutesLocal: (minutes: number) => void;
  setTileLayoutEnabled: (enabled: boolean) => void;
  setTileColumns: (columns: number) => void;
  setTileHeight: (height: number) => void;
  toggleTagFilter: (tag: string) => void;
  clearTagFilter: () => void;
  setTagFilter: (tags: string[]) => void;
  toggleWorkspacePanel: () => void;
  setWorkspacePanelWidth: (width: number) => void;
}

const savedTheme = localStorage.getItem('swarmie-theme') || 'solarized-light';
const savedFontSize = parseInt(localStorage.getItem('swarmie-font-size') || '20', 10);
const savedFontFamily = localStorage.getItem('swarmie-font-family') || "'SF Mono', Monaco, Menlo, monospace";
const savedBellSound = localStorage.getItem('swarmie-bell-sound') !== 'false'; // default on
const savedMathRender = localStorage.getItem('swarmie-math-render') === 'true'; // default off
// Keep full-screen apps' (tmux/vim/less) output in scrollback by stripping the
// alternate-screen switch, so the wheel scrolls back through history like iTerm.
const savedKeepAltScreenInScrollback =
  localStorage.getItem('swarmie-keep-alt-scrollback') !== 'false'; // default on
const savedAutoCompactMinutes = parseInt(localStorage.getItem('swarmie-auto-compact-minutes') || '60', 10);
const savedTileLayoutEnabled = localStorage.getItem('swarmie-tile-layout-enabled') === 'true';
const savedTileColumns = parseInt(localStorage.getItem('swarmie-tile-columns') || '2', 10);
const savedTileHeightRaw = localStorage.getItem('swarmie-tile-height');
const parsedTileHeight = parseInt(savedTileHeightRaw || '300', 10);
// 360px was the old default and makes 3-column layouts unnecessarily tall;
// 300px keeps the panes compact while leaving enough room for agent output.
// Migrate the previous compact default while preserving other custom values.
const savedTileHeight = parsedTileHeight === 360 || parsedTileHeight === 260 ? 300 : parsedTileHeight;
const savedWorkspacePanelOpen = localStorage.getItem('swarmie-workspace-panel') !== 'false';
const savedWorkspacePanelWidth = parseInt(localStorage.getItem('swarmie-workspace-panel-width') || '286', 10);

function loadTagFilter(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem('swarmie-tag-filter') || '[]');
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

let autoCompactMinutesSync: ((minutes: number) => void) | null = null;
export function registerAutoCompactMinutesSync(fn: ((minutes: number) => void) | null) {
  autoCompactMinutesSync = fn;
}

function clampAutoCompactMinutes(minutes: number): number {
  return Math.min(24 * 60, Math.max(1, Math.floor(minutes)));
}

function clampTileColumns(columns: number): number {
  const value = Number(columns);
  if (!Number.isFinite(value)) return 2;
  return Math.min(6, Math.max(1, Math.floor(value)));
}

function clampTileHeight(height: number): number {
  const value = Number(height);
  if (!Number.isFinite(value)) return 300;
  return Math.min(1200, Math.max(180, Math.floor(value)));
}

function clampWorkspacePanelWidth(width: number): number {
  const value = Number(width);
  if (!Number.isFinite(value)) return 286;
  return Math.min(480, Math.max(220, Math.floor(value)));
}

export const useUIStore = create<UIState>((set) => ({
  theme: savedTheme,
  fontSize: savedFontSize,
  fontFamily: savedFontFamily,
  bellSound: savedBellSound,
  mathRender: savedMathRender,
  keepAltScreenInScrollback: savedKeepAltScreenInScrollback,
  showNewSession: false,
  settingsOpen: false,
  agentOverlayMode: null,
  autoCompactMinutes: Number.isFinite(savedAutoCompactMinutes)
    ? clampAutoCompactMinutes(savedAutoCompactMinutes)
    : 60,
  tileLayoutEnabled: savedTileLayoutEnabled,
  tileColumns: Number.isFinite(savedTileColumns) ? clampTileColumns(savedTileColumns) : 2,
  tileHeight: Number.isFinite(savedTileHeight) ? clampTileHeight(savedTileHeight) : 300,
  tagFilter: loadTagFilter(),
  workspacePanelOpen: savedWorkspacePanelOpen,
  workspacePanelWidth: Number.isFinite(savedWorkspacePanelWidth)
    ? clampWorkspacePanelWidth(savedWorkspacePanelWidth)
    : 286,

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openAgentOverview: () => set({ agentOverlayMode: 'overview' }),
  openAgentSwitcher: () => set({ agentOverlayMode: 'switcher' }),
  closeAgentOverlay: () => set({ agentOverlayMode: null }),

  setTheme: (theme) => {
    localStorage.setItem('swarmie-theme', theme);
    set({ theme });
  },
  setFontSize: (fontSize) => {
    localStorage.setItem('swarmie-font-size', String(fontSize));
    set({ fontSize });
  },
  setFontFamily: (fontFamily) => {
    localStorage.setItem('swarmie-font-family', fontFamily);
    set({ fontFamily });
  },
  setBellSound: (bellSound) => {
    localStorage.setItem('swarmie-bell-sound', String(bellSound));
    set({ bellSound });
  },
  setMathRender: (mathRender) => {
    localStorage.setItem('swarmie-math-render', String(mathRender));
    set({ mathRender });
  },
  setKeepAltScreenInScrollback: (keepAltScreenInScrollback) => {
    localStorage.setItem('swarmie-keep-alt-scrollback', String(keepAltScreenInScrollback));
    set({ keepAltScreenInScrollback });
  },
  setShowNewSession: (showNewSession) => set({ showNewSession }),
  setAutoCompactMinutes: (minutes) => {
    const value = clampAutoCompactMinutes(minutes);
    localStorage.setItem('swarmie-auto-compact-minutes', String(value));
    autoCompactMinutesSync?.(value);
    set({ autoCompactMinutes: value });
  },
  _setAutoCompactMinutesLocal: (minutes) => {
    const value = clampAutoCompactMinutes(minutes);
    localStorage.setItem('swarmie-auto-compact-minutes', String(value));
    set({ autoCompactMinutes: value });
  },
  setTileLayoutEnabled: (tileLayoutEnabled) => {
    localStorage.setItem('swarmie-tile-layout-enabled', String(tileLayoutEnabled));
    set({ tileLayoutEnabled });
  },
  setTileColumns: (columns) => {
    const value = clampTileColumns(columns);
    localStorage.setItem('swarmie-tile-columns', String(value));
    set({ tileColumns: value });
  },
  setTileHeight: (height) => {
    const value = clampTileHeight(height);
    localStorage.setItem('swarmie-tile-height', String(value));
    set({ tileHeight: value });
  },
  toggleTagFilter: (tag) =>
    set((state) => {
      const normalized = tag.trim();
      if (!normalized) return state;
      const exists = state.tagFilter.includes(normalized);
      const tagFilter = exists
        ? state.tagFilter.filter((t) => t !== normalized)
        : [...state.tagFilter, normalized];
      localStorage.setItem('swarmie-tag-filter', JSON.stringify(tagFilter));
      return { tagFilter };
    }),
  clearTagFilter: () => {
    localStorage.setItem('swarmie-tag-filter', JSON.stringify([]));
    set({ tagFilter: [] });
  },
  setTagFilter: (tags) => {
    const normalized = Array.from(
      new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)),
    );
    localStorage.setItem('swarmie-tag-filter', JSON.stringify(normalized));
    set({ tagFilter: normalized });
  },
  toggleWorkspacePanel: () => set((state) => {
    const workspacePanelOpen = !state.workspacePanelOpen;
    localStorage.setItem('swarmie-workspace-panel', String(workspacePanelOpen));
    return { workspacePanelOpen };
  }),
  setWorkspacePanelWidth: (width) => {
    const value = clampWorkspacePanelWidth(width);
    localStorage.setItem('swarmie-workspace-panel-width', String(value));
    set({ workspacePanelWidth: value });
  },
}));
