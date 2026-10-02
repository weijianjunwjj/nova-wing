# 原则、决策和实际缺口

核查基线：`ad26456`，2026-10-02。规则声明、历史设计和当前实现分别注明。
详细实现索引见 [ARCHITECTURE](ARCHITECTURE.md)，历史运行证据见 [CURRENT_STATE](CURRENT_STATE.md)。

## 产品目标与演进

用户本轮目标是模型可替换的 AI 研发 Agent Harness，以可控成本完成真实交付。这是本轮明确
给出的定位，不能反推为已实现全部目标或已证明成本优势。
[PRD v0.1](../prd/NovaWing-PRD-v0.1.md)（2026-07-24）和
[System Design v0.1](../design/NovaWing-System-Design-v0.1.md) 的定位是个人主线记忆内核，
设计还把独立客户端 / 进程 / 端口列为 v0.1 非目标；当前仓库已有 Guardian、Launchpad 和 Electron。
这是版本范围差异和总规格未统一的事实，保留原文，不擅自改冻结 PRD。

跨项目职责按 [AGENTS.md](../../AGENTS.md) 执行。当前仓库内部的编码执行 adapter 属于
Harness 实现，不代表获准接管 cc-auto 的跨项目职责；完整集成分工需要可访问的永久协议与
项目证据。本轮指定 Windows 永久记忆路径缺失，没有补造其中决定。

## 重要决定、理由与核查

| 决定 / 约束 | 理由及实现证据（均为本轮源码 / 文档只读） | 缺口或适用限制 |
| --- | --- | --- |
| 人工批准后才进入 Core context；追加式主线、revision CAS | 防止未确认推断变正式知识；[Facade](../../packages/core/src/facade.ts)、[SQLite store](../../packages/sqlite/src/sqlite-nova-wing-store.ts) | 不证明真实 OfferFlow 已消费当前 context |
| draft 是编辑缓冲，不能 approve；宿主直接创建 pending | 消解冻结 PRD 与分步编辑的差异；[ADR 0001](../adr/0001-draft-proposal-state.md) | draft 不能被当作业务审批成功 |
| 显式表 / 组件所有权、组合恢复全有或全无 | 防止跨 authority 覆盖与半恢复；[ADR 0002](../adr/0002-distribution-source-and-host-snapshot-v3.md)、[registry](../../packages/host-snapshot/src/registry.ts) | 具体真实宿主恢复未证明 |
| 私有 GitHub Packages、精确不可变消费 | 授权、许可和可追溯性；[ADR 0003](../adr/0003-private-github-packages-and-immutable-consumption.md) 明确取代公共 Registry 决策 | 本轮没有查远程发布；根 private 不代表历史从未有桌面公开发布 |
| 模型可替换，但 authority 不交给模型 | [ExecutorRouter](../../packages/development-guardian/executor-router.ts)、[TaskController](../../packages/development-guardian/work-session/task-controller.ts)、[workspace tools](../../packages/development-guardian/codex-workspace-tools.ts) 保持权限、持久化和事实检查 | 接口兼容不等于每个模型质量 / 成本均已验证 |
| verification：MUST coverage 加独立 semantic review | ID coverage 能绿灯而业务证明仍弱；[失败审计](../plan/NovaWing-v0.5-Requirement-001-Product-Acceptance.md)、[validator](../../packages/development-guardian/planning/validator.ts)、[semantic-reviewer](../../packages/development-guardian/planning/semantic-reviewer.ts) | semantic PASS 仍可误判；保留独立产品复审，不把语法 gate 当语义证明 |
| admission：Start gate 与 Completion gate 分开 | 避免实现依赖 verifier 尚不存在导致启动死锁，又不降低完成证明；[runtime-plan](../../packages/development-guardian/delivery/runtime-plan.ts)、[staged-verification](../../packages/development-guardian/delivery/staged-verification.ts) | PROVISIONABLE 只是验证义务；provider / target / policy drift 与 UNRESOLVED 仍阻塞；READY 不保证交付 |
| ownership：一个 assertion 的唯一 canonical owner | 避免重复或无人负责；owner 必须由 DAG 唯一确定，CONTRIBUTES 单独证明 technical outputs；[runtime-plan](../../packages/development-guardian/delivery/runtime-plan.ts) | 并行覆盖但无唯一依赖归属会 AMBIGUOUS；不能凭模型指定强行选择 |
| 精确 blueprint 与 evidence lineage | 绑定 frozen assertion/hash、owner、target、commit、artifact、bounded steps、predicate、需要时 reread / cleanup，再独立 review；[blueprint](../../packages/development-guardian/delivery/verification-blueprint.ts)、[adapter](../../packages/development-guardian/delivery/runtime-adapter.ts) | endpoint / test 存在、HTTP 200、exit 0、OBSERVED 不单独证明 expected outcome |
| 本地可推进与客户成功分开 | COMPLETION-only external/human 允许 DEFERRED，但最终需要外部 acceptance；[task/customer gates](../../packages/development-guardian/delivery/staged-verification.ts) | LOCALLY_VERIFIED 可能包含 DEFERRED；不要翻译成“全部业务已通过” |
| host ownership proof，拒绝模型 SHA 或 JSON 认领 checkpoint | host 校验 scope / tree / parent，再一次性进程内 capability 和 durable observation；[owned-checkpoint](../../packages/development-guardian/work-session/owned-checkpoint.ts)、[协议](../runtime/owned-implementation-checkpoint.md) | 历史 descendant commit 没有 accepted transition 不能自动收编；hash 不是授权证明 |
| fail-closed 与有限恢复 | 身份 / evidence 缺失、mutation refusal、review drift、策略改变、预算耗尽等保留阻塞；[workspace 合约](../runtime/workspace-execution-contract.md)、[retry 协议](../runtime/task-retry-reconciliation.md)、[review dispatcher](../../packages/development-guardian/work-session/review-dispatcher.ts) | 不承诺任意 crash 的 exactly-once；receipt 已 claim 但未 dispatch 需人工查明 |
| 成本可控是任务约束 | action budget、timeouts、有限 repair / retry、provider 配置存在；[TaskStateV2](../../packages/development-guardian/work-session/task-state-v2.ts)、[planning service](../../packages/development-guardian/planning/service.ts) | 未证明统一的货币硬上限；elapsed / action / token / money 不是互换指标，费用字段缺失不能写 0 |

