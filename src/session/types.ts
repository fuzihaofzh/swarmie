import type { SessionStatus, AdapterInfo, NormalizedEvent } from '../adapters/types.js';

export interface SessionInfo {
  id: string;
  name: string;
  tool: string;
  adapterInfo: AdapterInfo;
  status: SessionStatus;
  /** Whether the latest attention-worthy transition has been viewed. */
  seen: boolean;
  /** Monotonic user-visible lifecycle sequence. */
  stateChangeSeq: number;
  startTime: number;
  endTime?: number;
  cwd: string;
  /** Folder that established this session's workspace; remains stable if the shell later cd's. */
  workspaceCwd?: string;
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
  seen: boolean;
  stateChangeSeq: number;
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
}
