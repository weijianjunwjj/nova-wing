# NovaWing v0.1 vs v0.2 Architecture Retrospective

> 复盘基线：`v0.1.0-work-session-mvp`（`04fa262`）对比 `v0.2.7`（`61f061`，当前 `main`）。
> 复盘日期：2026-09-13。
> 范围：只读架构、源码、测试、基准和历史 Work Session 证据；不包含实现、数据修复或版本发布。
> 版本口径：仓库根 `package.json`/README 仍标记 NovaWing domain kernel 为 `0.1.0`；本文的 `v0.2.7` 指 Development Guardian / Work Session control plane 发布标签，不应误写成整个 NovaWing domain kernel 已升级到 0.2.7。

## 1. Executive Summary

结论不是“v0.2 做错了”，而是“v0.2 把正确的安全能力放到了过宽的常驻路径上”。

v0.2 相比 v0.1 的实质进步包括：结构化 `TaskStateV2`、Acceptance Criterion 到确定性证据的绑定、仓库现实优先的 reconciliation、能力型 agent 选择、独立 reviewer、provider health、动作预算、无进展/循环检测、Human Required、Runtime Repair、可审计事件和更严格的完成权。这些能力提高了失败可解释性、恢复性和安全边界，方向正确。

但 v0.2.7 的低风险简单任务仍必须穿过统一的 Observe → Decide → Route → Persist 循环。一个成功的最短路径至少经历 3 次 Controller 决策（EXECUTE、VERIFY、COMPLETE）、2 次 agent dispatch、5 次仓库现实检查；默认生产实现中，每次现实检查又会启动 4 个 Git 命令并计算工作区 fingerprint。与此同时，Launchpad 在缺少显式证据绑定时倾向把任务级验收标准修复为根级 `npm test`。这不是“安全检查太多”这么简单，而是缺少一个能选择最小充分、任务相关验证集的 Verification Planner。

历史证据说明了两面：GOLDEN-001、REAL-001 可以正确完成；GOLDEN-002 因“无变化但必须提交”在 Task 已完成后让 Session 失败；GOLDEN-003 因路径名触发高风险 review 且 reviewer 不可用而悬停；REAL-002 的代码已完成并提交，却因无关 PostgreSQL 测试环境形成 10 次 EXECUTE + 10 次 VERIFY；REAL-003 在 v0.2.7 已避免重复执行，但仍因同一错误验证绑定停在环境阻塞。v0.2.7 修复了循环放大器，没有修复验证选择的根因。

因此推荐方案 B：保留 v0.2 的 Task Contract、证据权威、状态连续性和所有安全网，但新增真正的一等 Direct Path：

`Task Contract → Verification Plan → Execute → Verify → Commit`。

仅在验证失败、风险升级、provider 异常、repo drift、状态不一致、权限/审批或无进展时进入完整 Controller 循环。它不是回滚到 v0.1；v0.1 事实上也不轻——正常完成需要 Brain 前审、Executor、Brain 终审，至少 3 次模型角色调用。目标应是“v0.2 的证据内核 + 更短的常规执行主干”，而不是恢复 v0.1 实现。

## 2. v0.1 实际架构

v0.1 的真实路径不是通常想象的 `Executor → Verify → Reviewer`。`guardian.ts` 的循环在执行前先调用 Brain review；有 Executor report 后再调用 Brain final review。只有 Brain 返回 `done`，且存在最后一次报告、所有确定性验证通过、没有 blocker/incomplete reason，任务才完成。否则才继续调用 Executor。

典型成功路径是：

`WorkSession → Brain/Reviewer（首次决策）→ Executor（执行并内含 verification）→ Brain/Reviewer（终审）→ Safe Git Checkpoint → Completed`

v0.1 已经拥有的能力：

- GuardianTask / WorkSessionTask 模型、Brain 完成权与 Executor 路由；
- Codex / DeepSeek 选择、preflight、失败恢复、暂停/恢复和 Human Required；
- Executor report 内的 deterministic verification；
- Mastra + LibSQL durable workflow state、execution ledger；
- 严格的 safe git checkpoint：只有 `done`、无 blocker、验证全通过且命令证据完整时才允许提交；
- 本地控制台、通知、失败分类和恢复检查点。

