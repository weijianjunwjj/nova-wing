# 架构：从当前源码出发

适用：`ad26456e686a8e6517d157e96e3c2ebe00a257ef`，2026-10-02 只读核查。
这里描述代码结构与已实现合约，未运行完整系统；运行证据边界见 [CURRENT_STATE](CURRENT_STATE.md)。
长期方向与现存实现分开列出，不将早期设计图作为当前调用图。

## 已实现模块与职责

| 模块 | 实际职责 / 入口 | 边界 |
| --- | --- | --- |
| [core](../../packages/core/src) | Facade、domain validation、Store port；提案及人工批准后的主线 context | 不拥有宿主业务当前状态，不依赖 OfferFlow 实体 |
| [sqlite](../../packages/sqlite/src) | Core migration、事务、revision CAS、snapshot registry / digest | 自建与注入连接的关闭 / 事务所有权不同；不是 Guardian 全部 state 的数据库 |
| [host-snapshot](../../packages/host-snapshot/src) | 组合 manifest、显式组件注册、验证与生命周期协议 | 提供合约 / adapter；具体宿主文件恢复不在本切片中 |
| [testing](../../packages/testing/src) | FakeOfferFlowHost 的 Facade 合约样例 | 假宿主不是真实 OfferFlow 集成 |
| [planning](../../packages/development-guardian/planning) | requirement → draft → deterministic / semantic gates → answers / revision → approval / freeze | 规划 Semantic Reviewer 与 Runtime Reviewer 是两个入口；批准本身不创建 WorkSession |
| [delivery](../../packages/development-guardian/delivery) | 目标绑定、RuntimePlan 编译 / admission、obligation / blueprint、执行适配、evidence store、customer completion | 验证身份和客户结果分层，不直接把 HTTP 200 / exit 0 当业务 PASS |
| [work-session](../../packages/development-guardian/work-session) | Mastra workflow、串行 task、V2 state / Controller、verification planner、review dispatcher、checkpoint、recovery / leases | 模型提供执行或判断输入，Controller 和 host 负责状态 / 权限 / 事实校验 |
| [executor-router](../../packages/development-guardian/executor-router.ts) 及 executors | Codex SDK / workspace MCP，或现有 Claude CLI / DeepSeek 路由；延续 / failover metadata | 替换 provider 要通过适配器、配置、health、权限和证据合约，不代表任意模型都已认证 |
| [runtime-config](../../packages/development-guardian/runtime-config) | Desk HTTP config、validated last-known-good、builtin model policy | remote 不可用可回退配置；配置成功不等于 provider probe 成功 |
| [Launchpad](../../packages/development-guardian/work-session/launchpad/server.ts) / [Control UI](../../packages/development-guardian/work-session/control-ui/server.ts) | 本机 HTTP、Customer / task UI、创建与控制、SSE / 事件投影 | 页面状态不能代替 persisted task / completion 证据 |
| [platform](../../packages/development-guardian/platform) / [desktop/main](../../desktop/main) | 平台路径 / shell / SDK 工具、Electron Host、窗口 / Tray / Power / 通知 / updater | Desktop 加载现有 HTTP 控制面；不是第二套交付 engine |

根 [package exports](../../package.json) 有本地 `development-guardian` 出口；正式私有分发包的
四个出口和许可边界见 [README](../../README.md)、[ADR 0003](../adr/0003-private-github-packages-and-immutable-consumption.md)。
不能把本地 Guardian 入口直接宣称为正式消费者已有的稳定 API。

## 关键调用和数据流

### Core：人工批准的长期主线

```text
宿主 / 用户 → NovaWingFacade → NovaWingStore port → SQLite transaction
draft / pending → 人工 approve / reject
approve → append entry + terminate proposal + increment revision（同一事务）
getContext → 同一读事务内的当前主线 / revision
```

来源：[facade.ts](../../packages/core/src/facade.ts)、[store port](../../packages/core/src/ports/store.ts)、
[SQLite store](../../packages/sqlite/src/sqlite-nova-wing-store.ts)。
长期主线与客户仓库 / 任务执行状态不是同一个 authority；不可把 Runtime 猜测写成正式主线。

### 规划与显式启动交付

```text
Launchpad /api/planning/generate
 → PlanningService → PlanningProvider
 → deterministic validator → independent PlanningSemanticReviewer
 → bounded repairs → planning_failed / needs_customer_input / ready_for_approval
CustomerAnswer（问题与源版本绑定）→ 新版本重复 gates
显式 approval → PlanSnapshot（内容 hash + approval + answer audit）

/api/delivery/prepare
 → verify frozen snapshot → inspect / bind target → compile RuntimePlan → admission
/api/delivery/start（精确 snapshot / plan / hash / binding）
 → readiness 重验 → durable STARTING claim
 → Production WorkSession createAndStart → STARTED 或 terminal startup failure
```

来源：[Launchpad](../../packages/development-guardian/work-session/launchpad/server.ts)、
[PlanningService](../../packages/development-guardian/planning/service.ts)、
[freeze](../../packages/development-guardian/planning/freeze.ts)、
[DeliveryService](../../packages/development-guardian/delivery/service.ts)。
prepare、READY、approval 都不是 Start Delivery 的同义词；中断的 STARTING 也不能因 DB 文件存在
自动判断启动成功。

