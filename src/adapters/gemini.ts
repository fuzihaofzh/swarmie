import { SimplePtyAdapter } from './simple-pty.js';
import type { AdapterInfo } from './types.js';

export class GeminiAdapter extends SimplePtyAdapter {
  get info(): AdapterInfo {
    return {
      name: 'gemini',
      displayName: 'Gemini CLI',
      icon: '✨',
      command: 'gemini',
      supportsStructured: true,
    };
  }
}
