import { chmodSync, readdirSync } from 'node:fs';
if (process.platform !== 'win32') {
  for (const file of readdirSync('dist/bin')) {
    if (file.endsWith('.js')) chmodSync(`dist/bin/${file}`, 0o755);
  }
}
