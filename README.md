# swarmie

AI CLI 工具聚合器 — 将 Claude Code、Codex、Gemini CLI 等 AI 编码工具统一到一个 Web 多会话仪表盘中。

## 功能

- **统一入口**: `swarmie claude`、`swarmie codex`、`swarmie gemini` 或任意命令
- **Web 仪表盘**: 实时终端渲染 (xterm.js)，结构化对话视图，事件时间线
- **多会话**: 多个终端同时运行不同 AI 工具，在同一个仪表盘中切换
- **多进程协调**: 第一个实例成为 coordinator，后续实例通过 IPC 自动注册
- **主题系统**: 6 个内置主题 (Solarized Light/Dark, Dracula, Nord, Monokai, GitHub Dark)
- **会话录制**: `--record` 录制会话为 JSONL，支持回放
- **远程控制**: Web 仪表盘可向任意会话发送输入、调整大小、终止

## 快速开始

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动（以 Claude Code 为例）
node dist/bin/swarmie.js claude

# 启动任意命令
node dist/bin/swarmie.js vim

# 打开浏览器访问
open http://127.0.0.1:3200
```

## CLI 用法

```
swarmie <command> [options] [-- tool-args...]
```

`--` 之前是 swarmie 参数，之后的全部传递给底层工具。

### swarmie 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port <n>` | 3200 | Web 服务器端口 |
| `--no-web` | - | 不启动 Web 服务器 |
| `--session-name <name>` | 自动生成 | 会话名称 |
| `--record` | - | 录制会话到 JSONL |
| `--log` | - | 启用日志 |

### 示例

```bash
# Claude Code 交互模式
swarmie claude

# Claude Code 非交互 + 录制
swarmie claude --record -- -p "fix the bug" --output-format stream-json

# Codex
swarmie codex -- "add unit tests"

# 多窗口 — 每个终端运行一个，Web 仪表盘自动聚合
swarmie claude    # 终端 1
swarmie codex     # 终端 2（自动连接到终端 1 的 coordinator）
```

## 架构

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

- **Adapters**: 每个 AI 工具一个适配器，通过 node-pty 管理 PTY 子进程，输出标准化事件
- **Session Manager**: 管理所有会话的生命周期和事件流
- **IPC**: Unix socket 通信，第一个进程 (coordinator) 运行 Web 服务器，后续进程注册为客户端
- **Web**: React 19 + xterm.js + Zustand，WebSocket 实时推送事件

## 项目结构

```
bin/swarmie.ts          CLI 入口
src/
  cli/                   参数解析、配置
  adapters/              适配器 (claude, codex, gemini, generic, remote)
  session/               会话管理、录制、回放
  ipc/                   IPC 服务端/客户端
  server/                Fastify HTTP + WebSocket + 静态文件
  web/                   React 前端
    components/          TerminalView, SessionCard, StructuredView, EventTimeline
    hooks/               useWebSocket, useSessions, useUI
    themes.ts            主题定义
tests/                   Vitest 测试
```

## 技术栈

| 包 | 用途 |
|----|------|
| node-pty | PTY 子进程管理 |
| fastify + @fastify/websocket | Web 服务器 |
| @xterm/xterm | 终端渲染 |
| react 19 + vite | 前端框架 |
| zustand | 状态管理 |
| tailwindcss v4 | 样式 |
| commander | CLI 参数 |
| vitest | 测试 |

## 开发

```bash
npm run build        # 构建全部（TypeScript + Vite）
npm run build:web    # 只构建前端
npm test             # 运行测试
```
