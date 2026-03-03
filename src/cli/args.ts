import { Command } from 'commander';

export interface PolycodeOptions {
  port: number;
  web: boolean;
  log: boolean;
  theme: string;
  sessionName?: string;
  record: boolean;
  share: boolean;
}

export interface ParsedArgs {
  tool: string;
  polycodeOptions: PolycodeOptions;
  toolArgs: string[];
}

const KNOWN_TOOLS = ['claude', 'codex', 'gemini'];

export function createProgram(): Command {
  const program = new Command();

  program
    .name('polycode')
    .description('AI CLI tool aggregator — unified dashboard for Claude Code, Codex, Gemini CLI')
    .version('0.1.0')
    .argument('<tool>', `command to launch (built-in: ${KNOWN_TOOLS.join(', ')}, or any command)`)
    .option('--port <number>', 'Web dashboard port', '3200')
    .option('--no-web', 'Disable web dashboard')
    .option('--log', 'Enable file logging', false)
    .option('--theme <name>', 'Dashboard theme', 'dark')
    .option('--session-name <name>', 'Custom session name')
    .option('--record', 'Record session to JSONL', false)
    .option('--share', 'Generate shareable HTML after session', false);

  return program;
}

/**
 * Parse argv, splitting polycode args from tool args at `--`.
 *
 * Usage: polycode claude --port 3200 -- -p "fix bug"
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const doubleDashIdx = argv.indexOf('--');
  let polycodeArgv: string[];
  let toolArgs: string[];

  if (doubleDashIdx !== -1) {
    polycodeArgv = argv.slice(0, doubleDashIdx);
    toolArgs = argv.slice(doubleDashIdx + 1);
  } else {
    polycodeArgv = argv;
    toolArgs = [];
  }

  const program = createProgram();
  program.parse(polycodeArgv);

  const tool = program.args[0];
  if (!tool) {
    program.help();
    process.exit(1);
  }

  const opts = program.opts();

  return {
    tool,
    polycodeOptions: {
      port: parseInt(opts.port, 10),
      web: opts.web !== false,
      log: opts.log,
      theme: opts.theme,
      sessionName: opts.sessionName,
      record: opts.record,
      share: opts.share,
    },
    toolArgs,
  };
}
