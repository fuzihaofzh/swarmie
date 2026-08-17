import { compileManifest, type CompiledManifest, type CompiledMatcherGroup } from './manifest.js';
import { BUILTIN_AGENT_MANIFESTS } from './manifests/index.js';
import { genericApprovalManifest } from './manifests/generic-approval.js';
import { selectDetectionRegion } from './regions.js';
import type {
  AgentDetectionResult,
  AgentStateManifest,
  DetectionInput,
  RuleEvaluation,
} from './types.js';

function matchesGroup(group: CompiledMatcherGroup, text: string, lower = text.toLocaleLowerCase()): boolean {
  if (!group.contains.every((needle) => lower.includes(needle))) return false;
  if (!group.regex.every((pattern) => pattern.test(text))) return false;

  if (group.lineRegex.length > 0) {
    const lines = text.split('\n');
    if (!group.lineRegex.every((pattern) => lines.some((line) => pattern.test(line)))) return false;
  }

  if (!group.all.every((child) => matchesGroup(child, text, lower))) return false;
  if (group.any.length > 0 && !group.any.some((child) => matchesGroup(child, text, lower))) return false;
  if (group.not.some((child) => matchesGroup(child, text, lower))) return false;
  return true;
}

function safePreview(text: string): string {
  const normalized = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  return normalized.length <= 240 ? normalized : `…${normalized.slice(-239)}`;
}

export interface RawDetection {
  result: AgentDetectionResult;
  evaluatedRules: RuleEvaluation[];
}

export class AgentStateDetector {
  private readonly manifestsByAgent = new Map<string, CompiledManifest>();
  private readonly fallbackManifest: CompiledManifest;

  constructor(
    manifests: AgentStateManifest[] = BUILTIN_AGENT_MANIFESTS,
    fallbackManifest: AgentStateManifest = genericApprovalManifest,
  ) {
    this.fallbackManifest = compileManifest(fallbackManifest);
    for (const definition of manifests) {
      const manifest = compileManifest(definition);
      for (const name of [definition.id, ...(definition.aliases ?? [])]) {
        const key = name.toLocaleLowerCase();
        if (this.manifestsByAgent.has(key)) throw new Error(`duplicate agent manifest alias: ${name}`);
        this.manifestsByAgent.set(key, manifest);
      }
    }
  }

  detect(agent: string, input: DetectionInput, options?: { includeText?: boolean; now?: number }): RawDetection {
    const observedAt = options?.now ?? Date.now();
    // Shell, SSH, and tmux sessions may attach to an already-running agent and
    // never expose its startup banner. In that case, evaluate only the narrow
    // tool-independent approval rules; do not infer the agent identity from a
    // mutable tmux title or arbitrary terminal text.
    const manifest = this.manifestsByAgent.get(agent.toLocaleLowerCase()) ?? this.fallbackManifest;

    let winner: typeof manifest.rules[number] | undefined;
    const evaluatedRules: RuleEvaluation[] = [];
    const regions = new Map<string, string>();
    for (const rule of manifest.rules) {
      const regionKey = JSON.stringify(rule.definition.region);
      let text = regions.get(regionKey);
      if (text === undefined) {
        text = selectDetectionRegion(input, rule.definition.region);
        regions.set(regionKey, text);
      }
      const matched = matchesGroup(rule, text);
      evaluatedRules.push({
        id: rule.definition.id,
        priority: rule.definition.priority,
        region: rule.definition.region,
        matched,
        regionBytes: Buffer.byteLength(text, 'utf8'),
        ...(options?.includeText ? { regionPreview: safePreview(text) } : {}),
      });
      if (matched && (!winner || rule.definition.priority > winner.definition.priority)) {
        winner = rule;
      }
    }

    if (!winner) {
      return {
        result: {
          agent,
          state: 'unknown',
          source: 'screen',
          observedAt,
          manifestId: manifest.definition.id,
          manifestVersion: manifest.definition.version,
          visibleIdle: false,
          visibleWorking: false,
          visibleBlocker: false,
          skipStateUpdate: false,
          automationSafe: false,
          reason: 'no_rule_matched',
        },
        evaluatedRules,
      };
    }

    const rule = winner.definition;
    return {
      result: {
        agent,
        state: rule.state,
        source: 'screen',
        observedAt,
        manifestId: manifest.definition.id,
        manifestVersion: manifest.definition.version,
        matchedRuleId: rule.id,
        matchedPriority: rule.priority,
        matchedRegion: rule.region,
        visibleIdle: rule.visibleIdle ?? false,
        visibleWorking: rule.visibleWorking ?? false,
        visibleBlocker: rule.visibleBlocker ?? false,
        skipStateUpdate: rule.skipStateUpdate ?? false,
        automationSafe: rule.automationSafe ?? false,
        reason: 'rule_matched',
      },
      evaluatedRules,
    };
  }
}

export const defaultAgentStateDetector = new AgentStateDetector();
