import { SimplePtyAdapter } from './simple-pty.js';
import type { AdapterInfo } from './types.js';

export class OmpAdapter extends SimplePtyAdapter {
  get info(): AdapterInfo {
    return {
      name: 'omp',
      displayName: 'Oh My Pi',
      icon: 'π',
      command: 'omp',
      supportsStructured: false,
    };
  }
}
