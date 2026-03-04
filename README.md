# swarmie

A web-based dashboard for orchestrating AI workloads. Monitor, control, and collaborate on multiple AI agent sessions from anywhere — your browser, your phone, or a shared team screen.

> **Not just for coding agents.** Swarmie wraps any CLI tool via PTY — AI assistants, data pipelines, DevOps scripts, CI/CD tasks — and streams them to a real-time web dashboard.

## Why Swarmie

- **Access from anywhere** — The web dashboard works on any device with a browser. Run agents on a remote server, monitor from your iPad.
- **Team-friendly** — Multiple people can share the same dashboard, watching and interacting with all running sessions in real time.
- **Tool-agnostic** — Not limited to AI coding assistants. Wrap any CLI process: `swarmie claude`, `swarmie python train.py`, `swarmie kubectl logs -f ...`
- **Zero external dependencies** — No tmux, no screen, no special setup. Just Node.js.
- **Native macOS app** — Self-contained `.app` bundle with embedded Node.js runtime. Double-click and go.

## Features

- **Real-time terminal** — Full terminal rendering via xterm.js, streamed over WebSocket
- **Multi-session tabs** — Run and switch between multiple sessions in one dashboard
- **Multi-process coordination** — Each `swarmie` instance auto-discovers the coordinator via IPC; sessions aggregate automatically
- **Remote control** — Send input, resize, or kill any session from the web UI
- **Session recording** — `--record` captures sessions as JSONL for replay and analysis
- **6 built-in themes** — Solarized Light/Dark, Dracula, Nord, Monokai, GitHub Dark
- **Keyboard shortcuts** — Fast session switching and management

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Start with Claude Code
node dist/bin/swarmie.js claude

# Start with any command
node dist/bin/swarmie.js vim

# Open the dashboard
open http://127.0.0.1:3200
```

### Multi-Agent Workflow

```bash
# Terminal 1 — starts the coordinator + web server
swarmie claude

# Terminal 2 — auto-connects to the existing coordinator
swarmie codex -- "add unit tests"

# Terminal 3 — any CLI tool works
swarmie python scripts/analyze.py

# All three sessions appear in the same dashboard at localhost:3200
```

### macOS Desktop App

```bash
# Build the self-contained app (bundles Node.js + all dependencies)
bash desktop/build.sh

# Run
open dist/Swarmie.app

# Or install
cp -r dist/Swarmie.app /Applications/
```

## CLI Usage

```
swarmie <command> [options] [-- tool-args...]
```

Everything before `--` is a swarmie option; everything after is passed to the underlying tool.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port <n>` | 3200 | Web server port |
| `--no-web` | - | Don't start the web server |
| `--session-name <name>` | Auto-generated | Session display name |
| `--record` | - | Record session to JSONL |
| `--log` | - | Enable logging |

## Architecture

```
Terminal 1: swarmie claude          Terminal 2: swarmie codex
         |                                    |
    Claude Adapter (PTY)              Codex Adapter (PTY)
         |                                    |
         +--- IPC (Unix Socket) ---+----------+
                                   |
                            Session Manager
                                   |
                        Fastify (HTTP + WebSocket)
                                   |
                     Web Dashboard (React + xterm.js)
```

- **Adapters** — One per tool, wrapping a PTY subprocess via node-pty and emitting normalized events
- **Session Manager** — Manages lifecycle and event streams for all sessions
- **IPC** — Unix socket coordination; first process becomes the coordinator, others register as clients
- **Web** — React 19 + xterm.js + Zustand, real-time push over WebSocket
- **Desktop** — Swift + WKWebView, auto-starts the bundled Node.js server

## Project Structure

```
bin/swarmie.ts          CLI entry point
src/
  cli/                   Argument parsing, configuration
  adapters/              Adapters (claude, codex, gemini, generic, remote)
  session/               Session management, recording, replay
  ipc/                   IPC server/client
  server/                Fastify HTTP + WebSocket + static files
  web/                   React frontend
    components/          TerminalView, TabBar, SessionCard, EventTimeline
    hooks/               useWebSocket, useSessions, useUI
    themes.ts            Theme definitions
desktop/                 macOS native app (Swift + WKWebView)
tests/                   Vitest tests
```

## Tech Stack

| Package | Purpose |
|---------|---------|
| node-pty | PTY subprocess management |
| fastify + @fastify/websocket | Web server |
| @xterm/xterm | Terminal rendering |
| React 19 + Vite | Frontend framework |
| Zustand | State management |
| Tailwind CSS v4 | Styling |
| Commander | CLI argument parsing |
| Vitest | Testing |
| Swift + WKWebView | macOS desktop app |

## Development

```bash
npm run build        # Build everything (TypeScript + Vite)
npm run build:web    # Build frontend only
npm test             # Run tests
bash desktop/build.sh  # Build macOS app
```

## License

MIT