### 交付执行与证据

```text
RuntimePlan task / assertion → unique canonical OWNER 或 CONTRIBUTORS
 → immutable VerificationObligation / obligationSetHash
 → WorkSession definition → Production V2 Controller（Delivery 不走 Direct / Golden）
 → Executor 在 task scope 内实现
 → VERIFY：host owned implementation checkpoint → durably accept new observation
 → bind exact blueprint at implementation commit → deterministic validate + independent review
 → run bounded verifier / collector → assertion-bound evidence
 → independent Runtime REVIEW → local task gate / checkpoint finalization
 → customer delivery gate：所有任务及外部 / 人工 residual 验收
```

来源：[runtime-plan](../../packages/development-guardian/delivery/runtime-plan.ts)、
[runtime-adapter](../../packages/development-guardian/delivery/runtime-adapter.ts)、
[production](../../packages/development-guardian/work-session/production.ts)、
[owned-checkpoint](../../packages/development-guardian/work-session/owned-checkpoint.ts)、
[staged-verification](../../packages/development-guardian/delivery/staged-verification.ts)。

canonical owner 根据覆盖任务的依赖关系确定：唯一候选必须依赖其他覆盖任务；无法唯一确定则
AMBIGUOUS 并阻塞。CONTRIBUTES 任务提供 technical output、task-local verification 与独立 review，
不领取 owner 的客户 assertion PASS。[obligation tests](../../tests/delivery-obligation.test.ts) 有对应负例，
本轮只读这些测试，未运行。

普通任务仍可能启用 [Direct Path](../../packages/development-guardian/work-session/direct-path.ts)、
[Golden Path](../../packages/development-guardian/work-session/golden-path.ts) 或 legacy Guardian；
[v0.2.8 架构文档](../plan/NovaWing-v0.2.8-Architecture-Convergence.md) 的默认路径描述
不能套用到 Delivery 专用 V2 路径。不要把所有模式绘成同一条必经 REVIEW 流程。

## 关键数据权威及存储

| 数据 | 权威 / 实现 | 应保留的绑定 |
| --- | --- | --- |
| Core mainline / proposals / revision | SQLite `nw_*` 显式注册表 | 原子事务、proposal 唯一应用、revision；宿主不绕过 Facade |
| DevelopmentPlan / answers / snapshot | [PlanningStore](../../packages/development-guardian/planning/service.ts) 的版本化 JSON | source plan/version、content hash、approval、answer audit |
| RuntimePlan / target binding / evidence / transitions / external acceptance | [DeliveryStore](../../packages/development-guardian/delivery/service.ts) | snapshot / runtimePlan / obligation / assertion / owner / implementation commit / artifact hash lineage |
| WorkSession workflow / TaskStateV2 / events / recovery receipt | [runtime](../../packages/development-guardian/work-session/runtime.ts)、[task-state-v2](../../packages/development-guardian/work-session/task-state-v2.ts)、Mastra libSQL snapshot | session / run / task / attempt / generation / dispatch、trusted Git observation 与 ownership |
| provider continuation / execution / analytics | [CodingExecutionStore](../../packages/development-guardian/work-session/coding-execution-store.ts)、[execution ledger](../../packages/development-guardian/work-session/execution-ledger.ts)、[analytics](../../packages/development-guardian/work-session/task-run-analytics.ts) | 实际 provider 和 attempt；不把 profile 名当实际执行身份 |
| secrets / trusted runtime config | [platform paths](../../packages/development-guardian/platform/paths.ts)、可信配置读取及 secret adapter | 是敏感外部输入，不复制到交接；不将缓存 config 当活跃认证证据 |

读取真实 session 应遵循只读查询；本轮没有调用会初始化 / migration / probe / write 的生产工厂。
work-session DB 和 Core DB 不可因“都用 SQLite”就混成一个状态源。默认 data/config 路径可被
环境或可信配置覆盖，CURRENT_STATE 仅对指定本机根目录作观察。

## 已有边界和计划实现

- **已实现**：模型适配接口、路由、V2 控制、分阶段 verification、外部 acceptance 记录接口、
  Electron 本机控制面。实现存在不代表所有 provider / 主机 / 客户场景通过。
- **部分合约已实现、运行覆盖待核实**：browser / desktop / external platform / human 的证明分类；
  本轮未见所有这些通道都拥有自动化交付 provider。外部证据提交仍需要可信操作者核验语义。
- **协议与假宿主已有、真实集成待核实**：OfferFlow Snapshot / Core 接入；ADR 0002 明确具体宿主
  restore、drain、临时库与原子替换属于后续切片，不能由测试夹具推出完成。
- **产品目标而非已验证 KPI**：稳定地低成本完成真实客户交付；需要实际 provider、失败 / 修复
  轮次、成本、时间和客户验收数据，当前 scripted benchmark 无法证明。
- **不属于已批准实现计划**：本交接未新增跨项目引擎、自动历史 checkpoint claim 或客户恢复
  工程任务。未来做什么须由用户任务与 Claude 验收判断确定。
