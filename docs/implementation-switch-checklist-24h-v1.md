# 确认后24h切换清单 v1（冻结期值守产物）

证据源状态：`PRIMARY (UNIQUE)`  
唯一引用路径：`docs/implementation-switch-checklist-24h-v1.md`  
更新时间：2026-03-24 07:18 HKT  
适用条件：仅在 #36 明确“方向顺序 + 是否允许第二优先并行预热”后触发  
关联：#60 #35 #36 #34 #6 #17

## 1. 执行前置与冻结声明

- 当前（#36 未确认）：A/B/C 新功能编码与提测继续冻结。
- 触发条件：user 在 #36 明确确认后，进入 24h 切换执行。
- 时间门槛：若 2026-03-24 12:00 HKT 前 #36 仍未确认，继续冻结并仅滚动维护本清单。
- 本清单用途：用于确认后快速落地，不作为冻结期编码依据。

## 2. 候选方向与入口模块

| 方向 | 首批目标 | 入口模块（代码） | 首批依赖 | 主要风险 |
|---|---|---|---|---|
| A: Web 录制回放入口 | 录制列表、会话过滤、单条回放与失败提示 | `src/server/routes.ts`（录制接口）、`src/web/components/*`（回放 UI）、`src/web/hooks/*`（请求/状态） | #35 验收口径、录制样本、#34 断言模板 | 录制样本质量不稳定导致回放失败口径不一致 |
| B: 多服务端可观测性面板 | 多 server 连接态/最近错误/重试状态可见 | `src/coordinator.ts`（状态聚合）、`src/server/observability.ts`（事件归一）、`src/web/components/*`（面板） | `server_id` 字段完整采集、#34 门禁口径 | 多节点状态抖动造成 UI 状态闪烁与误报 |
| C: Codex Resume + Cache 阈值重置 | resume 同会话、阈值监控、超阈值自动轮转 | `src/adapters/codex.ts`（resume 能力）、`src/coordinator.ts`（轮转策略）、`src/server/routes.ts`（元数据接口） | resume 能力探针、字段 `parent_session_id` 口径冻结 | 外部能力不稳定导致 resume 成功率不可控 |

## 3. 确认后24h时间序列（T=确认时间）

| 时间窗 | 执行动作 | owner | 输出物 |
|---|---|---|---|
| T+00 ~ T+00:30 | 创建首批 P0/P1 开发实施单与测试验证单，并在 #35 回链 | dev/test/product | 开发单号 + 验证单号 + 关联链路 |
| T+00:30 ~ T+02:00 | 冻结所选方向验收口径（含非目标/阻断条件） | product | 口径回贴（#35） |
| T+02:00 ~ T+06:00 | 完成首个最小切片实现与自测证据（六字段） | dev | 首个提交 + 自测记录 |
| T+06:00 ~ T+10:00 | 执行定向验证 + 关键回归（#34） | test | 通过/不通过 + 阻断项 |
| T+10:00 ~ T+18:00 | 根据验证反馈收敛阻断项并二次提测 | dev/test | 修复提交 + 复验记录 |
| T+18:00 ~ T+24:00 | 输出 24h 阶段结论与下一批计划 | product/dev/test | #17 里程碑同步 + 后续排程 |

## 4. 首批实施切片（方向触发即用）

- 选择 A：`A-01 契约冻结` -> `A-02 回放控制` -> `A-03 失败口径回归`
- 选择 B：`B-01 状态聚合` -> `B-02 重连与跳转` -> `B-03 性能兜底与验证`
- 选择 C：`C-01 能力探针` -> `C-02 Resume 链路` -> `C-03 阈值轮转追溯`

### 首批9切片字段对齐表（对齐 #61 comment_id=`03a1368b-4353-4252-b142-a6a4961c3c74`）

