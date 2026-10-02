# 当前状态：版本化证据快照

核查日：2026-10-02（Asia/Shanghai）。仓库：`/Users/weijianjun/nova-wing`。
分支：`main`。HEAD：`ad26456e686a8e6517d157e96e3c2ebe00a257ef`。
开始核查时 `git status --short --untracked-files=all` 无输出；不存在已有 CLAUDE.md。
本轮只新增交接文件和入口，未改源码、AGENTS.md、既有报告或本地状态，未 commit / push。
没有 fetch，未证明远程分支或远程 CI 状态。

## 证据等级

- **实际复核：源码**＝本轮阅读了相应实现及相关测试源码，未执行这些测试。
- **实际复核：持久化 / Git / 摘要**＝本轮只读查询得到的观察；不等于重新运行流程。
- **历史报告**＝本轮阅读了报告或原始产物，但未重跑，时间和适用版本不能省略。
- **待核实**＝缺少对应运行、环境或产品证据；不能被实现存在、测试文件存在或历史绿灯代替。

除另注明的历史记录外，源码结论适用于上述 HEAD。根包仍为 `nova-wing@0.1.0`、
Node engines `>=24.0.0`；桌面 v0.4 与规划 / 交付 v0.5 是不同版本维度，不能用根包版本
判断某项交付能力。来源：[package.json](../../package.json)、[README](../../README.md)。

## 已实现及核查边界

| 事项 | 当前结论 | 证据与适用版本 | 本轮复核 |
| --- | --- | --- | --- |
| Core 领域闭环 | 人工批准、原子追加主线、revision、注入连接所有权及 Snapshot 合约存在；不证明 OfferFlow 真实接入 | [Facade](../../packages/core/src/facade.ts)、[SQLite](../../packages/sqlite/src/sqlite-nova-wing-store.ts)、[ADR 0001](../adr/0001-draft-proposal-state.md)、[ADR 0002](../adr/0002-distribution-source-and-host-snapshot-v3.md)，Core v0.1 | 源码 / 文档只读；未重跑 |
| Customer Planning | 确定性 MUST blocking assertion 覆盖与独立 semantic gate、有限修复、问题 / 答案版本绑定已经实现 | [planning/service](../../packages/development-guardian/planning/service.ts)、[validator](../../packages/development-guardian/planning/validator.ts)、[planning tests](../../tests/planning.test.ts)，v0.5 | 源码；不是最新生成结果证明 |
| Plan Freeze | 内容哈希、审批版本、答案审计、不可变 snapshot 与读取校验已实现；批准不直接启动 WorkSession | [freeze](../../packages/development-guardian/planning/freeze.ts)、[service](../../packages/development-guardian/planning/service.ts)、[Freeze Status](../plan/NovaWing-v0.5-Plan-Freeze-Status.md)，v0.5 Phase 2 | 源码及历史报告；未重新批准 |
| Delivery admission | compiler schema 3 / implementation `0.5.0-phase6.1`、admission model 2；canonical owner、obligationSetHash、target / policy / provider 校验存在 | [runtime-plan](../../packages/development-guardian/delivery/runtime-plan.ts)、[staged-verification](../../packages/development-guardian/delivery/staged-verification.ts)、[obligation tests](../../tests/delivery-obligation.test.ts) | 源码；本轮未对客户重新编译 / admission |
| 精确验证与 completion | 执行期间绑定 reviewed blueprint；local evidence、reviewer evidenceId 与 customer external acceptance 分层；DEFERRED 未被当作客户 PASS | [runtime-adapter](../../packages/development-guardian/delivery/runtime-adapter.ts)、[blueprint](../../packages/development-guardian/delivery/verification-blueprint.ts)、[completion gates](../../packages/development-guardian/delivery/staged-verification.ts) | 源码；真实客户 completion 未证明 |
| Owned implementation checkpoint | 受信 host 能发一次性进程内 proof；校验树 / parent / scope，持久化新观察并撤销旧验证投影 | [owned-checkpoint](../../packages/development-guardian/work-session/owned-checkpoint.ts)、[运行文档](../runtime/owned-implementation-checkpoint.md)、[obligation tests](../../tests/delivery-obligation.test.ts)，`34b6ac8` 后 | 源码及文档；不补历史 ownership |
| Reviewer 输出遗漏处理 | PASS 遗漏 assertion verdict 时在同一仓库状态重试一次；仍缺失或发生 drift 则阻塞 | [review-dispatcher](../../packages/development-guardian/work-session/review-dispatcher.ts)、[reviewer tests](../../tests/reviewer-runtime.test.ts)，`ad26456` | 实际阅读最新实现 / commit；未执行测试或模型 |

## 最近相关提交（本轮实际读取 Git）

日期均为 +08:00；完整内容用 `git show <sha>` 复核，commit 标题不构成验收证据。

