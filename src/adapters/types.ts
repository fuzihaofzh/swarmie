export type NormalizedEventType =
  | 'session:start'
  | 'session:end'
  | 'assistant:message'
  | 'assistant:message:delta'
  | 'tool:use'
  | 'tool:result'
  | 'user:input'
  | 'error'
  | 'raw:output'
  | 'status:change'
  | 'metadata';

export type SessionStatus = 'starting' | 'running' | 'thinking' | 'tool_executing' | 'idle' | 'completed' | 'error';

export interface NormalizedEvent {
  type: NormalizedEventType;
  sessionId: string;
  timestamp: number;
  data: EventData;
}

export type EventData =
  | SessionStartData
  | SessionEndData
  | AssistantMessageData
  | AssistantMessageDeltaData
  | ToolUseData
  | ToolResultData
  | UserInputData
  | ErrorData
  | RawOutputData
  | StatusChangeData
  | MetadataData;

export interface SessionStartData {
  tool: string;
  command: string[];
  cwd: string;
}

export interface SessionEndData {
  exitCode: number | null;
  signal: string | null;
}

export interface AssistantMessageData {
  text: string;
  model?: string;
}

export interface AssistantMessageDeltaData {
  delta: string;
}

export interface ToolUseData {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultData {
  toolId: string;
  toolName: string;
  output: string;
  isError?: boolean;
}

export interface UserInputData {
  text: string;
}

export interface ErrorData {
  message: string;
  code?: string;
}

export interface RawOutputData {
  /** base64-encoded PTY output */
  data: string;
}

export interface StatusChangeData {
  from: SessionStatus;
  to: SessionStatus;
}

export interface MetadataData {
  model?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  [key: string]: unknown;
}

export interface AdapterInfo {
  name: string;
  displayName: string;
  icon: string;
  command: string;
  /** Whether this tool supports structured JSON output */
  supportsStructured: boolean;
}