所以 v0.1 不是薄脚本。它的问题是角色语义较粗、验证由 Executor report 携带、Brain 既负责规划又握有终局权，且简单任务也固定支付两次 Brain 模型调用。它的优点是控制流程线性、实现路径短、认知负担较低。

## 3. v0.2.7 实际架构

v0.2.7 把执行拆成明确的控制平面：

`Launchpad/Contract Preflight → TaskStateV2 → Repository Observe/Reconcile → TaskController Decide → Capability Select → Action Dispatcher → Repository Observe → Apply Result → Persist/Event Log → Repeat → Completion Gate → Git Checkpoint`

`TaskStateV2` 保存 goal、constraints、acceptance criteria、permissions、progress、artifacts、git reality、verification bindings/results、completion evidence、review/approval、provider history、当前 agent/action/risk/blockers、convergence history 和 action budget。`TaskController` 可以产生 ANALYZE、EXECUTE、VERIFY、REVIEW、REQUEST_APPROVAL、RECONCILE、SUSPEND、COMPLETE。

当前策略并非“每个任务强制 reviewer”：低/中风险任务验证通过后可直接 COMPLETE；HIGH 才 REVIEW，CRITICAL 或显式策略才 REQUEST_APPROVAL。独立 Review Dispatcher 是 provider-neutral、read-only，并在 review 前后检查仓库，保证 reviewer 不修改代码。

生产执行中 EXECUTE 和 VERIFY 都经过 ExecutorRouter。VERIFY 会运行去重后的 `git diff --check` 与所有 evidence binding 命令；只重试失败的验证命令。每次 loop 前后又会检查 repo reality。Runtime Repair、analytics 和通知被接入 WorkSession，但 Runtime Repair 只有显式触发时执行，analytics 只在终态投影，通知只在 Human Required / terminal 等条件触发；它们不是简单任务时延的主要来源。

## 4. 两条最短成功路径

### v0.1 简单任务

`Claim/Persist → Brain review → Executor + verification → Brain final review → Git checkpoint → Persist terminal state`

最低主要调用：2 次 Brain 模型调用、1 次 Executor 模型调用/进程、每条 verifier 命令的子进程、Git finalizer。若 Brain 不接受或 Executor 不完整则按迭代上限循环。

### v0.2.7 低风险简单任务

`Preflight → Observe → Decide EXECUTE → Persist → Route/Execute → Observe → Persist → Observe → Decide VERIFY → Persist → Route/Verify → Observe → Persist → Observe → Decide COMPLETE → Persist → Git checkpoint`

最低主要调用：1 次 Executor 模型调用；通常无 reviewer 模型调用；若自然语言 Task 缺少 binding，常见还会有 1 次 LLM preflight repair。Runner 内至少 3 次决定、2 次 dispatch、5 次 repository inspection、约 5 次 TaskState 持久化；外围 WorkSession/ledger 还有额外写入和 Git finalizer。

这解释了一个看似矛盾的事实：v0.2 可以减少模型 review 次数，却仍让用户感觉“更慢、更复杂”。节省的是模型审查，增加的是流程往返、Git 子进程、状态写入、验证范围和失败分支。

## 5. v0.2 新增层清单

1. Task Contract schema 与 contract preflight。
2. Deterministic/LLM Preflight Repair 与 repair audit。
3. `TaskStateV2` 持久状态模型。
4. Repository Reality inspection、fingerprint 与 reconciliation。
5. `TaskController` 决策机。
6. Risk assessment 与 completion gate。
7. Capability-based agent selection。
8. ExecutorRouter、provider health、failover/handoff。
9. 显式 Verification action 与 evidence binding。
10. 独立 Review Dispatcher / reviewer registry。
11. Approval / Human Required 协议。
12. Action budget、no-progress 和 cycle detection。
13. Runtime Repair & Resume。
14. Task event log、execution ledger、analytics projector。
15. Control UI/SSE projection、provider/reviewer/activity 展示。
16. 多渠道 notification。
17. Certification、scenario matrix、migration/boundary/pack gates。

## 6. 各层价值与成本

