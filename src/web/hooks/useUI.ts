import { create } from 'zustand';

interface UIState {
  drawerOpen: boolean;
  theme: string;
  fontSize: number;
  fontFamily: string;
  bellSound: boolean;
  showNewSession: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setTheme: (theme: string) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setBellSound: (enabled: boolean) => void;
  setShowNewSession: (show: boolean) => void;
}

const savedTheme = localStorage.getItem('swarmie-theme') || 'solarized-light';
const savedFontSize = parseInt(localStorage.getItem('swarmie-font-size') || '20', 10);
const savedFontFamily = localStorage.getItem('swarmie-font-family') || "'SF Mono', Monaco, Menlo, monospace";
const savedBellSound = localStorage.getItem('swarmie-bell-sound') !== 'false'; // default on

export const useUIStore = create<UIState>((set) => ({
  drawerOpen: false,
  theme: savedTheme,
  fontSize: savedFontSize,
  fontFamily: savedFontFamily,
  bellSound: savedBellSound,
  showNewSession: false,

  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),

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
}));
