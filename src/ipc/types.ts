import type { NormalizedEvent, AdapterInfo, SessionStatus } from '../adapters/types.js';

/** Messages from IPC client -> IPC server */
export type IPCClientMessage =
  | { type: 'register'; sessionId: string; name: string; tool: string; adapterInfo: AdapterInfo; cwd: string; command: string[] }
  | { type: 'event'; event: NormalizedEvent }
  | { type: 'unregister'; sessionId: string }
  | { type: 'ping' };

/** Messages from IPC server -> IPC client */
export type IPCServerMessage =
  | { type: 'registered'; sessionId: string }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string; signal?: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

export interface RemoteSessionInfo {
  id: string;
  name: string;
  tool: string;
  adapterInfo: AdapterInfo;
  status: SessionStatus;
  cwd: string;
  command: string[];
  startTime: number;
}
