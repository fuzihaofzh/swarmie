export type AgentLifecycleState = 'unknown' | 'idle' | 'working' | 'blocked';

export type AgentStateSource = 'process' | 'structured' | 'hook' | 'screen' | 'activity';

export type DetectionMode = 'legacy' | 'shadow' | 'active';

export type DetectionRegion =
  | { kind: 'whole_recent' }
  | { kind: 'viewport' }
  | { kind: 'bottom_lines'; count: number }
  | { kind: 'bottom_non_empty_lines'; count: number }
  | { kind: 'top_non_empty_lines'; count: number }
  | { kind: 'after_last_horizontal_rule' }
  | { kind: 'after_last_prompt_marker' }
  | { kind: 'prompt_box_body' }
  | { kind: 'numbered_prompt_card' }
  | { kind: 'osc_title' }
  | { kind: 'osc_progress' };

export interface MatcherGroup {
  /** Case-insensitive literal substrings. Every entry must match. */
  contains?: string[];
  /** Regular expressions evaluated against the complete selected region. */
  regex?: string[];
  /** Regular expressions for which at least one line must match. */
  lineRegex?: string[];
  /** Every nested group must match. */
  all?: MatcherGroup[];
  /** At least one nested group must match. */
  any?: MatcherGroup[];
  /** No nested group may match. */
  not?: MatcherGroup[];
}

export interface AgentStateRule extends MatcherGroup {
  id: string;
  state: AgentLifecycleState;
  priority: number;
  region: DetectionRegion;
  visibleIdle?: boolean;
  visibleWorking?: boolean;
  visibleBlocker?: boolean;
  /** Preserve the last stable state while a modal/viewer temporarily replaces the live UI. */
  skipStateUpdate?: boolean;
  /** This rule proves that pressing Enter accepts the currently selected safe default. */
  automationSafe?: boolean;
}

export interface AgentStateManifest {
  id: string;
  version: number;
  aliases?: string[];
  rules: AgentStateRule[];
}

export interface DetectionInput {
  viewport: string;
  recent: string;
  oscTitle?: string;
  oscProgress?: string;
}

export interface RuleEvaluation {
  id: string;
  priority: number;
  region: DetectionRegion;
  matched: boolean;
  regionBytes: number;
  regionPreview?: string;
}

export interface AgentDetectionResult {
  agent: string;
  state: AgentLifecycleState;
  source: 'screen';
  observedAt: number;
  manifestId?: string;
  manifestVersion?: number;
  matchedRuleId?: string;
  matchedPriority?: number;
  matchedRegion?: DetectionRegion;
  visibleIdle: boolean;
  visibleWorking: boolean;
  visibleBlocker: boolean;
  skipStateUpdate: boolean;
  automationSafe: boolean;
  reason: string;
}

export interface DetectionExplanation extends AgentDetectionResult {
  mode: DetectionMode;
  evaluatedRules: RuleEvaluation[];
  rawState: AgentLifecycleState;
  /** Final source selected after combining screen evidence with fallback signals. */
  resolvedSource?: AgentStateSource;
  stabilization: 'accepted' | 'held' | 'skipped';
  stabilizationReason?: string;
  legacyState?: AgentLifecycleState;
  agreesWithLegacy?: boolean;
}

export interface StateSignal {
  state: AgentLifecycleState;
  source: AgentStateSource;
  observedAt: number;
  authoritative?: boolean;
  visibleBlocker?: boolean;
}