| 层 | 主要价值 | 主要成本 | 判断 |
|---|---|---|---|
| Task Contract / AC | 把“完成”变成可检查约束 | 创建和修复合同的前置复杂度 | 保留并简化 |
| Evidence binding | 防止只凭模型口头宣告完成 | 绑定错误会系统性执行错误测试 | 核心保留，规划器 P0 |
| TaskStateV2 | 可恢复、可审计、跨 action 连续 | 字段和写入频率偏多 | 保留最小内核 |
| Repo reality / reconciliation | 仓库事实胜过陈旧状态 | Git 子进程和全量 fingerprint 税 | 边界保留，频率下调 |
| Controller | 统一失败、风险、审批和恢复策略 | 成功路径也被迫循环 | 改为升级路径 |
| Router / provider health | 故障切换和能力匹配 | 多一层身份与状态投影 | 保留，单次选路后粘滞 |
| Explicit verifier | 验证独立于实现者，证据更可信 | 多一次 dispatch；错误计划代价很高 | 保留 |
| Independent reviewer | 高风险时职责分离 | reviewer 可用性、误触发和模型时延 | 条件安全网 |
| Approval / Human Required | 权限边界和安全停机 | 状态机、恢复协议复杂 | 条件安全网 |
| Loop guards | 防止无限重试 | 需要维护 convergence history | 保留为异常护栏 |
| Runtime Repair | provider/reviewer 异常可恢复且不重跑 Executor | 审计、通知、状态迁移面扩大 | 条件安全网 |
| Analytics / notification | 运营与可解释性 | 存储/UI 代码量 | 观测层，fail-open |
| Certification | 防止跨层回归 | 测试维护和 Windows 清理噪声 | 发布基础设施，不进运行主干 |

## 7. Control-plane tax

### 静态最低成本

对一个合同完整、低风险、一次实现成功的任务，v0.2.7 Runner 至少有：

- 3 次 Controller 决策：EXECUTE、VERIFY、COMPLETE；
- 2 次路由/dispatch：实现与验证；
- 5 次 `inspectRepository()`：每个 action 前后各一次，终局决定前再一次；
- 生产 `inspectRepository()` 每次启动 branch、HEAD、status、cached diff 4 个 Git 命令，即仅 loop 现实观测约 20 个 Git 子进程，外加 fingerprint 文件扫描；
- EXECUTE 和 VERIFY dispatch 前各有一次额外 `git status` / checkpoint fingerprint；
- Runner 内至少 5 次 TaskState 写入，外加 WorkSession snapshot、ledger/event 和 terminal 持久化；
- verifier 每个唯一命令一个进程，`git diff --check` 还有安全 index 处理；
- 完成后的 safe git checkpoint 继续执行 status、diff、stage、验证、commit、rev 等 Git 命令。

这个数字是源码下界，不等于真实 wall-clock 精确计量；但足以说明常驻架构税的位置。v0.1 也有持久化、verification 和 Git finalizer，但没有每个 action 前后都进行同级别 reality loop。

### 模型调用税

- v0.1 正常成功：Brain 2 次 + Executor 1 次。
- v0.2.7 合同完整且低风险：Executor 1 次，无 reviewer。
- v0.2.7 合同缺 binding：常见增加 1 次 LLM preflight repair；高风险增加 reviewer；异常时进入更多 action。

因此不能简单说 v0.2 “模型调用更多”。真正问题是：它在模型调用可能更少的同时，把所有任务都放进高频控制循环，并且验证规划错误会把昂贵的无关测试变成必经路。

### 正常与最坏成本

v0.2 默认 original action budget 20，recovery budget 4。v0.2.7 的 no-progress 与 cycle detection 已能提前截断常见重复执行，但设计容量仍允许异常任务进行大量 observe/route/persist。REAL-002 在修复前实际达到 22 次 Controller decision、20 次 dispatch；这是控制面把一个错误 verifier 结论放大的真实例子。

## 8. Verification planning 根因分析

REAL-002/003 的主因排序如下：

1. **Task Contract / evidence binding 选择错误（根因）**：Launchpad 对默认“运行相关确定性测试”的绑定，在没有显式 relevant commands 时回退到根级 `npm test`。
2. **缺少 task-local Verification Planner（结构根因）**：系统只验证“命令存在、受信、可执行”，没有验证“该命令是不是这条 AC 的最小充分证据”。
3. **Preflight Repair 的约束强化了错误（重要放大因素）**：deterministic/LLM repair 的候选命令主要来自根 package scripts 和受信全局命令，历史 repair audit 显示多个 AC 被统一修复到 `npm test`。Repair 让合同合法，却没有让合同相关。
4. **Verifier 按合同正确执行（非根因）**：它忠实运行所有唯一 binding，行为本身符合设计。
5. **Controller 曾放大错误（次要、v0.2.7 已部分修复）**：REAL-002 把环境失败反复带回 EXECUTE；v0.2.7 已让 ENVIRONMENT 直接 SUSPEND，并以 no-progress guard 防止 executor 重跑。REAL-003 证明循环问题缓解，但错误 binding 仍未解决。

