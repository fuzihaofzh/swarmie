export { AgentStateDetector, defaultAgentStateDetector } from './engine.js';
export { DetectionStabilizer } from './stabilizer.js';
export { chooseStateSignal } from './arbiter.js';
export { compileManifest } from './manifest.js';
export { selectDetectionRegion } from './regions.js';
export type {
  AgentDetectionResult,
  AgentLifecycleState,
  AgentStateManifest,
  AgentStateRule,
  AgentStateSource,
  DetectionExplanation,
  DetectionInput,
  DetectionMode,
  DetectionRegion,
  MatcherGroup,
  RuleEvaluation,
  StateSignal,
} from './types.js';
