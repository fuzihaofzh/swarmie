import type { AgentStateManifest } from '../types.js';
import { claudeManifest } from './claude.js';
import { codexManifest } from './codex.js';
import { geminiManifest } from './gemini.js';
import { ompManifest } from './omp.js';

export const BUILTIN_AGENT_MANIFESTS: AgentStateManifest[] = [
  claudeManifest,
  codexManifest,
  geminiManifest,
  ompManifest,
];

