# Test Gate CI 复验入口（#37）

本说明用于测试代理复用统一入口，独立产出 #37 门禁证据。

## 环境冻结

- Node: `22.17.1`
- npm: `10.9.2`
- CI workflow: `Test Gate CI`（`.github/workflows/test-gate.yml`）

## CI 统一入口

CI job 中使用同一入口脚本：

```bash
bash scripts/ci-test-gate.sh
```

脚本会按顺序执行并记录日志：

1. `node -v`
2. `npm -v`
3. `npm test -- tests/server.test.ts tests/ws-client.test.ts`
4. `npm test`

日志格式包含：

- `command`
- `exit_code`
- `timestamp`
- `result`
- `key_evidence`
- `related_issue`

其中六字段记录以 `[EVIDENCE] ...` 行输出，可直接用于 issue 回贴。

日志位置：`artifacts/test-gate/*.log`

## 测试代理复用步骤

1. 触发 `Test Gate CI`（`workflow_dispatch` 或基于 PR/push 自动触发）；
2. 查看 `test-gate` job 日志与 `test-gate-logs` artifact；
3. 在测试 issue 回贴两条门禁命令的退出码与时间证据。

## 本地兜底（P1，非首轮前置）

如需在无本机 Node 环境下本地复验，可用 podman 运行同一脚本：

```bash
bash scripts/ci-test-gate-podman.sh
```

该命令在 `node:22.17.1` 容器内的临时目录执行 `npm ci` 与 `scripts/ci-test-gate.sh`，并将日志复制回宿主机 `artifacts/test-gate/`。
