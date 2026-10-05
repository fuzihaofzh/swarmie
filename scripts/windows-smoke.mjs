import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

if (process.platform !== 'win32') {
  console.error('This integration check requires native Windows (not WSL).');
  process.exit(1);
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
assert.ok(existsSync(join(projectRoot, 'dist/web/index.html')), 'Run npm run build first.');
const testRoot = mkdtempSync(join(tmpdir(), 'swarmie-windows-'));
process.env.SWARMIE_CONFIG_DIR = join(testRoot, 'config');
const cwd = join(testRoot, 'work space 中文');
mkdirSync(cwd);
const { startCoordinator } = await import('../dist/src/coordinator.js');
const { findWindowsShell, getDefaultShell } = await import('../dist/src/cli/shell.js');
const children = [];
let coordinator;
let socket;

async function until(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function launch(args) {
  const child = spawn(process.execPath, [join(projectRoot, 'dist/bin/swarmie.js'), ...args], {
    cwd: projectRoot, env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const record = { child, output: '', done: false, code: null, error: null };
  children.push(record);
  child.stdout.on('data', (chunk) => { record.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { record.output += chunk.toString(); });
  child.on('error', (error) => { record.error = error; record.done = true; });
  child.on('close', (code) => { record.code = code; record.done = true; });
  return record;
}

try {
  const probe = createNetServer();
  await new Promise((done, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', done); });
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const password = randomBytes(16).toString('hex');
  coordinator = await startCoordinator({ port, host: '127.0.0.1', web: true, record: false, password });
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(auth.status, 200);
  const { token } = await auth.json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const dashboard = await fetch(baseUrl, { headers });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /id="root"/);
  console.log('PASS: named-pipe coordinator, authentication and built dashboard');

  socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/ws`, { headers });
  await new Promise((done, fail) => { socket.once('open', done); socket.once('error', fail); });
  const send = (type, sessionId, extra = {}) => socket.send(JSON.stringify({ type, sessionId, ...extra }));
  const outputs = new Map();
  coordinator.manager.on('event', (event) => {
    if (event.type === 'raw:output') {
      outputs.set(event.sessionId, (outputs.get(event.sessionId) || '') + Buffer.from(event.data.data, 'base64').toString());
    }
  });

  const shells = [...new Set([getDefaultShell(), findWindowsShell('powershell')])];
  for (const tool of shells) {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST', headers, body: JSON.stringify({ tool, args: ['-NoProfile'], cwd: projectRoot }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const session = coordinator.manager.getSession(result.id);
    await until(() => outputs.get(result.id)?.includes('\x1b]133;A'), `${tool} prompt integration`);
    send('subscribe', result.id);
    send('resize', result.id, { cols: 100, rows: 30 });
    send('input', result.id, { data: "Write-Output ('SWARMIE_' + 'POWERSHELL_OK_中文')\r" });
    await until(() => outputs.get(result.id)?.includes('SWARMIE_POWERSHELL_OK_中文'), `${tool} Unicode output via WebSocket input`);
    send('input', result.id, { data: `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'\r` });
    await until(() => session.summary.cwd === cwd, `${tool} cwd with spaces and Unicode`);
    send('input', result.id, { data: "& $env:ComSpec /d /c 'exit 7'\r" });
    await until(() => session.status === 'idle', `${tool} idle after command`);
    send('input', result.id, { data: "Write-Output ('EXIT_CODE_' + $LASTEXITCODE)\r" });
    await until(() => outputs.get(result.id)?.includes('EXIT_CODE_7'), `${tool} preserves native exit code`);
    const detected = [];
    session.on('event', (event) => { if (event.type === 'tool:detect') detected.push(event.data.tool); });
    send('input', result.id, { data: `& '${process.execPath.replace(/'/g, "''")}' -e "console.log('OpenAI Codex (v0.144.6)'); console.log('Working (1s - esc to interrupt)')"\r` });
    await until(() => detected.includes('codex') && detected.at(-1) === tool && session.status === 'idle', `${tool} returns from an agent banner to shell`);
    send('input', result.id, { data: 'exit\r' });
    await until(() => session.status === 'completed', `${tool} exit`);
    console.log(`PASS: ${tool} PTY, WebSocket input/resize, Unicode, cwd, exit code and completion`);
  }

  // A second OS process must join the existing named pipe, not start another server.
  const cli = launch(['powershell.exe', '--port', String(port), '--session-name', 'windows-ipc-smoke', '--', '-NoProfile']);
  await until(() => {
    if (cli.done) throw cli.error || new Error(cli.output);
    return coordinator.manager.getAllSessions().some((session) => session.name === 'windows-ipc-smoke');
  }, 'second CLI joins coordinator');
  const remote = coordinator.manager.getAllSessions().find((session) => session.name === 'windows-ipc-smoke');
  await until(() => outputs.get(remote.id)?.includes('\x1b]133;A'), 'IPC child prompt');
  send('input', remote.id, { data: "Write-Output ('SWARMIE_' + 'IPC_OK')\r" });
  await until(() => outputs.get(remote.id)?.includes('SWARMIE_IPC_OK'), 'input/output forwarded across named pipe');
  send('input', remote.id, { data: 'exit\r' });
  await until(() => cli.done, 'IPC client exits');
  assert.equal(cli.code, 0, cli.output);
  console.log('PASS: second CLI process, named-pipe discovery and bidirectional terminal traffic');

  const once = launch(['powershell.exe', '--no-web', '--', '-NoProfile', '-Command', "Write-Output ('ONE_' + 'SHOT_OK'); exit 3"]);
  await until(() => once.done, 'one-shot command exits');
  assert.equal(once.code, 3, once.output);
  assert.ok(once.output.includes('ONE_SHOT_OK'), once.output);
  console.log('PASS: explicit -Command remains noninteractive and preserves exit code');
  console.log('All native Windows smoke checks passed.');
} catch (error) {
  console.error('Windows smoke check failed:', error);
  process.exitCode = 1;
} finally {
  socket?.terminate();
  await coordinator?.cleanup();
  for (const record of children) {
    if (!record.done) {
      record.child.kill();
      try { await until(() => record.done, 'child cleanup', 5000); } catch { /* best effort */ }
    }
  }
  // Only delete the unique directory created above, after verifying its scope.
  const resolvedRoot = resolve(testRoot);
  assert.ok(resolvedRoot.startsWith(resolve(tmpdir()) + sep) && resolvedRoot !== resolve(tmpdir()));
  rmSync(resolvedRoot, { recursive: true, force: true });
}