所以不应把修复写成“把 `npm test` 换成某个硬编码命令”。应引入 planner，为每个 AC 选择最小充分证据，并把相关性作为 preflight 的一等验证条件。

建议 Verification Plan 至少包含：受影响范围、候选测试、选择理由、覆盖的 AC、预计依赖、环境前提、失败分类和 fallback。默认顺序应是 changed-file/task-local test → package-local test/typecheck → root suite；只有跨包、公共契约或发布级风险才升级到全仓测试。

## 9. Review / provider / UI projection

### Reviewer 语义

Controller 的语义基本正确：低/中风险不要求独立 review，HIGH 才 REVIEW，CRITICAL/策略要求才审批。问题有两个：

- 风险分类用文件名/路径启发式，`ticketsApi.ts` 因 `api` 命名可触发 public API HIGH，GOLDEN-003 因而需要 reviewer；这是风险误报，而不是 reviewer 层本身错误。
- reviewer 不可用时任务安全悬停是合理的，但若误报风险触发，就变成无价值阻塞。

### `REVIEWING` 出现时机

`v2-controller-task-runner.ts` 把 VERIFY 映射为 VERIFYING、REVIEW 映射为 FINAL_REVIEW、EXECUTE 映射为 EXECUTING、RECONCILE 映射为 RECOVERING，而 COMPLETE、SUSPEND、REQUEST_APPROVAL、ANALYZE 等全部落入默认 `REVIEWING`。因此 UI 可以在真正 reviewer dispatch 之前显示 Reviewer 审查。

GOLDEN-003 中有 Controller `REVIEW` 和 `REVIEW_REQUIRED`，但由于无 eligible reviewer，没有 `AGENT_DISPATCHED(REVIEW)`。这说明“进入 review 决策”和“reviewer 已启动”必须分开投影。`REVIEWING` 只能由实际 review dispatch/start 事件驱动；COMPLETE 应显示 FINALIZING/COMPLETING，SUSPEND 应显示 WAITING/HUMAN_REQUIRED。

### provider 投影

无显式 agent 配置时默认 capability profile 把 provider 写成 `codex-or-deepseek`。它是路由能力集合，不是真实 provider。REAL-003 provider health 同时出现该聚合身份与真实 `codex`，容易让 UI、analytics 和用户误判谁真正执行。

应分别建模：`route=executor-router`、`eligibleProviders=[codex, deepseek]`、`selectedProvider=codex`、`runtimeIdentity=...`。界面只把 selected/actual provider 显示为“执行者”；候选路由留在调试信息。

## 10. REAL / GOLDEN 历史任务复盘

| 任务 | 结果与时间 | 实际路径 | 是否正确收敛 | 架构信号 |
|---|---|---|---|---|
| GOLDEN-001 | COMPLETED，约 1m45s active | 1 EXECUTE + 1 VERIFY + 3 decisions，0 review | 是 | 低风险 happy path 可工作 |
| GOLDEN-002 | TaskState COMPLETED，但 Session FAILED，约 25m48s active | 1 EXECUTE + 1 VERIFY；无 changed files；Git commit 阶段失败 | 否 | no-op/already-satisfied 与强制 autoCommit 契约冲突 |
| GOLDEN-003 | SUSPENDED，约 5m02s active | 1 EXECUTE + 1 VERIFY；HIGH review；无可用 reviewer；后续 repo drift | 否 | 风险启发式误报 + reviewer 可用性使已验证实现无法完成 |
| REAL-001 | COMPLETED，约 5m36s active | 1 EXECUTE + 1 VERIFY + 3 decisions，0 review；4 files；本地 commit | 是 | 正常真实任务闭环成立 |
| REAL-002 | SUSPENDED，约 43m04s active | 22 decisions；10 EXECUTE + 10 VERIFY；3 Human Required | 否 | 代码首轮已完成，根 `npm test` 撞 PostgreSQL；旧 Controller 重复执行放大错误 |
| REAL-003 | SUSPENDED，约 3m56s active | 1 EXECUTE + 1 VERIFY；环境失败后悬停；恢复后 REQUEST_APPROVAL | 部分改进但未收敛 | v0.2.7 阻止重跑 Executor，但 verification plan 仍错 |

