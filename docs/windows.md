# Windows / PowerShell

Native Windows uses ConPTY for terminals and a named pipe for local process
aggregation. It does not require WSL or Git Bash. Use Windows 10 1809 or later,
or Windows 11, and Node.js 22 or 24. PowerShell 7 is selected when available;
otherwise Swarmie uses Windows PowerShell 5.1.

## One shared implementation

All platforms use the same CLI, adapters, session manager, HTTP/WebSocket
server and React dashboard. Add features once in those shared modules.
Platform differences are restricted to shell selection and prompt integration
(`src/cli/shell.ts`), IPC addressing (`src/cli/config.ts`) and the existing
terminal/path handling. There are no separate Windows, macOS or Linux apps.
On macOS/Linux, default shells still come from `SHELL` (falling back to bash),
local IPC still uses Unix sockets, and CLI builds still set executable bits.
The existing Node engine requirement is unchanged.

## Run this checkout

Use the same commands as macOS and Linux from this source checkout:

```powershell
cd C:\Users\fuzih\workbench\swarmie
npm ci
npm run build
npm start
```

After installing the npm package globally, the startup command is `swarmie`
on all three platforms. There is no Windows-specific launcher or build step.

Visit http://127.0.0.1:3200, set the dashboard password, then use the + button.
New sessions use the server's default shell. The session form and
Settings → Automation also offer PowerShell 7 and Windows PowerShell 5.1.
If PowerShell blocks npm's `npm.ps1` shim, use `npm.cmd` for that command.
This is a shell policy workaround for npm, not a different Swarmie entry point.

To open a shell directly and show it in the dashboard:

```powershell
npm start -- shell
npm start -- powershell.exe -- -NoProfile
npm start -- pwsh -- -NoProfile
```

Leave the server terminal running. Ctrl+C stops the server and its sessions.
Additional Swarmie CLI processes with the same port join its named pipe.
Different ports have independent coordinators. Config normally resides in
`$HOME\.swarmie`; set `SWARMIE_CONFIG_DIR` to isolate another instance.

## PowerShell integration

Interactive launches preserve the user's profile and wrap its existing prompt.
The wrapper emits OSC 133 when a prompt returns and OSC 7 for the filesystem
directory. This supports agent-to-shell transitions, Windows drive paths,
Unicode, spaces and UNC shares. It preserves `$LASTEXITCODE` and sets UTF-8
console/pipeline encoding. Prompt markers carry a session identifier so a
nested PowerShell cannot finish its parent session's command. `-NoProfile`,
`-NoLogo` and `-NoExit` can be passed
while retaining this integration.

Explicit arguments such as `-Command`, `-File`, `-EncodedCommand` and
`-NonInteractive` pass through unchanged; they do not receive the prompt
wrapper. Other custom startup flags also pass through unchanged. Replacing
`prompt` after launch removes the integration unless the replacement emits
the same OSC markers. Non-filesystem providers do not update the filesystem
working directory shown in the dashboard.

## Verification

```powershell
npm run test:platform
npm run test:windows
```

Run after a full build. The first checks shell selection, encoding, arguments,
IPC paths and directory decoding without spawning a terminal. The second
creates real PowerShell PTYs, checks authenticated HTTP and WebSocket input,
Unicode and directories, command exit status, and a second CLI process joining
the coordinator. It uses a temporary config and random port and cleans up its
own sessions. CI builds the same code on Windows/macOS/Linux with Node 22/24,
runs platform checks everywhere, the existing suite on macOS/Linux, and native
PowerShell smoke checks on Windows.

`EPERM` opening `\\.\pipe\conpty-...` or spawning esbuild indicates that the
execution environment prevented those operations. Run the checks from an
ordinary local terminal; a restricted agent sandbox cannot validate ConPTY.
If node-pty cannot install its prebuilt binary, its source-build fallback needs
Python and Visual Studio C++ build tools.

Protocol references: [Node IPC](https://nodejs.org/api/net.html#ipc-support),
[PowerShell launch options](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh).
