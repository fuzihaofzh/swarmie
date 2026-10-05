import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export interface SwarmieConfig {
  port: number;
  theme: string;
  defaultTool?: string;
  recordDir: string;
  passwordHash?: string;
}

const CONFIG_DIR = process.env.SWARMIE_CONFIG_DIR || join(homedir(), '.swarmie');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: SwarmieConfig = {
  port: 3200,
  theme: 'dark',
  recordDir: join(CONFIG_DIR, 'recordings'),
};

export function ensureConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  return CONFIG_DIR;
}

export function loadConfig(): SwarmieConfig {
  ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SwarmieConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: SwarmieConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getSocketPath(port: number): string {
  if (process.platform === 'win32') {
    // Pipes are not filesystem entries. Namespace by user/config and port.
    const namespace = createHash('sha256').update(CONFIG_DIR.toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\swarmie-${namespace}-${port}`;
  }
  return join(CONFIG_DIR, `server-${port}.sock`);
}

export function getLockPath(port: number): string {
  return join(CONFIG_DIR, `server-${port}.lock`);
}