额外仓库事实：REAL-002 的筛选实现已形成提交 `ce56248`；REAL-003 的计数 UI 与定向测试仍作为两文件工作区修改存在。两者都支持“业务实现已完成，NovaWing 控制面没有完成闭环”的判断。

REAL-002/003 的 root `npm test` 均在大量 API 测试中因 `127.0.0.1:5432` PostgreSQL 不可用失败，最终约 315 errors；与前端筛选/计数任务的局部正确性无直接关系。用户在 REAL-002 的恢复决策中明确要求保留当前实现、只做任务局部验证且不要重跑 Executor，旧路径仍重复执行，说明当时 Human decision 没有成为强约束。v0.2.7 convergence regression 已覆盖“一次 EXECUTE + 一次 VERIFY 后 ENVIRONMENT_REQUIRED，不再重复”的形状，但这是合成防回归，不代表历史 Session 被自动修复。

## 11. Benchmark 复盘

冻结基准（2026-09-08）包含 16 个 catalog task、9 个执行任务、v1/v2 共 18 个有效 run，使用相同 scripted provider，不调用真实 LLM。

主要结果：

| 指标 | v0.1 | v0.2 | 含义 |
|---|---:|---:|---|
| completion rate | 8/9 = 88.9% | 8/9 = 88.9% | 没证明完成率提升 |
| first-pass success | 6/9 = 66.7% | 6/9 = 66.7% | 没证明一次成功率提升 |
| controller decisions / task | 2.11 | 3.33 | v2 控制往返更高 |
| agent/work dispatch / task | 1.22 | 2.33 | v2 拆分 execute/verify |
| verification / task | 1.22（折叠在 execute） | 1.11（显式） | 语义更清晰，不代表更快 |
| review / task | 2.11 | 0 | v2 低风险避免 reviewer |
| task events / task | 8.67 | 12.22 | 可观测性提高，也增加状态面 |
| control-plane mean duration | 0.267ms | 0.480ms | 只测内存控制代码，不能代表真实耗时 |

基准支持的结论：v2 在低风险任务中显著减少 reviewer，增加了结构化 action/event；未提高该样本的完成率或 first-pass success。

基准不支持的结论：不能据此声称 v2 更快、更便宜或 handoff 更好。harness 的 repo inspection 是内存函数，v1 Brain 是 scripted，未计入真实模型延迟、Git/process 启动、文件 fingerprint、真实 verifier、provider 切换和数据库写入。速度/成本/handoff KPI 仍缺生产级测量。

## 12. v0.1 与 v0.2 对照判断

| 维度 | v0.1 | v0.2.7 | 判断 |
|---|---|---|---|
| 主干长度 | 线性，但固定两次 Brain | 模型 review 更少，但控制循环更长 | 都非理想；目标是第三种路径 |
| 完成权 | Brain + deterministic evidence | Completion gate + evidence binding + risk policy | v2 更强 |
| 验证 | Executor report 内聚 | 独立 action、可绑定 AC | v2 方向正确，planner 缺失 |
| 恢复性 | 有 pause/resume/checkpoint | 更完整的 reconciliation、repair、event history | v2 更强 |
| provider | 路由存在但角色耦合 | capability/provider health/reviewer registry | v2 更强，投影需修 |
| 认知负担 | 较低 | schema/action/projection/repair 层很多 | v2 偏重 |
| 简单任务效率 | 两次 Brain 昂贵 | Git/状态/路由往返昂贵 | 应融合优点而非二选一 |
| 失败安全 | 有证据和 checkpoint | 更细分类、fail closed、loop guard | v2 更强 |
| 实证收敛 | 基准相同完成率 | 真任务暴露 planner/commit/review 问题 | 尚未证明净收益 |

## 13. “v0.1 主干 + v0.2 安全网”假设

判定：**PARTIALLY_SUPPORTED**。

支持部分：用户直觉准确识别出 v0.2 的安全能力不应全部常驻。TaskState、reconciliation、review、approval、runtime repair、provider failover、循环防护都更适合作为升级网。

