import { createContext, useContext } from 'react';
import type { CreatedSession, ServerConnection } from '../hooks/useWebSocket';

export interface WsFunctions {
  createSession: (opts: {
    tool?: string;
    args?: string[];
    cwd?: string;
    sessionName?: string;
    serverUrl?: string;
  }) => Promise<CreatedSession>;
  killSession: (sessionId: string) => Promise<void>;
  getConnection: (serverUrl: string) => ServerConnection | undefined;
}

export const WsContext = createContext<WsFunctions | null>(null);

export function useWsContext(): WsFunctions {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error('useWsContext must be used inside WsProvider');
  return ctx;
}
