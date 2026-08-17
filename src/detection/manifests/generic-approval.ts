import type { AgentStateManifest } from '../types.js';

/**
 * High-confidence approval UI shared by agent CLIs.
 *
 * A session can reach an agent through an existing shell, SSH connection, or
 * tmux attach, so its adapter may never see the agent's startup banner. These
 * rules intentionally use only the live approval card's structure and are the
 * fallback for sessions whose agent identity is unknown.
 */
export const genericApprovalManifest: AgentStateManifest = {
  id: 'generic-approval',
  version: 1,
  rules: [
    {
      id: 'selected-approval',
      state: 'blocked',
      priority: 1200,
      region: { kind: 'numbered_prompt_card' },
      lineRegex: ['^\\s*(?:[│┃]\\s*)?[›❯>]\\s*1\\.\\s*(?:yes|allow|approve|proceed)\\b'],
      all: [
        { any: [
          { contains: ['do you want to proceed?'] },
          { contains: ['allow command?'] },
          { contains: ['do you want to make this edit to'] },
        ] },
        { any: [
          { regex: ['esc.{0,40}(?:to\\s+)?cancel'] },
          { regex: ['press.{0,20}enter.{0,30}(?:confirm|continue|select)'] },
        ] },
      ],
      visibleBlocker: true,
      automationSafe: true,
    },
    {
      id: 'numbered-approval',
      state: 'blocked',
      priority: 900,
      region: { kind: 'numbered_prompt_card' },
      all: [
        { any: [
          { contains: ['do you want to proceed?'] },
          { contains: ['allow command?'] },
          { contains: ['do you want to make this edit to'] },
        ] },
        { any: [
          { regex: ['esc.{0,40}(?:to\\s+)?cancel'] },
          { regex: ['press.{0,20}enter.{0,30}(?:confirm|continue|select)'] },
        ] },
        { regex: ['\\d+\\.\\s+(?:yes|no|allow|approve|proceed)\\b'] },
      ],
      visibleBlocker: true,
    },
  ],
};