不支持部分：不应字面恢复 v0.1 主干。v0.1 主干含两次 Brain review，verification 又与 Executor report 耦合；这会重新引入昂贵审查和完成权模糊。真正应保留的是 v0.1 的线性拓扑，而不是 v0.1 的角色实现。

更准确的假设是：**“v0.1 的线性拓扑 + v0.2 的合同、证据和安全边界”**。

## 14. 建议目标架构

建议采用双通道：Direct Path 是默认执行通道，Controller Loop 是异常/高风险升级通道。二者共享同一 Task Contract、TaskState 最小内核、evidence model 和 completion authority，避免平行实现分叉。

```text
Launchpad
  → Task Contract
  → Contract Preflight
  → Verification Planner
  → Risk / Permission Fast Gate
      ├─ eligible for direct path
      │    → select implementer once
      │    → EXECUTE
      │    → VERIFY planned evidence
      │    → completion gate
      │    → safe git checkpoint
      │    → COMPLETED
      └─ escalation required
           → Observe / Reconcile
           → Controller Decide / Route / Persist
           → Review / Approval / Repair / Retry / Human Required
           → rejoin completion gate when resolved
```

关键约束：Direct Path 不是绕过安全，而是把成功路径编译成一次明确计划；任何现实偏差都立即提升到 Controller。Controller 不再为每个正常状态转换做解释性决策。

## 15. Happy Path 设计

Direct Path eligibility：

- Task Contract 完整、每条 AC 有相关且允许执行的 evidence binding；
- Verification Planner 置信度达到阈值，无未知环境依赖；
- 风险 LOW/MEDIUM，未触及安全、数据库迁移、公共 API/兼容性、凭据、部署或其他策略边界；
- repo/branch/workspace 与 Session 创建时一致，无已有冲突或未归属 drift；
- provider 可用，权限足够，无显式审批要求。

执行时：

1. 起点检查一次 repo identity/status/fingerprint，生成 execution checkpoint。
2. 选择一个 implementer 并在 Direct Path 内保持粘滞，不重复经过 Router。
3. 执行一次。
4. 终点检查 changed files/HEAD，运行 planner 产生的最小充分 verifier 集。
5. evidence 全通过后由统一 completion gate 判断。
6. 有实际变更则安全提交；任务已满足且无变化时记录 `ALREADY_SATISFIED/NO_CHANGE_REQUIRED` 证据，不把它误判为 git commit failure。

成功时 Controller decision count 可以为 0；状态转换由已验证的固定协议完成，而不是由 Controller 模型/策略逐步“决定”。

## 16. Escalation Path 设计

以下任何条件出现即退出 Direct Path，携带已有 checkpoint、实现结果和验证证据进入 Controller：

- verifier 失败或结果无法分类；
- repo drift、branch/HEAD/workspace mismatch；
- changed files 超出计划范围；
- risk 升级为 HIGH/CRITICAL；
- 需要 reviewer、approval 或新增权限；
- provider unavailable/quota/protocol failure；
- Executor 无进展、输出不完整或违反约束；
- 验证环境缺失、命令不存在或 planner 发现计划错误；
- commit/push 失败；
- 用户干预、暂停或恢复。

升级后保留 v0.2.7 的 deterministic-first policy：CODE failure 才允许重新 EXECUTE；ENVIRONMENT/VERIFIER_CONFIG/UNRELATED 不得重跑 Executor；无进展与循环检测继续生效；repo reality 始终覆盖 agent/state 声明。

## 17. Verification Planner 的位置

Planner 应位于 Contract Preflight 之后、任何 Executor dispatch 之前。Preflight 负责“合同结构合法、命令安全”；Planner 负责“证据相关、最小且充分”。二者不能合并成一个模糊的 Repair Agent。

输入：Task goal/AC、目标 repo、changed-area hint、package graph、测试清单、package scripts、历史任务 evidence、环境可用性、风险政策。

输出：

- 每条 AC 对应的 verifier 命令/静态证据；
- 命令的 scope、理由、预计耗时和环境前提；
- task-local → package-local → repository-wide 的升级序列；
- 失败分类规则与需要审批的命令；
- plan fingerprint，供执行后确认代码变化没有使计划失效。

