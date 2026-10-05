# NovaWing：Claude 接手入口

交接核查日：2026-10-02（Asia/Shanghai）。源码基线：`ad26456e686a8e6517d157e96e3c2ebe00a257ef`。
这是一份本地证据索引，不是新的产品规格，也不是实时运行状态面板。

## 项目定位及边界

本轮用户给出的目标定位：面向 AI 研发的 Agent Harness，模型可替换，以可控成本完成真实交付。
当前仓库包含两个应同时理解的层次：经过人工批准的长期主线 Core，以及逐步扩展的
Development Guardian、Customer Planning、Delivery 和桌面控制面。
早期 [PRD v0.1](../prd/NovaWing-PRD-v0.1.md) 冻结的是个人主线记忆内核；其目标版本和非目标
不能被读成当前整个 Harness 的实现清单。定位差异和未统一的规格见
[原则与决策](PRINCIPLES_AND_DECISIONS.md)。

[AGENTS.md](../../AGENTS.md) 保持跨项目职责：OfferFlow＝业务层，NovaWing＝认知层，
cc-auto＝模型执行层，Personal OS＝总入口 / workflow bus，AI-OS＝Skill / Prompt / Workflow /
Playbook 沉淀层，ai-code-rules＝协作规则内核。这是规则声明；本轮没有审计其他项目的实现。

## 阅读顺序

1. 用户最新任务、[AGENTS.md](../../AGENTS.md)、[CLAUDE.md](../../CLAUDE.md)。
2. [CURRENT_STATE](CURRENT_STATE.md)：版本、证据等级、真实暂停及未知项。
3. [ARCHITECTURE](ARCHITECTURE.md)：从实际入口追踪模块和数据流。
4. [PRINCIPLES_AND_DECISIONS](PRINCIPLES_AND_DECISIONS.md) 与
   [FAILURES_AND_OPEN_QUESTIONS](FAILURES_AND_OPEN_QUESTIONS.md)。
5. [WORKFLOW](WORKFLOW.md)：先形成范围、验收、权限、预算和停止条件，再给编码 Agent 指令。
   与 Codex 交接按 [HANDOFF_PROTOCOL](HANDOFF_PROTOCOL.md)：每轮开头先核对 `HANDOFF.json`，再做判断；
   指令一律使用 [CODEX_TASK_TEMPLATE](CODEX_TASK_TEMPLATE.md)。
6. 只读本轮涉及的权威来源和测试；需要启动提示时使用 [启动提示](CLAUDE_START_PROMPT.md)。

## 各主题权威来源