| commit / 日期 | 改动方向 | 对交接的影响 |
| --- | --- | --- |
| `ad26456` / 2026-10-01 | reviewer 遗漏 verdict 重试一次 | 不能再按旧版本认为一次遗漏必然立即终止；没有真实重试成功证明 |
| `6251690` / 2026-10-01 | 重启后重新打开页面要求 browser proof | 后端持久化证明不能替代页面证明 |
| `1590bb4`、`9542d0d` / 2026-10-01 | 无第三方 / cloud-free 及 reopened page 分类为外部证明 | scope 声明不直接变产品 PASS |
| `d3b859e` / 2026-10-01 | zero-inspection turn 用 fresh thread 重试一次 | 标题 / 当前 Executor 代码是实现线索，非模型可靠性结论 |
| `e2a492a`、`6e1895b` / 2026-10-01 | review findings 反馈实现者；外部 handoff 限于仓库准备 | 技术输出、外部验收各有边界 |
| `1ca5acf`、`c08c74b`、`6e3ecb3` / 2026-09-30 至 10-01 | package runner 覆盖 / scoped tests / native SQLite 依赖 | 不直接复用旧版“没有 contributor verifier”的能力判定 |
| `2be5345` / 2026-09-29 | exact task diff review 与两任务 fixture | fixture 不能证明客户真实交付 |
| `34b6ac8` / 2026-09-29 | owned checkpoint handoff | 历史会话 predates 此协议 |

## 实验和测试：历史结果与本轮检查分开

| 来源与时间 / 版本 | 保存的结果 | 本轮实际检查及限制 |
| --- | --- | --- |
| [Product Acceptance Audit](../plan/NovaWing-v0.5-Requirement-001-Product-Acceptance.md)，2026-09-26，基线 `7f85eb7` | deterministic PASS / semantic 产品验收 FAIL；6 个 criterion 均有弱证明 | 读取失败报告；没有重生成，不能抹去失败 |
| [Planning Quality Hardening](../plan/NovaWing-v0.5-Planning-Quality-Hardening.md)，记录于 `1d3ee51`，2026-09-27 | 报告称全量 check PASS（1,214 Node / 193 desktop）；最终五次规划均 deterministic PASS、semantic PASS、`needs_customer_input` | 本轮核对 [manifest](../plan/benchmarks/requirement-001-phase1-hardening/manifest.json)：输入 1、group 2、run 文件 20，共 23 SHA-256 全匹配；未重跑、未独立重审五份业务语义 |
| [Real Customer Decisions](../plan/NovaWing-v0.5-Requirement-001-Real-Customer-Decisions.md)，2026-09-27 | v2 规划 PASS、25/25 MUST、等待批准；曾修复超时 | 当时“未冻结 / 未启动”的描述是阶段性历史，后续 snapshot / session 已存在 |
| [Phase 6 Audit](../audit/NovaWing-v0.5-Phase-6-Verification-Blueprint-Audit.md)，compiler phase6.0，`e6b04d9`（2026-09-28） | 78 unresolved、63 external binding，admission BLOCKED；报告称 1,239 package / 193 desktop tests PASS | 读取报告；计数是 binding 维度，不能拿来替换 model 2 的唯一 obligation 数；未重跑 |
| [v0.1/v0.2 benchmark](../benchmark/NovaWing-v0.1-v0.2-Benchmark.md)，2026-09-08，`648d11c` | scripted provider 控制面比较，真实模型成本 / token KPI UNAVAILABLE | 读取方法；不能宣称已证明成本优势 |
| [v0.4 closure](../audit/NovaWing-v0.4-Closure.md)，`a7b3fac`，2026-09-25 | Windows 发布更新报告 PASS；macOS native notification 需签名验证，Developer ID / notarization DEFERRED | 读取报告；没有当日 real-host / 安装包复测 |

本轮没有运行 `npm run check`、focused tests、桌面 smoke、客户脚本或模型 health probe。
当前 HEAD 测试运行结果＝**NOT RUN**；不能将上述历史数量当作当前通过数量。

## 本机持久化观察（实际只读复核）

数据根：`/Users/weijianjun/Library/Application Support/NovaWing`，以下记作 `DATA`。
只读取 delivery JSON，以及 Python SQLite 3.46.0 的 `mode=ro` 连接：
`SELECT run_id, json(snapshot), updatedAt FROM mastra_workflow_snapshot`。
snapshot 是 SQLite JSONB；直接 UTF-8 解码失败不能被误判为数据库损坏。
未通过生产 Runtime reopen、未写 state、未恢复或启动会话、未核验运行中进程 / UI。

### Requirement 001

- session ID：`delivery-52c30f357f900d38415ddd96ef8ff4999b95228aa41aff1d3f15e1f42c6ae244-000000000000-52c30f`。
- 来源：`DATA/delivery/session-<session ID>.json`、`DATA/work-sessions/<session ID>.db`。
  snapshot `080d2835-5f35-4311-acb5-7424b5a17607`；runtimePlanHash
  `cdb0d3dc08991b1c2c70492ad34f4a4a4ba005492c81a9437cd7df6822f7089b`。