确定性优先：文件邻近测试、package ownership、test import graph、现有 scripts/fixtures。LLM 只做候选排序或解释，最终命令必须通过 allowlist、scope 和环境验证。若 planner 无法给出可信方案，应在执行前 Human Required，而不是先绑定 `npm test` 再让任务付出失败成本。

## 18. KEEP_IN_HAPPY_PATH

- 简化后的 Task Contract：goal、constraints、AC、permissions、risk hints。
- Contract preflight：schema、路径、权限、命令安全检查。
- Verification Planner 与 AC-evidence binding。
- TaskState 最小连续性：身份、状态、checkpoint、implementer、artifacts、verification、completion evidence。
- 起点/终点 repository reality，而非每个 action 前后全量扫描。
- 单次 implementer selection 与路由粘滞。
- 独立 deterministic VERIFY。
- 统一 completion gate 和 safe git checkpoint。
- 最小事件：started、executed、verified、completed/escalated。

## 19. KEEP_AS_FALLBACK

- 完整 Observe → Decide → Route → Persist Controller loop。
- Reconciliation 与 repo drift suspension。
- Provider health、failover、handoff、ownership recovery。
- HIGH independent review、CRITICAL/策略 approval。
- Human Required / pause / resume。
- AI Preflight Repair（仅 planner/合同无法确定时）。
- Runtime Repair & Resume。
- Action budget、no-progress、cycle detection。
- commit/push recovery 与 verification approval。
- ANALYZE action（若保留，应只在合同无法形成计划时使用，不应进入普通运行路径）。

## 20. KEEP_AS_OBSERVABILITY

- Execution ledger、Task event log、activity timeline。
- Task-run analytics 与 benchmark/certification 报告。
- Provider health、实际 selected provider、reviewer identity 的只读展示。
- Heartbeat/quiet detection。
- Human Required、Completed、Failed、Recovery Required 通知。
- Repair audit、migration/pack/boundary gates。

观测层必须 fail-open；写 analytics、发送通知或 UI projection 失败不得改变任务完成真值。

## 21. REMOVE_OR_SIMPLIFY

- 删除 `provider=codex-or-deepseek` 这种伪执行者投影；router 与 actual provider 分离。
- 删除 Runner 对非 EXECUTE/VERIFY/REVIEW/RECONCILE action 的默认 `REVIEWING` 映射。
- 禁止把所有未指定 task-local evidence 的 AC 自动绑定到根 `npm test`。
- 简单成功路径不再每轮 2 次 repository inspection；改为边界检查，异常后才提高频率。
- 合并成功路径上的重复 TaskState/snapshot/ledger 写入，使用有意义的状态边界持久化。
- 让 no-change/already-satisfied 成为合法 completion outcome；不要要求伪造改动来满足 autoCommit。
- 将长期为空的 progress decisions/assumptions/openQuestions 等字段降为可选扩展，而非所有任务的核心负担。
- 明确 `ANALYZE` 的生产职责；若 dispatcher 只会 BLOCKED，则移出运行 action 集或实现为 preflight planner，而不是保留悬空状态。
- 风险分类从路径字符串启发式升级为契约/导出面/语义变更证据，避免 `*Api.ts` 自动等同公共 API。
- 修复 Windows 测试临时数据库 `EBUSY` 清理噪声，避免 certification “通过但反复报清理错误”。

## 22. 架构债务优先级

### P0 — 核心正确性 / 性能

1. Verification Planner：任务相关、最小充分 evidence；禁止无依据 root-suite fallback。
2. Direct Path：成功任务不进入逐 action Controller loop；保留统一 completion authority。
3. 失败分类约束：ENVIRONMENT/VERIFIER_CONFIG/UNRELATED 永不触发重新 EXECUTE，Human decision “verify only/no re-execute” 必须成为硬约束。
4. Resume 语义：环境/命令修复后应恢复 VERIFY，不应无条件落到 REQUEST_APPROVAL；批准必须修复或替换具体 binding。
5. no-change completion：TaskState、Session 和 Git checkpoint 对 `ALREADY_SATISFIED` 达成一致。

### P1 — 正确性 / 性能 / 可观测性

