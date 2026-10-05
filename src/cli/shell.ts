import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function shellBasename(command: string): string {
  return (command.split(/[\\/]/).pop() || command).replace(/\.exe$/i, '').toLowerCase();
}

export function isPowerShell(command: string): boolean {
  return ['pwsh', 'powershell'].includes(shellBasename(command));
}

/** Decode Windows filesystem OSC 7 on any host, without changing Node requirements. */
export function decodeWindowsFileUri(host: string, encodedPath: string): string {
  if (/%2f|%5c/i.test(encodedPath)) throw new Error('Encoded path separator in file URI');
  const path = decodeURIComponent(encodedPath);
  if (host && host.toLowerCase() !== 'localhost') {
    return `\\\\${decodeURIComponent(host)}${path.replace(/\//g, '\\')}`;
  }
  if (!/^\/[a-z]:\//i.test(path)) throw new Error('Windows file URI requires a drive or UNC host');
  return path.slice(1).replace(/\//g, '\\');
}

/** Resolve without spawning another process (also works with paths containing spaces). */
export function findWindowsShell(name: 'pwsh' | 'powershell', env = process.env): string {
  const candidates = name === 'pwsh'
    ? [join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')]
    : [join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  for (const directory of (env.PATH || env.Path || '').split(delimiter)) {
    if (directory) candidates.push(join(directory.replace(/^"|"$/g, ''), `${name}.exe`));
  }
  return candidates.find((path) => existsSync(path)) || `${name}.exe`;
}

export function getDefaultShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || 'bash';
  const pwsh = findWindowsShell('pwsh');
  return existsSync(pwsh) ? pwsh : findWindowsShell('powershell');
}

// Keep the user's profile prompt. OSC 133 marks the return from an agent and
// OSC 7 supplies cwd, including drive letters, spaces, Unicode and UNC paths.
export const POWERSHELL_INTEGRATION = String.raw`
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$global:OutputEncoding = [Console]::OutputEncoding
$global:SwarmieOriginalPrompt = (Get-Command prompt).ScriptBlock
function global:prompt {
  $swarmieExitCode = $global:LASTEXITCODE
  $swarmieEsc = [char]27
  $swarmieBel = [char]7
  if ($PWD.Provider.Name -eq 'FileSystem') {
    [Console]::Write("$swarmieEsc]133;A;swarmie=powershell;cwd=filesystem$swarmieBel")
    $swarmieUri = [System.Uri]::new($PWD.ProviderPath)
    [Console]::Write("$swarmieEsc]7;$($swarmieUri.AbsoluteUri)$swarmieBel")
  } else {
    [Console]::Write("$swarmieEsc]133;A;swarmie=powershell;cwd=other$swarmieBel")
  }
  try { & $global:SwarmieOriginalPrompt } finally { $global:LASTEXITCODE = $swarmieExitCode }
}
`;

export function powerShellPromptMarker(sessionId: string, filesystem = true): string {
  return `\x1b]133;A;swarmie=powershell;session=${Buffer.from(sessionId).toString('hex')};cwd=${filesystem ? 'filesystem' : 'other'}\x07`;
}

export function powerShellArgs(args: string[], sessionId?: string): string[] {
  // Explicit commands/files/noninteractive modes must retain their original behavior.
  if (!args.every((arg) => /^-(NoProfile|NoLogo|NoExit)$/i.test(arg))) return args;
  const result = [...args];
  if (!result.some((arg) => /^-NoLogo$/i.test(arg))) result.push('-NoLogo');
  if (!result.some((arg) => /^-NoExit$/i.test(arg))) result.push('-NoExit');
  const script = sessionId
    ? POWERSHELL_INTEGRATION.replaceAll(';swarmie=powershell', `;swarmie=powershell;session=${Buffer.from(sessionId).toString('hex')}`)
    : POWERSHELL_INTEGRATION;
  return [...result, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
