# swarmie

AI CLI tool aggregator — unify Claude Code, Codex, Gemini CLI and other AI coding tools into a single web multi-session dashboard.

## Features

- **Unified entry point**: `swarmie claude`, `swarmie codex`, `swarmie gemini`, or any command
- **Web dashboard**: Real-time terminal rendering (xterm.js), structured conversation view, event timeline
- **Multi-session**: Run multiple AI tools simultaneously, switch between them in one dashboard
- **Multi-process coordination**: First instance becomes the coordinator, subsequent instances auto-register via IPC
- **Theme system**: 6 built-in themes (Solarized Light/Dark, Dracula, Nord, Monokai, GitHub Dark)
- **Session recording**: `--record` to capture sessions as JSONL, with replay support
- **Remote control**: Send input, resize, or kill any session from the web dashboard
- **macOS desktop app**: Native .app wrapper with auto server management

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Start (e.g. with Claude Code)
node dist/bin/swarmie.js claude

# Start with any command
node dist/bin/swarmie.js vim

# Open the dashboard
open http://127.0.0.1:3200
```

### macOS Desktop App

```bash
# Build the native app
bash desktop/build.sh

# Run
open dist/Swarmie.app

# Or install to Applications
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

### Examples

```bash
# Claude Code interactive mode
swarmie claude

# Claude Code non-interactive + recording
swarmie claude --record -- -p "fix the bug" --output-format stream-json

# Codex
swarmie codex -- "add unit tests"

# Multi-window — run one per terminal, dashboard auto-aggregates
swarmie claude    # Terminal 1
swarmie codex     # Terminal 2 (auto-connects to Terminal 1's coordinator)
```

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

- **Adapters**: One adapter per AI tool, managing a PTY subprocess via node-pty and emitting normalized events
- **Session Manager**: Manages lifecycle and event streams for all sessions
- **IPC**: Unix socket communication; the first process (coordinator) runs the web server, subsequent processes register as clients
- **Web**: React 19 + xterm.js + Zustand, with real-time event push over WebSocket

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
    components/          TerminalView, SessionCard, StructuredView, EventTimeline
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

## Development

```bash
npm run build        # Build everything (TypeScript + Vite)
npm run build:web    # Build frontend only
npm test             # Run tests
```
