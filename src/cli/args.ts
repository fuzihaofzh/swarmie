import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
function findPackageJson(startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Unable to locate package.json from ${startDir}`);
    }
    dir = parent;
  }
}

const pkgPath = findPackageJson(__dirname);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const version: string = pkg.version;

export interface SwarmieOptions {
  port: number;
  host: string;
  web: boolean;
  sessionName?: string;
  record: boolean;
  server?: string;
  password?: string;
}

export interface ParsedArgs {
  tool: string | undefined;
  swarmieOptions: SwarmieOptions;
  toolArgs: string[];
}

const KNOWN_TOOLS = ['claude', 'codex', 'gemini'];

export function createProgram(): Command {
  const program = new Command();

  program
    .name('swarmie')
    .description('AI CLI tool aggregator — unified dashboard for Claude Code, Codex, Gemini CLI')
    .version(version)
    .argument('[tool]', `command to launch (built-in: ${KNOWN_TOOLS.join(', ')}, or any command)`)
    .option('--port <number>', 'Web dashboard port', '3200')
    .option('--host <address>', 'Web dashboard listen address', '127.0.0.1')
    .option('--no-web', 'Disable web dashboard')
    .option('--session-name <name>', 'Custom session name')
    .option('--record', 'Record session to JSONL', false)
    .option('--server <host:port>', 'Connect to a remote coordinator')
    .option('--password <string>', 'Password for web dashboard');

  return program;
}

/**
 * Parse argv, splitting swarmie args from tool args at `--`.
 *
 * Usage: swarmie claude --port 3200 -- -p "fix bug"
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const doubleDashIdx = argv.indexOf('--');
  let swarmieArgv: string[];
  let toolArgs: string[];

  if (doubleDashIdx !== -1) {
    swarmieArgv = argv.slice(0, doubleDashIdx);
    toolArgs = argv.slice(doubleDashIdx + 1);
  } else {
    swarmieArgv = argv;
    toolArgs = [];
  }

  const program = createProgram();
  program.parse(swarmieArgv);

  const tool = program.args[0] as string | undefined;

  const opts = program.opts();

  return {
    tool,
    swarmieOptions: {
      port: parseInt(opts.port, 10),
      host: opts.host,
      web: opts.web !== false,
      sessionName: opts.sessionName,
      record: opts.record,
      server: opts.server,
      password: opts.password,
    },
    toolArgs,
  };
}
