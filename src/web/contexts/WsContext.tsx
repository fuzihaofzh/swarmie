import { createContext, useContext } from 'react';
import type { ServerConnection } from '../hooks/useWebSocket';

export interface WsFunctions {
  sendInput: (sessionId: string, data: string) => void;
  sendResize: (sessionId: string, cols: number, rows: number) => void;
  sendRedraw: (sessionId: string) => void;
  createSession: (opts: {
    tool: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
    serverUrl?: string;
  }) => Promise<{ id: string; name: string; tool: string; status: string } | null>;
  killSession: (sessionId: string) => Promise<void>;
  getConnection: (serverUrl: string) => ServerConnection | undefined;
}

export const WsContext = createContext<WsFunctions | null>(null);

export function useWsContext(): WsFunctions {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error('useWsContext must be used inside WsProvider');
  return ctx;
}
