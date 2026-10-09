import { SimplePtyAdapter } from './simple-pty.js';
import type { AdapterInfo } from './types.js';

/**
 * Codex's default alternate-screen TUI scrolls its transcript internally by
 * repainting the whole screen, so nothing ever reaches terminal scrollback and
 * an hour of its "Working" animation evicts every real line from the raw
 * history ring. Inline mode inserts finished cells into real scrollback, which
 * is what the dashboard's history and "Load earlier" are built on. Passed as a
 * config override rather than `--no-alt-screen` so older Codex builds, which
 * ignore unknown config keys but reject unknown flags, still start.
 */
const INLINE_MODE_ARGS = ['-c', 'tui.alternate_screen=never'];

/** Whether the user already chose an alternate-screen mode themselves. */
function choosesAltScreenMode(args: string[]): boolean {
  return args.some((arg) => arg === '--no-alt-screen' || arg.includes('alternate_screen'));
}

export class CodexAdapter extends SimplePtyAdapter {
  get info(): AdapterInfo {
    return {
      name: 'codex',
      displayName: 'Codex',
      icon: '\u{1F4BB}',
      command: 'codex',
      supportsStructured: true,
    };
  }

  protected get spawnArgs(): string[] {
    if (choosesAltScreenMode(this.toolArgs)) return this.toolArgs;
    return [...INLINE_MODE_ARGS, ...this.toolArgs];
  }
}
