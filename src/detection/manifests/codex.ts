import type { AgentStateManifest } from '../types.js';

const BUSY_SPINNER = '(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)';

export const codexManifest: AgentStateManifest = {
  id: 'codex',
  version: 4,
  rules: [
    {
      id: 'selected-approval',
      state: 'blocked',
      priority: 1200,
      region: { kind: 'numbered_prompt_card' },
      lineRegex: ['^\\s*(?:[│┃]\\s*)?[›❯>]\\s*1\\.\\s*(?:yes|allow|approve|proceed)\\b'],
      all: [{ any: [
        { regex: ['esc.{0,40}cancel'] },
        { regex: ['enter.{0,40}(?:confirm|submit)'] },
      ] }],
      visibleBlocker: true,
      automationSafe: true,
    },
    {
      id: 'title-action-required',
      state: 'blocked',
      priority: 1100,
      region: { kind: 'osc_title' },
      contains: ['action required'],
      visibleBlocker: true,
    },
    {
      id: 'title-busy-spinner',
      state: 'working',
      priority: 1050,
      region: { kind: 'osc_title' },
      regex: [BUSY_SPINNER],
      visibleWorking: true,
    },
    {
      id: 'history-viewer',
      state: 'unknown',
      priority: 1000,
      region: { kind: 'after_last_prompt_marker' },
      contains: ['pgup/pgdn to', 'home/end to jump', 'q to quit'],
      all: [{ any: [
        { contains: ['↑/↓ to scroll'] },
        { contains: ['up/down to scroll'] },
      ] }],
      skipStateUpdate: true,
    },
    {
      id: 'directory-trust-question',
      state: 'blocked',
      priority: 980,
      region: { kind: 'top_non_empty_lines', count: 20 },
      all: [
        { lineRegex: ['^\\s*>\\s+you are in\\s+\\S'] },
        { regex: ['do\\s+you\\s+trust\\s+the\\s+contents\\s+of\\s+this\\s+directory\\?'] },
      ],
      visibleBlocker: true,
    },
    {
      id: 'current-confirmation-controls',
      state: 'blocked',
      priority: 920,
      region: { kind: 'after_last_prompt_marker' },
      any: [
        { contains: ['press enter to confirm or esc to cancel'] },
        { contains: ['enter to submit answer'] },
        { contains: ['enter to submit all'] },
        { contains: ['allow command?'] },
      ],
      visibleBlocker: true,
    },
    {
      id: 'numbered-confirmation-menu',
      state: 'blocked',
      priority: 900,
      region: { kind: 'bottom_lines', count: 18 },
      any: [
        {
          all: [
            { regex: ['\\d+\\.\\s+(?:yes|no)\\b'] },
            { regex: ['(?:esc.{0,40}cancel|enter.{0,40}confirm)'] },
          ],
        },
        { lineRegex: ['\\((?:y/n|yes/no)\\)\\s*$'] },
      ],
      visibleBlocker: true,
    },
    {
      id: 'visible-work-status',
      state: 'working',
      priority: 700,
      region: { kind: 'bottom_non_empty_lines', count: 5 },
      any: [
        { lineRegex: ['^[•◦]\\s+working\\s+\\([^)]*esc to interrupt\\)(?:\\s*[·•].*)?$'] },
        { regex: ['esc.{0,24}to.{0,24}interrupt'] },
        { regex: ['(?:streaming response|running (?:tool|command))'] },
      ],
      not: [{ contains: ['conversation interrupted'] }],
      visibleWorking: true,
    },
    {
      id: 'title-working',
      state: 'working',
      priority: 650,
      region: { kind: 'osc_title' },
      any: [
        { contains: ['working'] },
        { contains: ['running'] },
        { contains: ['thinking'] },
      ],
      visibleWorking: true,
    },
    {
      id: 'ready-input-line',
      state: 'idle',
      priority: 500,
      region: { kind: 'bottom_non_empty_lines', count: 5 },
      lineRegex: ['^\\s*›(?:\\s|$)(?!\\s*\\d+\\.)'],
      not: [
        { regex: ['esc.{0,24}to.{0,24}(?:interrupt|cancel)'] },
        { regex: ['\\d+\\.\\s+(?:yes|no)\\b'] },
      ],
      visibleIdle: true,
    },
    {
      id: 'plain-title-ready',
      state: 'idle',
      priority: 100,
      region: { kind: 'osc_title' },
      regex: ['\\S'],
      not: [
        { regex: [BUSY_SPINNER] },
        { contains: ['action required'] },
      ],
      visibleIdle: true,
    },
  ],
};
