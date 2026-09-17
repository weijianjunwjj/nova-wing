# NovaWing v0.3.1 使用问题收敛

本轮继续 `feat/v0.3.1-runtime-ui-polish`，起始 HEAD 为
`b9d4ddacc857aa8c68ad521c2e6b07da99df656c`。它在已有 UI 工作之上补齐结构化 Brief
与受限恢复，不改写 v0.3.0 标签、不运行 release certification、不发布、不启动真实 UAT。

## Quick Fill

Task ID、allowedPaths 与 forbiddenPaths 使用同一套字段标题和 section 边界识别。
支持中英文冒号、`【标题】`、标题与值分行，以及 Markdown 路径列表。ID 只来自完整标注字段，
沿用合法字符检查；显式 Task block 分别解析，未提供 ID 时沿用默认生成。

重新 Quick Fill 延续原产品的替换约定，页面明确提示会替换已填写字段。原始 Brief 不变。
明确给出但不能安全解析的 allowedPaths 保持空值、提示确认，创建表单阻止空授权，绝不回退为 `**`。
Composer 现有 Guardian 配置由多个 Task 共用：不同 block 的 allowedPaths 不自动求并集，必须人工确认共用范围。

## 恢复路径与预算

生产 Golden 仍最多 2 次 EXECUTE、2 次 VERIFY。普通代码失败、无进展、验证配置或证据不足，
先记录 `GOLDEN_EXHAUSTED → AUTONOMOUS_DIAGNOSIS`。诊断复用现有只读 RepairModelRunner，
输入包含任务约束与权限、diff、HEAD/checkpoint、Verification Plan、每步 command/cwd/exitCode/classification、
已落盘的 stdout/stderr、两轮 Executor summary，以及执行/验证计数。

诊断输出必须符合严格 JSON schema，包含 recoverable、strategy、requiresHuman、humanReason、
requiredAuthority、paths 与 commands。是否继续由结构化字段和确定性授权校验决定。
安全方案记录 `ADVANCED_RECOVERY` 并使用现有 V2ControllerTaskRunner；此时 execution.path 为 CONTROLLER，
保留 Golden 历史、原验证计划和失败证据。Advanced 实现步骤仍延后验证，由独立 deterministic verifier 执行。

预算复用既有 `TaskStateV2.actionBudget.recoveryLimit`，上限 **4 个动作**：
诊断消耗 1，重规划如需执行再消耗 1，后续 EXECUTE/VERIFY/REVIEW 沿用 Controller 收费。
调用前持久化消耗；暂停、重启、补充指令与重复点击均不重置额度。达到预算上限转 Human Required。
普通 legacy Direct/Controller 不启用新的自动循环；生产 Golden 的升级复用原控制器。

路径扩大、forbidden path、未经授权的命令、凭据、破坏性操作、远端历史、业务选择、额外额度，
以及有限诊断后仍无安全方案，都保留人工决定。没有新增 verifier allowlist。

## 可操作的 Human Required

工程故障提供「AI 诊断并继续」和「补充指令 / 提交指令并继续」。
复用 `/api/session/resume`，新增恢复请求携带 taskId 与暂停 generation，过期页面请求被拒绝。
指令存入同一个 Session snapshot 的 taskRecoveryInstructions，并按 sessionId/taskId 过滤后进入诊断与执行上下文。
原始指令不放入 status/SSE/Debug。后续 Task 不继承前一 Task 的 resumeData。

预算耗尽时禁用自动诊断；仍可保存补充说明，但不额外执行、授予新预算或扩大权限。
批准命令继续使用既有 scoped approval；新增同等 token/Origin/local-only 约束的拒绝入口，
将 REJECTED 持久化并维持暂停，不启动 Executor。

UI 显示恢复中的当前 Session、尝试记录、最后失败 verifier 和 changedFiles，内部枚举保留在 Debug。
Runtime Overview 优先采用终态、暂停及人工等待状态；最近一次 Executor 结果单独显示。
Human Required 活动按 Session、Task、category 和恢复边界聚合，忽略不同来源的投递延迟与文案差异；
Debug 保留底层事件。ETA 与 1-based 轮次沿用现有逻辑。

## 验证

定向回归包含结构化 Brief、真实表单输入、Human Required 控件、durable restart、Task 隔离、
Golden 上限、自动诊断证据、越权拒绝、共享预算、Advanced 暂停恢复、verifier step identity/cwd、
运行概览、活动语义去重、Runtime Repair、原有恢复/审批与生产集成。

2026-09-17 最终广泛 targeted 回归：**337/337 PASS**（41 个测试文件）。
收尾聚焦回归另有 **47/47 PASS**。全量测试发现的旧精简 Task 快照兼容问题修复后，
相关活动、概览和 UI 回归 **26/26 PASS**。未启动真实 UAT，留待用户创建真实 Task 验收。

2026-09-18 收尾验证：

- `npm test`：**909/909 PASS**，0 失败、0 跳过。
- `npm run typecheck`：PASS。
- `npm run check:unused`：PASS。
- `npm run check:boundaries`：PASS。
- `git diff --check`：PASS。
- v0.3.0 tag object 仍为 `ff1f81bd935741031cf5bde46c8286b45f8d0192`，
  解引用提交仍为 `a83d06804e01032b6d8cbe9e0558bb15bf345926`。
- v0.3.1 未发布；未执行真实 UAT 或 release certification。

现有 Windows SQLite 临时数据库 EBUSY 清理提示未列入本轮改动。
隔离编译目录 `.quick-fill-test-output` 的递归清理被工具自动审批以 `blocked by policy`
拒绝，因而保留，未作为交付源码提交。

## 修改文件

Git 核验的交付文件共 29 个（不包含临时编译输出与测试日志）：

- `docs/plan/NovaWing-v0.3.1-Usability-Recovery.md`
- `packages/development-guardian/work-session/autonomous-diagnosis.ts`
- `packages/development-guardian/work-session/autonomous-recovery-evidence.ts`
- `packages/development-guardian/work-session/control-ui/activity-projection.ts`
- `packages/development-guardian/work-session/control-ui/controller.ts`
- `packages/development-guardian/work-session/control-ui/events.ts`
- `packages/development-guardian/work-session/control-ui/runtime-overview.ts`
- `packages/development-guardian/work-session/control-ui/server.ts`
- `packages/development-guardian/work-session/control-ui/view.ts`
- `packages/development-guardian/work-session/golden-path.ts`
- `packages/development-guardian/work-session/launchpad/task-brief.ts`
- `packages/development-guardian/work-session/launchpad/view.ts`
- `packages/development-guardian/work-session/model.ts`
- `packages/development-guardian/work-session/production.ts`
- `packages/development-guardian/work-session/runtime.ts`
- `packages/development-guardian/work-session/task-observability.ts`
- `packages/development-guardian/work-session/task-runner.ts`
- `packages/development-guardian/work-session/task-state-v2.ts`
- `packages/development-guardian/work-session/v2-controller-task-runner.ts`
- `tests/runtime-activity-projection.test.ts`
- `tests/runtime-overview.test.ts`
- `tests/runtime-ui-view.test.ts`
- `tests/task-brief-structured.test.ts`
- `tests/v030-golden-path-production.test.ts`
- `tests/v031-autonomous-recovery.test.ts`
- `tests/v031-human-recovery-controls.test.ts`
- `tests/v031-recovery-evidence.test.ts`
- `tests/work-session-launchpad.test.ts`
- `tests/work-session-w005-a-guardian-progress.test.ts`