1. 风险分类误报与 reviewer availability policy（GOLDEN-003）。
2. `REVIEWING` 事件时序和 actual reviewer dispatch 投影。
3. router/eligible/selected provider 的身份分离。
4. 降低 repository inspection、fingerprint 与持久化频率。
5. 为真实 wall-clock、模型调用、Git/process 次数、DB 写入和 handoff 建立生产 benchmark。
6. Windows `EBUSY` 临时 DB 清理稳定性。

### P2 — UI / 可维护性 / cosmetic

1. 收缩 TaskState 长期未用字段和重复 projection。
2. 控制台手写字符串/DOM 展示层整理。
3. analytics 命名、provider label、阶段中文文案统一。
4. 通知内容与 UI 状态进一步复用同一 typed projection。

## 23. 三个方案比较

### A. 保持 v0.2.7，仅修 bug

优点：风险最低，已有 85 个 certification scenario 和 8/8 gates；短期可修 verifier fallback、UI label、risk heuristic。缺点：成功路径仍付出统一 Controller loop 税，无法解决“架构过重”的核心问题；错误会反复在新分支上出现。

适合：紧急止血，不适合作为最终架构。

### B. Direct Path + v0.2 Safety Net（推荐）

优点：保留已验证的 v0.2 安全资产；减少正常任务决策、扫描、路由和写入；不恢复 v0.1 的两次 Brain review；可通过 feature flag/eligibility gate 渐进启用。缺点：需要明确双通道不分叉、统一状态/证据/完成权，并补真实 benchmark。

适合：下一版本的主线。

### C. 回退/重写为 v0.1 风格

优点：表面简单、理解成本低。缺点：丢失 TaskStateV2、reconciliation、provider/reviewer 分离、精细失败分类和修复资产；v0.1 自身仍有两次 Brain 模型调用和 verification 耦合。大重写会制造新回归，且与证据不匹配。

适合：不推荐。

## 24. 最终建议

选择 B，但分两步落地：先把 Verification Planner、失败分类硬约束、no-change completion 和 UI/provider truth 修成可靠基础；再以 feature flag 引入 Direct Path，并要求同一批任务在 v0.2.7 loop 与 Direct Path 间做可重复 A/B。

架构成功标准不应是“层更少”，而应是：

- 简单任务 1 次 execute + 1 次 task-local verify 即收敛；
- 成功路径不调用 Controller 决策或 reviewer；
- 仓库检查从约 5 次降到 2 次边界检查；
- 无关环境失败不会重跑 Executor；
- already-satisfied 不会因无 commit 失败；
- 高风险/异常任务仍能完整进入 v0.2 安全网；
- UI 只显示已实际发生的 reviewer/provider/action；
- 真实 completion/first-pass 不低于现基线，p50/p95 wall-clock、进程数和状态写入显著下降。

不建议现在进入 Desktop v0.3。当前问题位于执行内核和完成闭环；先做桌面层会把错误 verification、状态投影和恢复语义固化成 UI 契约，增加迁移成本。

## 25. 下一版本建议

下一版本应定义为一次 **Architecture Convergence / Direct Path** 版本，而不是继续横向增加 orchestration 能力。建议范围严格限定为：

1. Verification Planner 与 relevance-aware preflight。
2. Direct Path eligibility + fixed protocol + escalation seam。
3. no-change/already-satisfied completion。
4. environment/config/unrelated failure 的不可重执行约束与正确 resume target。
5. reviewer/provider/phase truthful projection。
6. 真实 A/B benchmark：至少覆盖单文件 UI 文案、前端交互+定向测试、逻辑+定向测试、失败后修复、中型多文件和高风险变更；记录模型调用、process、Git inspection、DB writes、wall-clock、人工介入和收敛结果。

不要在该版本同时扩展 Desktop、更多 provider、更多 repair 类型或新工作流。先证明 NovaWing 能以更短主干完成普通任务，并在异常时无损升级到现有安全网。

---

CURRENT_V0_2_ARCHITECTURE: OVERWEIGHT
V0_1_TO_V0_2_DIRECTION: PARTIALLY_CORRECT
DIRECT_PATH_RECOMMENDATION: YES
VERIFICATION_PLANNER_PRIORITY: P0
DESKTOP_V0_3_NOW: NO
RECOMMENDED_NEXT_STEP: 先交付 Verification Planner 与 feature-flagged Direct Path，并用 REAL/GOLDEN 同型任务做真实 A/B 收敛验证后再进入 Desktop v0.3。