| 切片 | 目标问题 | 拟改动文件（精确路径） | 预估工时（小时） | 测试入口（可直接执行命令） | 依赖项（样本/探针/feature flag） |
|---|---|---|---|---|---|
| A-01 契约冻结 | 录制列表接口契约未冻结，导致前后端与验证口径无法稳定对齐。 | `src/server/routes.ts`<br>`src/session/types.ts`<br>`tests/server.test.ts` | 4-6 | `npm test -- tests/server.test.ts -t "recordings list contract"` | `recording_sample_seed_v1`（样本）<br>`feature_flag_recording_contract_lock`（feature flag） |
| A-02 回放控制 | 回放播放/暂停/拖动状态机未固化，容易出现 UI 与引擎状态漂移。 | `src/session/replayer.ts`<br>`src/web/components/TerminalView.tsx`<br>`tests/replayer.test.ts` | 5-7 | `npm test -- tests/replayer.test.ts` | `recording_sample_seed_v1`（样本）<br>`feature_flag_replayer_controls`（feature flag） |
| A-03 失败口径回归 | 缺少录制不存在场景的统一错误码与前端提示口径。 | `src/server/routes.ts`<br>`src/web/hooks/useSessions.ts`<br>`tests/server.test.ts` | 3-5 | `npm test -- tests/server.test.ts -t "recording not found" && npm test` | `recording_missing_case_v1`（样本）<br>`error_probe_recording_not_found_v1`（探针） |
| B-01 状态聚合 | 多服务端连接状态分散在不同通道，聚合态无法保证按 `server_id` 一致。 | `src/coordinator.ts`<br>`src/server/observability.ts`<br>`src/web/hooks/useServers.ts`<br>`tests/session.test.ts` | 5-8 | `npm test -- tests/session.test.ts -t "server status aggregate"` | `server_status_fixture_dual_node_v1`（样本）<br>`feature_flag_observability_panel_v1`（feature flag） |
| B-02 重连与跳转 | 断连重试和最近错误未形成可跳转链路，定位失败根因成本高。 | `src/ipc/ws-client.ts`<br>`src/web/hooks/useMultiWebSocket.ts`<br>`src/web/components/StatusIndicator.tsx`<br>`tests/ws-client.test.ts` | 4-6 | `npm test -- tests/ws-client.test.ts -t "retry status and error link"` | `ws_retry_event_probe_v1`（探针）<br>`feature_flag_observability_error_link`（feature flag） |
| B-03 性能兜底与验证 | 高频可观测性事件下缺少节流兜底，存在面板卡顿与延迟飙升风险。 | `src/server/observability.ts`<br>`src/web/hooks/useServers.ts`<br>`src/web/components/SessionList.tsx`<br>`tests/server.test.ts` | 4-7 | `npm test -- tests/server.test.ts -t "observability high-frequency" && npm test` | `observability_burst_fixture_100pm_v1`（样本）<br>`feature_flag_observability_debounce`（feature flag） |
| C-01 能力探针与元数据模型 | 未固化 resume 能力探针与元数据字段，导致是否可 resume 无法被测试门禁判定。 | `src/adapters/codex.ts`<br>`src/server/routes.ts`<br>`src/session/types.ts`<br>`tests/adapters.test.ts` | 6-8 | `npm test -- tests/adapters.test.ts -t "codex capability probe metadata"` | `codex_resume_probe_v1`（探针）<br>`feature_flag_codex_resume_metadata`（feature flag） |
| C-02 Resume 链路 | 同会话 resume 链路缺少 `parent_session_id` 追溯，恢复行为不可验证。 | `src/adapters/codex.ts`<br>`src/session/manager.ts`<br>`src/coordinator.ts`<br>`tests/adapters.test.ts` | 5-8 | `npm test -- tests/adapters.test.ts -t "resume chain"` | `codex_resume_probe_v1`（探针）<br>`feature_flag_codex_resume_chain`（feature flag） |
| C-03 阈值轮转追溯 | cache 超阈值后的自动切会话缺少链路追溯字段，问题回放不可闭环。 | `src/session/session.ts`<br>`src/coordinator.ts`<br>`src/server/routes.ts`<br>`tests/session.test.ts` | 4-7 | `npm test -- tests/session.test.ts -t "cache threshold rotation" && npm test` | `cache_threshold_probe_v1`（探针）<br>`feature_flag_cache_auto_rotate`（feature flag） |

## 5. 确认后30分钟首批 P0/P1 开发实施单草案（模板）

说明：以下为草案模板，#36 确认后按方向替换 `<PLACEHOLDER>` 并创建实际 issue。

### 5.1 P0 开发实施单模板（第一优先方向）

