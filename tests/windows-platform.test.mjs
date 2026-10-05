// Run directly after build:server; no bundler or child process is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getSocketPath, getConfigDir } from '../dist/src/cli/config.js';
import { shellBasename, isPowerShell, powerShellArgs, powerShellPromptMarker, POWERSHELL_INTEGRATION, getDefaultShell } from '../dist/src/cli/shell.js';
import { GenericAdapter } from '../dist/src/adapters/generic.js';
import Fastify from 'fastify';
import { setupRoutes } from '../dist/src/server/routes.js';
import { SessionManager } from '../dist/src/session/manager.js';
import { registerAdapter } from '../dist/src/adapters/registry.js';

function withPlatform(platform, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try { return callback(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

test('Windows pipes are stable, isolated by port and distinct from Unix sockets', () => {
  withPlatform('win32', () => {
    assert.match(getSocketPath(3200), /^\\\\\.\\pipe\\swarmie-[a-f0-9]{16}-3200$/);
    assert.equal(getSocketPath(3200), getSocketPath(3200));
    assert.notEqual(getSocketPath(3200), getSocketPath(3201));
  });
  for (const platform of ['linux', 'darwin']) {
    withPlatform(platform, () => assert.equal(getSocketPath(3200), join(getConfigDir(), 'server-3200.sock')));
  }
});

test('PowerShell accepts full Windows paths, .exe and case variants', () => {
  for (const command of ['pwsh', 'POWERSHELL.EXE', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '/opt/pwsh']) {
    assert.equal(isPowerShell(command), true);
  }
  assert.equal(shellBasename('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.equal(isPowerShell('powershell-helper.exe'), false);
});

test('interactive launch preserves profile choice and carries UTF-16LE integration', () => {
  const args = powerShellArgs(['-NoProfile']);
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NoExit'));
  assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), POWERSHELL_INTEGRATION);
  assert.equal(powerShellArgs(['-NoExit']).filter((arg) => arg === '-NoExit').length, 1);
});

test('explicit commands, scripts and noninteractive invocations are unchanged', () => {
  for (const args of [['-Command', 'Write-Output 中文'], ['-File', 'test.ps1'], ['-NonInteractive'], ['--version']]) {
    assert.deepEqual(powerShellArgs(args), args);
  }
});

test('Windows defaults to PowerShell even if Git Bash set SHELL', () => {
  const saved = process.env.SHELL;
  process.env.SHELL = '/bin/bash';
  try {
    withPlatform('win32', () => assert.equal(isPowerShell(getDefaultShell()), true));
    for (const platform of ['linux', 'darwin']) {
      withPlatform(platform, () => assert.equal(getDefaultShell(), '/bin/bash'));
    }
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

test('PowerShell cwd handles split OSC, Unicode, spaces and UNC without changing host', () => {
  const adapter = new GenericAdapter('powershell.exe', { sessionId: 'windows-cwd', toolArgs: [], cwd: 'C:\\old' });
  const changes = [];
  adapter.on('event', (event) => { if (event.type === 'cwd:change') changes.push(event.data); });
  withPlatform('win32', () => {
    // parseOSC is protected in TypeScript; this exercises the compiled stream parser.
    adapter.parseOSC('\x1b]7;file:///C:/work%20space/%E4');
    adapter.parseOSC('%B8%AD%E6%96%87\x07');
    assert.equal(changes.at(-1).cwd, 'C:\\work space\\中文');
    const hostname = changes.at(-1).hostname;
    adapter.parseOSC('\x1b]133;A;swarmie=powershell;cwd=filesystem\x07');
    adapter.parseOSC('\x1b]7;file://fileserver/share/folder%20name\x07');
    assert.equal(changes.at(-1).cwd, '\\\\fileserver\\share\\folder name');
    assert.equal(changes.at(-1).hostname, hostname);
    adapter.parseOSC('\x1b');
    adapter.parseOSC(']7;file:///D:/next\x1b');
    adapter.parseOSC('\\');
    assert.equal(changes.at(-1).cwd, 'D:\\next');
    adapter.parseOSC('\x1b]133;A\x07\x1b]7;file://remote.invalid/home/user\x07');
    assert.equal(changes.at(-1).cwd, '/home/user');
    assert.equal(changes.at(-1).hostname, 'remote.invalid');
    assert.doesNotThrow(() => adapter.parseOSC('\x1b]7;file:///C:/%ZZ\x07'));
  });
  adapter.disposeScreen();
});

test('PowerShell returns from a detected agent on a split prompt marker and can detect the next agent', () => {
  const adapter = new GenericAdapter('powershell.exe', { sessionId: 'windows-agent-return', toolArgs: [] });
  withPlatform('win32', () => {
    adapter.handlePtyData('OpenAI Codex (v0.144.6)\r\n');
    assert.equal(adapter.info.name, 'codex');
    adapter.handlePtyData(powerShellPromptMarker('nested-session'));
    assert.equal(adapter.info.name, 'codex');
    const marker = powerShellPromptMarker('windows-agent-return');
    adapter.handlePtyData(marker.slice(0, 10));
    adapter.handlePtyData(marker.slice(10) + '\r\nPS C:\\work> ');
    assert.equal(adapter.info.name, 'powershell.exe');
    assert.equal(adapter.status, 'idle');
    adapter.write('claude\r');
    adapter.handlePtyData('Claude Code v2.1.212\r\n');
    assert.equal(adapter.info.name, 'claude');
  });
  adapter.clearIdleTimer();
  adapter.disposeScreen();
});

test('owning PowerShell prompt immediately finishes a command even with stale busy text', () => {
  const adapter = new GenericAdapter('pwsh.exe', { sessionId: 'powershell-completion', toolArgs: [] });
  adapter.write('Get-Date\r');
  assert.equal(adapter.status, 'running');
  adapter.handlePtyData('• Working (1s • esc to interrupt)\r\n');
  adapter.handlePtyData(powerShellPromptMarker('powershell-completion'));
  assert.equal(adapter.status, 'idle');
  adapter.write('Set-Location HKCU:\\\r');
  adapter.handlePtyData(powerShellPromptMarker('powershell-completion', false));
  assert.equal(adapter.status, 'idle');
  adapter.clearIdleTimer();
  adapter.disposeScreen();
});

test('web sessions use the owning server default for omitted tools and shell alias', async () => {
  const tool = getDefaultShell();
  class FakeShell extends GenericAdapter {
    constructor(options) { super(tool, options); }
    start() {}
  }
  registerAdapter(tool, FakeShell);
  const app = Fastify();
  const manager = new SessionManager();
  setupRoutes(app, manager);
  try {
    for (const body of [{}, { tool: 'shell' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { ...body, cwd: process.cwd() } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().tool, tool);
    }
  } finally {
    for (const session of manager.getAllSessions()) session.adapter?.disposeScreen?.();
    await app.close();
  }
});

test('a failed PTY launch does not leave a phantom dashboard session', async () => {
  class BrokenShell extends GenericAdapter {
    constructor(options) { super('broken-powershell', options); }
    start() { throw new Error('simulated PTY failure'); }
  }
  registerAdapter('windows-broken-shell-test', BrokenShell);
  const app = Fastify();
  const manager = new SessionManager();
  setupRoutes(app, manager);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { tool: 'windows-broken-shell-test', cwd: process.cwd() } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, 'simulated PTY failure');
    assert.equal(manager.size, 0);
  } finally { await app.close(); }
});
