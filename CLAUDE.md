# CLAUDE.md — polycode 项目指南

## 项目概述

polycode 是一个 AI CLI 工具聚合器，通过 PTY 包装 Claude Code、Codex、Gemini CLI 等工具，提供统一的 Web 多会话仪表盘。

## 构建和测试

```bash
npm run build          # TypeScript 编译 + Vite 构建前端
npm run build:web      # 只构建前端 (vite build)
npm test               # vitest run (28 个测试)
npx tsc -p tsconfig.json  # 只做类型检查/编译后端
```

## 关键架构决策

- **tsconfig.json 排除 src/web/**: 后端用 tsc 编译，前端用 Vite 编译，两者互不干扰
- **node-pty**: 需要从源码编译 (`npm rebuild node-pty --build-from-source`)，prebuilt 可能不兼容
- **Coordinator 模式**: 第一个 polycode 进程成为 coordinator（启动 Web + IPC），后续进程通过 `~/.polycode/server.sock` 注册
- **RemoteAdapter**: IPC 远程会话用虚拟适配器，通过 `onWrite/onResize/onKill` 回调转发到 IPC
- **Session.isLocal**: 本地会话的 PTY 大小由 CLI 终端控制，Web resize 不影响它

## 前端注意事项

- **xterm.js + requestAnimationFrame**: 终端创建延迟到容器有尺寸后，需要 `termReady` 状态触发事件重放
- **所有终端始终挂载**: 每个 session 一个 TerminalView，用 `visibility: hidden` + `pointer-events: none` 隐藏非活跃的，切换瞬间完成
- **Zustand events 用 Record 不用 Map**: 避免 `getSnapshot` 无限循环，用模块级 `EMPTY_EVENTS` 常量保证引用稳定
- **Base64 → Uint8Array**: PTY 输出 base64 编码，`atob()` 返回 Latin-1，必须转 Uint8Array 写入 xterm 才能正确处理 UTF-8
- **CSP**: index.html 需要 `unsafe-eval`（xterm.js 内部使用）和 `unsafe-inline`（内联样式）

## 文件布局

- `bin/polycode.ts` — CLI 入口，处理 stdin/stdout/PTY 管道
- `src/adapters/` — 各工具适配器，base.ts 定义抽象类
- `src/session/` — Session 类包装 adapter + 元数据
- `src/coordinator.ts` — 多进程协调，IPC server/client 集成
- `src/server/` — Fastify HTTP/WS/静态文件
- `src/web/` — React 前端，themes.ts 定义 6 个主题
- `tests/` — Vitest 单元/集成测试

## 常见坑

1. Claude 适配器需要 `env: { ...process.env, CLAUDECODE: undefined }` 避免嵌套检测
2. `__dirname` 在 ESM 中用 `fileURLToPath(import.meta.url)`，静态文件路径要从 `dist/src/server/` 往上 3 级
3. Commander.js 不要同时用 `allowUnknownOption(false)` + `passThroughOptions(true)`
