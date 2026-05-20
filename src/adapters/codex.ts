import { SimplePtyAdapter } from './simple-pty.js';
import type { AdapterInfo } from './types.js';

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
}