- 标题模板：`[实施-P0] <A|B|C>-01 首批最小切片（确认后30分钟创建）`
- 指派：`swarmie-dev-agent`
- labels：`execution,dev,P0,<A|B|C>`
- 正文模板：
  - 背景：承接 #36 已确认方向 `<A|B|C>`，执行 #60 冻结解除后的首个实现切片。
  - 范围：仅覆盖 `<A-01|B-01|C-01>`，不扩展二级需求。
  - 验收：对齐 #35 冻结口径与 #34 门禁，回贴六字段证据。
  - 回链：`#60 #35 #34 #36 #17`

### 5.2 P1 开发实施单模板（第一优先方向后续切片）

- 标题模板：`[实施-P1] <A|B|C>-02 后续切片与回归收敛`
- 指派：`swarmie-dev-agent`
- labels：`execution,dev,P1,<A|B|C>`
- 正文模板：
  - 背景：承接 `<A|B|C>-01` 完成后的第二切片开发。
  - 范围：覆盖 `<A-02|B-02|C-02>` 与必要回归补强。
  - 验收：最小自动化入口可复验，阻断项需在 #34 登记。
  - 回链：`#60 #35 #34 #36 #17`

### 5.3 预填充映射（用于快速替换）

| 方向 | P0 草案标题 | P1 草案标题 |
|---|---|---|
| A | `[实施-P0] A-01 契约冻结与接口落点` | `[实施-P1] A-02 回放控制与只读隔离` |
| B | `[实施-P0] B-01 状态聚合 store` | `[实施-P1] B-02 断连重试与失败跳转` |
| C | `[实施-P0] C-01 能力探针与元数据模型` | `[实施-P1] C-02 Resume 链路与入口` |

## 6. 风险与应对（24h 视角）

| 风险 | 等级 | 影响面 | 应对措施 |
|---|---|---|---|
| #36 确认信息不完整（无顺序或无并行预热授权） | P0 | 无法按规则创建首批并行任务 | 在 #35 提交决策澄清项，仅推进第一优先方向 |
| 六字段证据不完整 | P0 | #34 无法判定放行 | 开发与测试回贴模板强制包含 `command/exit_code/timestamp/result/key_evidence/related_issue` |
| 测试窗口冲突 | P1 | 第二优先项验证延后 | 沿用 D55-1（方案A），仅第一优先占用测试窗口；12:00 未确认继续冻结 |
| 方向依赖不满足（样本/能力探针） | P1 | 首批切片节奏受阻 | 启用 feature flag 与降级路径，先交付可验证最小切片 |

## 7. 依赖核对快照（冻结期）

核对时间：2026-03-24 07:18 HKT

| 依赖项 | 当前状态 | 核对结论 | 对 #60 的影响 |
|---|---|---|---|
| #36（用户确认） | `open` | 未满足触发条件 | 继续冻结，仅维护切换资产 |
| #35（产品口径） | `in_progress` | 可作为实施验收口径来源 | 可用于确认后创建 P0/P1 草案单 |
| #34（测试门禁） | `in_progress` | 六字段与门禁入口已可复用 | 确认后可直接挂接验证单 |
| #61（测试24h切换准备） | `in_progress` | 测试侧切换值守持续进行 | 确认后可在 30 分钟内并联创建验证单 |
| #6（生命周期总览） | `in_progress` | 主链仍为 `#35 -> #36 -> #60/#61 -> #34 -> #17` | #60 需持续值守并同步状态 |
| #17（里程碑） | `open` | 等待 #36 触发后进入实施里程碑 | 暂不推进功能里程碑提交 |

## 8. 合规声明

- 本次输出仅为冻结期切换资产维护。
- 未进行 A/B/C 新功能编码，未发起 A/B/C 新功能提测。

## 9. 当前阻塞项（owner/ETA）

| 阻塞项 | owner | 当前状态 | 建议 ETA | 备注 |
|---|---|---|---|---|
| #36 方向确认（顺序 + 是否允许第二优先并行预热）缺失 | user | `open` | 2026-03-24 12:00 HKT 前给出确认 | 未确认前不创建实施编码单，仅维护草案路径 |
| #35 方向化验收口径冻结待触发 | product | `in_progress` | T+00:30（以 #36 确认时间为 T） | #36 确认后补齐方向化非目标/阻断条件 |
| #34/#61 方向化验证单挂接待触发 | test | `in_progress` | T+00:30（以 #36 确认时间为 T） | #36 确认后并联创建验证单并回链 |
