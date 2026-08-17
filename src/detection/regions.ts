import type { DetectionInput, DetectionRegion } from './types.js';

const HORIZONTAL_RULE_RE = /^\s*[─━═╌╍┄┅┈┉⎯_-]{4,}\s*$/u;
const PROMPT_LINE_RE = /^\s*[│┃]?\s*[›❯>]\s*/u;
const NUMBERED_PROMPT_LINE_RE = /^\s*[│┃]?\s*[›❯>]\s*\d+\.\s*/u;
const LIVE_PROMPT_MARKER_RE = /^\s*›(?!\s*\d+\.)/u;
const BOX_BORDER_RE = /^\s*[╭╰┌└┏┗┬┴┯┷├┤┝┥┼╮╯┐┘┓┛─━═]+/u;

function withoutTrailingBlankLines(text: string): string[] {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

function bottomLines(text: string, count: number): string {
  const lines = withoutTrailingBlankLines(text);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

function bottomNonEmptyLines(text: string, count: number): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

function topNonEmptyLines(text: string, count: number): string {
  return text.split('\n').filter((line) => line.trim() !== '').slice(0, count).join('\n');
}

function afterLastHorizontalRule(text: string): string {
  const lines = withoutTrailingBlankLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HORIZONTAL_RULE_RE.test(lines[i])) return lines.slice(i + 1).join('\n');
  }
  return bottomLines(text, 16);
}

function afterLastPromptMarker(text: string): string {
  const lines = withoutTrailingBlankLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIVE_PROMPT_MARKER_RE.test(lines[i])) return lines.slice(i + 1).join('\n');
  }
  return bottomLines(text, 20);
}

function promptBoxBody(text: string): string {
  const lines = withoutTrailingBlankLines(text);
  let promptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_LINE_RE.test(lines[i])) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex < 0) return '';

  let start = promptIndex;
  for (let i = promptIndex - 1; i >= Math.max(0, promptIndex - 8); i--) {
    if (BOX_BORDER_RE.test(lines[i]) || HORIZONTAL_RULE_RE.test(lines[i])) {
      start = i + 1;
      break;
    }
    start = i;
  }

  let end = promptIndex + 1;
  for (let i = promptIndex + 1; i < Math.min(lines.length, promptIndex + 8); i++) {
    if (BOX_BORDER_RE.test(lines[i]) || HORIZONTAL_RULE_RE.test(lines[i])) break;
    end = i + 1;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The currently selected numbered prompt card, from a little context above the
 * selection through the bottom controls.
 *
 * Approval option labels can contain an entire shell command (for example
 * "Yes, and don't ask again for: ssh ..."). At narrow terminal widths that one
 * option wraps to dozens of physical rows, pushing `❯ 1. Yes` outside every
 * fixed bottom-N-lines region. Anchor on the LAST selected numbered option
 * instead. Using the last marker also prevents an old approval in scrollback
 * from authorizing a newer model picker or other numbered menu.
 */
export function selectNumberedPromptCard(text: string): string {
  const lines = withoutTrailingBlankLines(text);
  let selectionIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (NUMBERED_PROMPT_LINE_RE.test(lines[i])) {
      selectionIndex = i;
      break;
    }
  }
  if (selectionIndex < 0) return '';

  // A newer unnumbered prompt means this selection belongs to an older card in
  // scrollback. Returning it would let the old `❯ 1. Yes` combine with controls
  // from a different current modal, which is precisely the cross-card evidence
  // leak this region is meant to prevent.
  for (let i = selectionIndex + 1; i < lines.length; i++) {
    if (PROMPT_LINE_RE.test(lines[i])) return '';
  }

  let start = Math.max(0, selectionIndex - 12);
  for (let i = selectionIndex - 1; i >= start; i--) {
    // Do not let a previous prompt/card leak affirmative evidence into the
    // current card. Borders and separators are equally strong boundaries.
    if (PROMPT_LINE_RE.test(lines[i]) || BOX_BORDER_RE.test(lines[i]) || HORIZONTAL_RULE_RE.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  return lines.slice(start).join('\n');
}

export function selectDetectionRegion(input: DetectionInput, region: DetectionRegion): string {
  switch (region.kind) {
    case 'whole_recent': return input.recent;
    case 'viewport': return input.viewport;
    case 'bottom_lines': return bottomLines(input.recent, region.count);
    case 'bottom_non_empty_lines': return bottomNonEmptyLines(input.recent, region.count);
    case 'top_non_empty_lines': return topNonEmptyLines(input.recent, region.count);
    case 'after_last_horizontal_rule': return afterLastHorizontalRule(input.recent);
    case 'after_last_prompt_marker': return afterLastPromptMarker(input.recent);
    case 'prompt_box_body': return promptBoxBody(input.recent);
    case 'numbered_prompt_card': return selectNumberedPromptCard(input.recent);
    case 'osc_title': return input.oscTitle ?? '';
    case 'osc_progress': return input.oscProgress ?? '';
  }
}
