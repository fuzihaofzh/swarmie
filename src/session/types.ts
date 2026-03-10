import type { SessionStatus, AdapterInfo, NormalizedEvent } from '../adapters/types.js';

export interface SessionInfo {
  id: string;
  name: string;
  tool: string;
  adapterInfo: AdapterInfo;
  status: SessionStatus;
  startTime: number;
  endTime?: number;
  cwd: string;
  command: string[];
  /** Recent events kept in memory for late-joining clients */
  recentEvents: NormalizedEvent[];
  metadata: {
    model?: string;
    costUsd?: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface SessionSummary {
  id: string;
  name: string;
  tool: string;
  status: SessionStatus;
  startTime: number;
  endTime?: number;
  displayName: string;
  icon: string;
  cwd: string;
  hostname: string;
  initialHostname: string;
}