## 仍需守住的证据边界

1. **外部 acceptance 的可信人责任仍存在。** [DeliveryStore](../../packages/development-guardian/delivery/service.ts)
   会验证 assertion、kind、reviewerIdentity、非空 evidence、commit 与内容摘要并重读；它接收调用方给出的
   PASS / identity / content，不自动证明 reviewer 的真实身份或截图 / 陈述的业务真实性。
   不能把“格式和摘要核对通过”写成“外部事实已独立认证”。
2. **文本分类与 source heuristic 不等于完整语义理解。** capability 分类在近期不断加固 browser / restart /
   no-third-party 的 external 边界；[capability-layer](../../packages/development-guardian/delivery/capability-layer.ts)
   和 [validator](../../packages/development-guardian/planning/validator.ts) 的规则仍需具体案例审查。
3. **源码 gate 存在不等于正常路径和恢复路径都在真实环境有效。** 两次保存的实验仍暂停，
   新修复的真实运行效果、部署版本与历史会话恢复不能从单测或 commit 标题推断。
4. **独立 review 是角色 / provider / 证据隔离合约，仍可能犯错。** 本轮没有真实 provider 认证或
   最新 review 成功证据；最新“补一次遗漏 verdict”修复只处理结构遗漏，不放宽业务 PASS。

所有缺口应转化成明确的待验证问题或用户决策，不通过降低 frozen expected outcome、删除
blocking 位、补人工答案、编辑 state / hash 来修复。
