import { create } from 'zustand';

interface UIState {
  drawerOpen: boolean;
  theme: string;
  fontSize: number;
  fontFamily: string;
  bellSound: boolean;
  showNewSession: boolean;
  settingsOpen: boolean;
  autoCompactMinutes: number;
  tagFilter: string[];
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  setTheme: (theme: string) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setBellSound: (enabled: boolean) => void;
  setShowNewSession: (show: boolean) => void;
  setAutoCompactMinutes: (minutes: number) => void;
  _setAutoCompactMinutesLocal: (minutes: number) => void;
  toggleTagFilter: (tag: string) => void;
  clearTagFilter: () => void;
  setTagFilter: (tags: string[]) => void;
}

const savedTheme = localStorage.getItem('swarmie-theme') || 'solarized-light';
const savedFontSize = parseInt(localStorage.getItem('swarmie-font-size') || '20', 10);
const savedFontFamily = localStorage.getItem('swarmie-font-family') || "'SF Mono', Monaco, Menlo, monospace";
const savedBellSound = localStorage.getItem('swarmie-bell-sound') !== 'false'; // default on
const savedAutoCompactMinutes = parseInt(localStorage.getItem('swarmie-auto-compact-minutes') || '60', 10);

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

export const useUIStore = create<UIState>((set) => ({
  drawerOpen: false,
  theme: savedTheme,
  fontSize: savedFontSize,
  fontFamily: savedFontFamily,
  bellSound: savedBellSound,
  showNewSession: false,
  settingsOpen: false,
  autoCompactMinutes: Number.isFinite(savedAutoCompactMinutes)
    ? clampAutoCompactMinutes(savedAutoCompactMinutes)
    : 60,
  tagFilter: loadTagFilter(),

  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  openSettings: () => set({ settingsOpen: true, drawerOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),

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
}));
