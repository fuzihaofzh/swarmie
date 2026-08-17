import type { AgentStateManifest } from '../types.js';

export const geminiManifest: AgentStateManifest = {
  id: 'gemini',
  version: 3,
  aliases: ['gemini-cli'],
  rules: [
    {
      id: 'selected-approval',
      state: 'blocked',
      priority: 950,
      region: { kind: 'numbered_prompt_card' },
      lineRegex: ['^\\s*(?:[│┃]\\s*)?[›❯>]\\s*1\\.\\s*(?:yes|allow|approve|proceed)\\b'],
      all: [
        {
          any: [
            { regex: ['press.{0,20}enter.{0,30}(?:confirm|continue|select)'] },
            { regex: ['esc.{0,40}cancel'] },
          ],
        },
      ],
      visibleBlocker: true,
      automationSafe: true,
    },
    {
      id: 'tool-confirmation',
      state: 'blocked',
      priority: 900,
      region: { kind: 'bottom_lines', count: 16 },
      all: [
        {
          any: [
            { regex: ['\\d+\\.\\s+(?:allow|approve|yes|no)\\b'] },
            { lineRegex: ['\\((?:y/n|yes/no)\\)\\s*$'] },
          ],
        },
        {
          any: [
            { regex: ['(?:apply|allow|approve|confirm|proceed)'] },
            { regex: ['press.{0,20}enter'] },
          ],
        },
      ],
      visibleBlocker: true,
    },
    {
      id: 'working-status',
      state: 'working',
      priority: 700,
      region: { kind: 'bottom_non_empty_lines', count: 6 },
      any: [
        { regex: ['(?:streaming response|running (?:tool|command)|tool executing)'] },
        { regex: ['\\(\\s*(?:\\d+m\\s*)?\\d+s\\s*[·•]'] },
      ],
      visibleWorking: true,
    },
    {
      id: 'idle-input',
      state: 'idle',
      priority: 500,
      region: { kind: 'bottom_non_empty_lines', count: 8 },
      any: [
        { contains: ['type your message'] },
        { contains: ['? for shortcuts'] },
        { lineRegex: ['^\\s*>\\s*$'] },
      ],
      not: [
        { regex: ['\\d+\\.\\s+(?:allow|approve|yes|no)\\b'] },
      ],
      visibleIdle: true,
    },
  ],
};
