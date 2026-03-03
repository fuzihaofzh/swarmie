import { create } from 'zustand';

export type Tab = 'terminal' | 'structured' | 'events';

interface UIState {
  drawerOpen: boolean;
  theme: string;
  fontSize: number;
  fontFamily: string;
  activeTab: Tab;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setTheme: (theme: string) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setActiveTab: (tab: Tab) => void;
}

const savedTheme = localStorage.getItem('polycode-theme') || 'solarized-light';
const savedFontSize = parseInt(localStorage.getItem('polycode-font-size') || '13', 10);
const savedFontFamily = localStorage.getItem('polycode-font-family') || "'SF Mono', Monaco, Menlo, monospace";

export const useUIStore = create<UIState>((set) => ({
  drawerOpen: false,
  theme: savedTheme,
  fontSize: savedFontSize,
  fontFamily: savedFontFamily,
  activeTab: 'terminal',

  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),

  setTheme: (theme) => {
    localStorage.setItem('polycode-theme', theme);
    set({ theme });
  },
  setFontSize: (fontSize) => {
    localStorage.setItem('polycode-font-size', String(fontSize));
    set({ fontSize });
  },
  setFontFamily: (fontFamily) => {
    localStorage.setItem('polycode-font-family', fontFamily);
    set({ fontFamily });
  },
  setActiveTab: (activeTab) => set({ activeTab }),
}));
