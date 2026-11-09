import type { AgentStateManifest } from '../types.js';

// OMP 18.x utils/title-generator.ts: π > idle, π ! attention,
// π <spinner> working, π : working without animation, π: state disabled.
// Include all four configurable spinner styles (braille, pulse, dots, line).
const WORKING_SEPARATOR = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏○◔◑◕●⠁⠂⠄⠠⠐⠈:|/\\\\-]';
export const OMP_TITLE_PATTERN = new RegExp(`^π (?:[>!]|${WORKING_SEPARATOR})(?: |$)`);

export const ompManifest: AgentStateManifest = {
  id: 'omp',
  version: 1,
  rules: [
    {
      id: 'title-attention',
      state: 'blocked',
      priority: 1200,
      region: { kind: 'osc_title' },
      regex: ['^π !(?: |$)'],
      visibleBlocker: true,
      // Attention includes free-form questions; Enter is not a safe approval.
    },
    {
      id: 'title-working',
      state: 'working',
      priority: 1100,
      region: { kind: 'osc_title' },
      regex: [`^π ${WORKING_SEPARATOR}(?: |$)`],
      visibleWorking: true,
    },
    {
      id: 'title-ready',
      state: 'idle',
      priority: 1000,
      region: { kind: 'osc_title' },
      regex: ['^π >(?: |$)'],
      visibleIdle: true,
    },
    {
      id: 'working-row',
      state: 'working',
      priority: 700,
      region: { kind: 'bottom_non_empty_lines', count: 8 },
      lineRegex: ['^\\s*(?:esc|⎋)\\s+(?:working|thinking|compacting)(?:…|\\.\\.\\.)'],
      visibleWorking: true,
    },
  ],
};
