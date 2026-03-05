# swarmie

AI terminal multiplexer for the browser. Run Claude Code, Codex, Gemini CLI — or any command — and manage everything from a single web dashboard.

```
┌─ ☰ ─┬─ >_ ~/project ─┬─ >_ ~/api ─┬─ + ─────────────────────┐
│                                                                │
│  $ claude "refactor auth module"                               │
│                                                                │
│  ● I'll refactor the auth module. Let me start by reading...   │
│                                                                │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install
npm run build
```

## Usage

```bash
# Server-only mode — opens dashboard with a default shell
swarmie

# Launch a specific tool
swarmie claude
swarmie codex
swarmie gemini

# Launch any command
swarmie python train.py
swarmie vim

# Multiple terminals auto-aggregate into one dashboard
# Terminal 1
swarmie claude
# Terminal 2 (auto-discovers the running coordinator)
swarmie codex -- "add unit tests"
# Both appear at http://localhost:3200
```

First visit to the dashboard prompts you to set a password. Subsequent visits require login.

## Features

- **Multi-session tabs** — Each session runs in its own PTY, rendered via xterm.js
- **Auto-detection** — Detects Claude/Codex/Gemini running inside a shell and shows the appropriate icon
- **Dynamic cwd** — Tab titles update as you `cd` around (via OSC 7)
- **Multi-server** — Connect to remote swarmie instances from a single dashboard, with per-server authentication
- **Password protection** — Browser-based setup, stored locally
- **6 themes** — Solarized Light/Dark, Dracula, Nord, Monokai, GitHub Dark
- **Session recording** — `--record` captures to JSONL for replay
- **Recent directories** — VSCode-style recent dirs list, persisted across sessions
- **Keyboard shortcuts** — `Cmd+←/→` switch tabs, `Ctrl+Cmd+T` new tab

## CLI Options

```
swarmie [command] [options] [-- tool-args...]
```

| Option | Default | Description |
|---|---|---|
| `--port <n>` | `3200` | Dashboard port |
| `--host <addr>` | `127.0.0.1` | Listen address (`0.0.0.0` for remote access) |
| `--password <pw>` | — | Set dashboard password via CLI |
| `--session-name <name>` | auto | Custom session name |
| `--record` | — | Record session to JSONL |
| `--share` | — | Generate shareable HTML after session |
| `--server <host:port>` | — | Connect to a remote coordinator |
| `--no-web` | — | Disable the web dashboard |
| `--log` | — | Enable file logging |

## Multi-Server Setup

Run swarmie on a remote machine:

```bash
# On remote server
swarmie --host 0.0.0.0
```

In the local dashboard, open the drawer (☰), add the remote server address and its password. Sessions from both machines appear in the same UI.

## Architecture

```
swarmie claude        swarmie codex        swarmie (shell)
     │                     │                     │
  PTY adapter           PTY adapter          PTY adapter
     │                     │                     │
     └──── IPC (Unix Socket) ────┬───────────────┘
                                 │
                          Session Manager
                                 │
                      Fastify (HTTP + WS)
                                 │
                   Browser (React + xterm.js)
```

- **Coordinator pattern** — First swarmie process owns the web server and IPC socket. Subsequent processes register their sessions via IPC.
- **Adapters** — Wrap PTY subprocesses, emit normalized events. Auto-detect tool type from terminal output.
- **Web** — React 19 + dockview + xterm.js + Zustand. All terminals stay mounted (hidden with CSS) for instant tab switching.

## Project Structure

```
bin/swarmie.ts           CLI entry point
src/
  cli/                   Arg parsing, config (~/.swarmie/)
  adapters/              claude, codex, gemini, generic, remote
  session/               Session lifecycle, recording
  ipc/                   Unix socket server/client
  server/                Fastify: routes, websocket, auth, static
  web/                   React frontend
    components/          Terminal panels, tabs, new session page
    hooks/               WebSocket, sessions, UI, dockview sync
    themes.ts            6 color themes
tests/                   Vitest
```

## Development

```bash
npm run build          # TypeScript + Vite
npm run build:web      # Frontend only
npm test               # 28 tests via vitest
```

## License

MIT
