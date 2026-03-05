import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SwarmieConfig {
  port: number;
  theme: string;
  defaultTool?: string;
  recordDir: string;
  passwordHash?: string;
}

const CONFIG_DIR = join(homedir(), '.swarmie');
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

export function getSocketPath(): string {
  return join(CONFIG_DIR, 'server.sock');
}

export function getLockPath(): string {
  return join(CONFIG_DIR, 'server.lock');
}