- plan JSON 保存的 model 2 admission＝READY（2026-09-28 11:21:42Z），session binding＝STARTED。
  DB 最后更新时间 `2026-09-28T16:17:41.107Z`；workflow / T1＝SUSPENDED，action＝RECONCILE，
  generation＝3；humanRequired reason＝`repository changed during action`；完成任务 0、checkpoint map 空，
  T1 未保存 ownedCheckpoints。
- frozen baseline `4b0b9bf535d3aab909b67561d5a24953cf925a2e`；T1 git observation 为
  `e47d7ddec61d83083a393b0696ac1e556e25617b`。本轮目标仓库只读 Git 显示该 HEAD、
  `experiment/requirement-001` 分支，存在修改 / 未跟踪文件；没有审计业务内容。
- 另有 `DATA/delivery-failure-evidence/20260928-requirement-001-first-start/`：保存 TIMEOUT /
  INTERRUPTED_STARTING；不能被后来的 STARTED 覆盖成“首次启动无失败”。
- 与 [owned checkpoint 文档](../runtime/owned-implementation-checkpoint.md) 的历史 incident 相符；
  旧 workspace 文档的 REVIEW 暂停描述不是最新 DB action。历史所有权修复路径仍未证明。

### Requirement 002

- session ID：`delivery-27e04c22735cd3d8d848f4b09004fc5b76201d71a750a5ac2d76384194b88f1e-000000000000-27e04c`。
- 相同定位模式；snapshot `d08498b6-e81f-4afc-b7a9-4c0f96bbef67`；runtimePlanHash
  `056f0c790268bfed5cba66d92f9fc8f74bf9adb9fdd46ab3ce1afebb1c4480c4`。
- plan JSON 保存的 admission＝ADMISSION_BLOCKED / TASK_NO_BLOCKING_ASSERTION
  （2026-09-29 15:05:24Z），session binding＝STARTED（2026-09-30 02:51:41Z）。两份记录有阶段差异；
  本轮未重建启动时 readiness，不能推定非法绕过，也不能声称当前 READY。
- DB 更新时间 `2026-09-30T07:54:07.177Z`；T1＝SUSPENDED、action＝SUSPEND、generation＝2；
  reason＝`No safe task-local contributor verifier is available.`；完成任务 0、checkpoint map 空。
- 目标 baseline / 本轮目标 Git HEAD＝`8ddb8101512747b214d8eb146f4bdd5e3fd8e4c9`，
  分支 `experiment/requirement-002`；本轮 Git 显示未跟踪的实现 / 归档文件。没有打开归档或执行代码。
  9/30 后 verifier 修复是否能处理这份具体任务仍待核实。

两份 `json(snapshot)` 原始返回文本的 SHA-256（只用于重读比较，不是业务验收哈希）：

| 会话后缀 | SHA-256 |
| --- | --- |
| `52c30f` | `df3e66b76b1e7b4970e74b46409d9c61bf76b84041b9dab8c3ee15eaaec499aa` |
| `27e04c` | `d1eda7b2019cc71b75d584aed62070308c3f215142ee5eb81a011618b1266fd5` |

以上是指定数据根的持久化观察，不保证没有其他数据根、其他主机或尚未持久化的执行。
`STARTED`、保存的 READY、实现 commit、全量测试 PASS 都不等于客户验收成功。
本轮未找到能证明这两次客户交付成功的完整证据链。

## 进行中、阻塞与下一步

- 本轮进行中的工作只有 Project Context 文档交接；没有恢复客户任务。
- 两次已保存实验均停在首任务；原会话问题和新代码修复后的可恢复性必须分别证明。
- 最新 HEAD 的全量 / targeted tests、真实 provider 可用性、外部 UI / 平台验收、真实成本效益待核实。
- 下一轮优先只读：明确目标是正常新路径验收、Requirement 001 历史事件处理，还是
  Requirement 002 verifier 适配；核对部署版本、实际数据根、目标工作区和证据 lineage。
  任何模型调用、恢复、真实交付、客户状态改动均需本轮任务契约中的权限与预算。
- 再按用户批准的范围补最小的独立证据；不要先修改 frozen assertion、人工答案、历史 snapshot
  或 completion 投影以追求绿灯。详细未知项见 [问题记录](FAILURES_AND_OPEN_QUESTIONS.md)。

## 本轮文档验证

8 个新增文件的 165 个本地 Markdown 链接均解析到现存文件 / 目录；检查了新增文件的空白格式。
两份 workflow snapshot 在完成文档后只读重查，文本摘要仍与上表一致。
仅扫描新增材料：未发现密钥值、邮箱、私钥或赋值型凭据；`sk-` 扫描命中的是现有
`task-retry-reconciliation` 文档路径，人工确认非密钥。未复制配置、数据库、客户原文或个人信息。
最终变化只含根 CLAUDE.md 和本目录七份 Markdown；运行测试和真实模型实验均未执行。
