import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
const version: string = pkg.version;

export interface SwarmieOptions {
  port: number;
  host: string;
  web: boolean;
  log: boolean;
  theme: string;
  sessionName?: string;
  record: boolean;
  share: boolean;
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
    .option('--log', 'Enable file logging', false)
    .option('--theme <name>', 'Dashboard theme', 'dark')
    .option('--session-name <name>', 'Custom session name')
    .option('--record', 'Record session to JSONL', false)
    .option('--share', 'Generate shareable HTML after session', false)
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
      log: opts.log,
      theme: opts.theme,
      sessionName: opts.sessionName,
      record: opts.record,
      share: opts.share,
      server: opts.server,
      password: opts.password,
    },
    toolArgs,
  };
}
