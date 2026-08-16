import type { AgentStateManifest, AgentStateRule, MatcherGroup } from './types.js';

const MAX_RULES = 128;
const MAX_DEPTH = 8;
const MAX_MATCHERS_PER_GROUP = 32;
const MAX_MATCHER_LENGTH = 512;

export interface CompiledMatcherGroup {
  contains: string[];
  regex: RegExp[];
  lineRegex: RegExp[];
  all: CompiledMatcherGroup[];
  any: CompiledMatcherGroup[];
  not: CompiledMatcherGroup[];
}

export interface CompiledRule extends CompiledMatcherGroup {
  definition: AgentStateRule;
  index: number;
}

export interface CompiledManifest {
  definition: AgentStateManifest;
  rules: CompiledRule[];
}

function directMatcherCount(group: MatcherGroup): number {
  return (group.contains?.length ?? 0) + (group.regex?.length ?? 0) + (group.lineRegex?.length ?? 0);
}

function hasPositiveMatcher(group: MatcherGroup): boolean {
  if (directMatcherCount(group) > 0) return true;
  return [...(group.all ?? []), ...(group.any ?? [])].some(hasPositiveMatcher);
}

function validateGroup(group: MatcherGroup, path: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`${path}: matcher nesting exceeds ${MAX_DEPTH}`);
  if (directMatcherCount(group) > MAX_MATCHERS_PER_GROUP) {
    throw new Error(`${path}: too many direct matchers`);
  }
  for (const value of [...(group.contains ?? []), ...(group.regex ?? []), ...(group.lineRegex ?? [])]) {
    if (!value || value.length > MAX_MATCHER_LENGTH) throw new Error(`${path}: invalid matcher length`);
  }
  if (!hasPositiveMatcher(group)) throw new Error(`${path}: a positive matcher is required`);
  for (const [key, children] of Object.entries({ all: group.all, any: group.any, not: group.not })) {
    children?.forEach((child, index) => validateGroup(child, `${path}.${key}[${index}]`, depth + 1));
  }
}

function compileRegex(pattern: string, path: string): RegExp {
  try {
    return new RegExp(pattern, 'imu');
  } catch (error) {
    throw new Error(`${path}: invalid regular expression: ${String(error)}`);
  }
}

function compileGroup(group: MatcherGroup, path: string): CompiledMatcherGroup {
  return {
    contains: (group.contains ?? []).map((value) => value.toLocaleLowerCase()),
    regex: (group.regex ?? []).map((value, index) => compileRegex(value, `${path}.regex[${index}]`)),
    lineRegex: (group.lineRegex ?? []).map((value, index) => compileRegex(value, `${path}.lineRegex[${index}]`)),
    all: (group.all ?? []).map((child, index) => compileGroup(child, `${path}.all[${index}]`)),
    any: (group.any ?? []).map((child, index) => compileGroup(child, `${path}.any[${index}]`)),
    not: (group.not ?? []).map((child, index) => compileGroup(child, `${path}.not[${index}]`)),
  };
}

export function compileManifest(manifest: AgentStateManifest): CompiledManifest {
  if (!manifest.id.trim()) throw new Error('manifest id is required');
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new Error(`${manifest.id}: invalid version`);
  if (manifest.rules.length === 0 || manifest.rules.length > MAX_RULES) {
    throw new Error(`${manifest.id}: rules must contain 1-${MAX_RULES} entries`);
  }

  const ids = new Set<string>();
  const rules = manifest.rules.map((rule, index): CompiledRule => {
    const path = `${manifest.id}.rules[${index}]`;
    if (!rule.id.trim() || ids.has(rule.id)) throw new Error(`${path}: missing or duplicate id`);
    ids.add(rule.id);
    if (!Number.isFinite(rule.priority)) throw new Error(`${path}: invalid priority`);
    if (rule.skipStateUpdate && rule.state !== 'unknown') {
      throw new Error(`${path}: skipped rules must use unknown state`);
    }
    if (rule.skipStateUpdate && (rule.visibleIdle || rule.visibleWorking || rule.visibleBlocker)) {
      throw new Error(`${path}: skipped rules cannot publish visible state evidence`);
    }
    if (rule.automationSafe && (rule.state !== 'blocked' || !rule.visibleBlocker || rule.skipStateUpdate)) {
      throw new Error(`${path}: automation-safe rules must be visible, non-skipped blockers`);
    }
    if (rule.region.kind === 'bottom_lines'
        || rule.region.kind === 'bottom_non_empty_lines'
        || rule.region.kind === 'top_non_empty_lines') {
      if (!Number.isInteger(rule.region.count) || rule.region.count < 1 || rule.region.count > 200) {
        throw new Error(`${path}: invalid region line count`);
      }
    }
    validateGroup(rule, path, 0);
    return { ...compileGroup(rule, path), definition: rule, index };
  });

  return { definition: manifest, rules };
}
