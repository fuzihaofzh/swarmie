import { create } from 'zustand';

export interface ServerEntry {
  url: string;
  label: string;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** The local server is represented by this sentinel URL */
export const LOCAL_SERVER = '';

interface ServerState {
  /** Remote servers only — local is always implicit */
  servers: ServerEntry[];
  connectionStatus: Record<string, ConnectionStatus>;
  addServer: (url: string, label?: string) => void;
  removeServer: (url: string) => void;
  setConnectionStatus: (url: string, status: ConnectionStatus) => void;
}

const STORAGE_KEY = 'swarmie-servers';

function loadServers(): ServerEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveServers(servers: ServerEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

export const useServerStore = create<ServerState>((set) => ({
  servers: loadServers(),
  connectionStatus: {},

  addServer: (url, label) =>
    set((state) => {
      // Normalize: strip trailing slash
      const normalized = url.replace(/\/+$/, '');
      if (!normalized || state.servers.some((s) => s.url === normalized)) return state;
      const servers = [...state.servers, { url: normalized, label: label || normalized }];
      saveServers(servers);
      return { servers };
    }),

  removeServer: (url) =>
    set((state) => {
      const servers = state.servers.filter((s) => s.url !== url);
      saveServers(servers);
      const connectionStatus = { ...state.connectionStatus };
      delete connectionStatus[url];
      return { servers, connectionStatus };
    }),

  setConnectionStatus: (url, status) =>
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [url]: status },
    })),
}));