| 主题 | 优先来源 | 如何使用 |
| --- | --- | --- |
| 当前实现 | [packages](../../packages)、[desktop](../../desktop)、[package.json](../../package.json)、[tests](../../tests) 与当前 Git | 代码说明行为，测试文件说明预期；文件存在不代表本轮测试通过 |
| Core 和数据所有权 | [PRD v0.1](../prd/NovaWing-PRD-v0.1.md)、[设计 v0.1](../design/NovaWing-System-Design-v0.1.md)、[ADR 0001](../adr/0001-draft-proposal-state.md)、[Facade](../../packages/core/src/facade.ts) | PRD/设计有版本限制；draft 的差异已有 ADR |
| Snapshot / 分发 | [ADR 0002](../adr/0002-distribution-source-and-host-snapshot-v3.md)、[ADR 0003](../adr/0003-private-github-packages-and-immutable-consumption.md)、[host-snapshot](../../packages/host-snapshot/src) | ADR 0003 取代 0002 的公共 Registry 决定，未取代 Snapshot 协议 |
| 规划质量 | [质量加固报告](../plan/NovaWing-v0.5-Planning-Quality-Hardening.md)、[validator](../../packages/development-guardian/planning/validator.ts)、[service](../../packages/development-guardian/planning/service.ts)、[五次 benchmark manifest](../plan/benchmarks/requirement-001-phase1-hardening/manifest.json) | 原始失败保留；规划 PASS 与客户决策、产品交付分开 |
| 冻结计划 | [Plan Freeze Spec](../plan/NovaWing-v0.5-Plan-Freeze-Spec.md)、[freeze](../../packages/development-guardian/planning/freeze.ts)、[状态报告](../plan/NovaWing-v0.5-Plan-Freeze-Status.md) | 哈希、审批版本、答案来源和重读是关键 |
| 编译 / admission / 验证 | [Runtime Plan Spec](../plan/NovaWing-v0.5-Runtime-Plan-Compiler-Spec.md)、[runtime-plan](../../packages/development-guardian/delivery/runtime-plan.ts)、[staged-verification](../../packages/development-guardian/delivery/staged-verification.ts)、[blueprint](../../packages/development-guardian/delivery/verification-blueprint.ts) | 旧报告按其 admission 版本解释；当前阶段与缺口见本交接 |
| Runtime / checkpoint / retry | [workspace 合约](../runtime/workspace-execution-contract.md)、[owned checkpoint](../runtime/owned-implementation-checkpoint.md)、[retry reconciliation](../runtime/task-retry-reconciliation.md)、[production](../../packages/development-guardian/work-session/production.ts) | 文档中的历史会话不是今天的实时状态；所有权不能由模型 JSON 补造 |
| 模型装配 | [ExecutorRouter](../../packages/development-guardian/executor-router.ts)、[runtime-config resolver](../../packages/development-guardian/runtime-config/resolver.ts)、[Codex 设计](../design/codex-local-executor.md) | 默认值、SDK 版本以代码 / lockfile 为准；设计中的旧版本不是当前环境证明 |
| 桌面分发 / 本机验收 | [v0.4 closure](../audit/NovaWing-v0.4-Closure.md)、[Windows 更新报告](../audit/real-update-acceptance/2026-09-25-v0.4.3-to-v0.4.4-windows.md)、[desktop/main](../../desktop/main) | Windows 历史 PASS 不能推出 macOS 签名、通知或当前安装包 PASS |
| 本机实验状态 | CURRENT_STATE 的外部本地证据定位；planning/delivery JSON 和只读 workflow snapshot | 不复制完整数据库、客户输入、凭据、配置或模型原文进交接文档 |

交接页仅提供索引、适用版本和本轮观察；详细规格仍在上述来源。更新时保留失败证据，
不要复制整个历史报告来制造第二份事实源。

## Claude 每次开始工作的步骤

1. 先确认能访问的仓库路径与本轮授权。若无文件访问能力，声明这一限制，列出需要的最小材料。
2. 按 AGENTS.md 尝试读取 `D:/VSCode/obsidian-ai-memory/00-System/AGENT_MEMORY.md` 并按其协议
   读取相关永久记忆。本轮 macOS 未找到该路径；没有取得其协议，不声称已完成永久记忆核验。
   缺失时说明，使用当前证据做已授权工作；涉及未知跨项目协议的决定留待核实。
3. 重新读取当前项目规则，记录 `git branch --show-current`、`git rev-parse HEAD`、
   `git status --short --untracked-files=all`。保留用户已有修改，不 reset、stash 或覆盖。
4. 对照 CURRENT_STATE 的基线；HEAD、目标仓库、runtime policy 或数据位置改变时，先更新相关
   事实，再引用旧结论。默认数据根不是全部实验的保证；显式覆盖和其他主机需要另行核查。
5. 顺着实际入口读取任务涉及的文档、源码、测试和必要的只读 state；聊天 / 总结仅作为线索。
6. 写出本轮任务契约，区分“目标 / 已实现 / 实际运行观察 / 历史报告 / 待核实”。
7. 分别报告修改完成、测试状态、流程状态、产品验收状态；没有证据就写待核实、NOT RUN 或 BLOCKED。

本轮交接权限只包含文档及只读核查：不修改业务代码，不启动真实模型实验，不调用付费 API，
不提交或推送。后续每轮以用户的新指令界定授权，不能从这些文件推导自动恢复或交付许可。
