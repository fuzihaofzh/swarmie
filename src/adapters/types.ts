export type NormalizedEventType =
  | 'session:start'
  | 'session:end'
  | 'assistant:message'
  | 'assistant:message:delta'
  | 'tool:use'
  | 'tool:result'
  | 'tool:detect'
  | 'agent:state'
  | 'automation:action'
  | 'cwd:change'
  | 'user:input'
  | 'error'
  | 'raw:output'
  | 'status:change'
  | 'metadata';

export type SessionStatus = 'starting' | 'running' | 'thinking' | 'tool_executing' | 'waiting_input' | 'idle' | 'done' | 'completed' | 'error';

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
  | ToolDetectData
  | AgentStateData
  | AutomationActionData
  | CwdChangeData
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
  /**
   * Server-attached absolute byte offset where this chunk ends in the
   * session's lifetime raw stream. Lets clients identify gaps and request
   * older history without de-duping by content.
   */
  offsetEnd?: number;
}

export interface StatusChangeData {
  from: SessionStatus;
  to: SessionStatus;
  /** Monotonic sequence for user-visible lifecycle transitions. */
  stateChangeSeq?: number;
  seen?: boolean;
}

export interface ToolDetectData {
  tool: string;
  displayName: string;
}

export interface AgentStateData {
  agent: string;
  state: 'unknown' | 'idle' | 'working' | 'blocked';
  source: 'screen' | 'structured' | 'hook' | 'process' | 'activity';
  ruleId?: string;
  manifestVersion?: number;
  visibleIdle?: boolean;
  visibleWorking?: boolean;
  visibleBlocker?: boolean;
  automationSafe?: boolean;
}

export interface AutomationActionData {
  action: 'press_enter';
  policy: 'verified_prompt';
  ruleId: string;
  key: 'cr' | 'lf';
  attempt: number;
}

export interface CwdChangeData {
  cwd: string;
  hostname?: string;
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
