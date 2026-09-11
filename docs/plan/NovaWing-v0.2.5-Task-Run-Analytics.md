# NovaWing v0.2.5：Task Run Analytics 与中文任务报告

## 架构边界

Task Run Analytics 是终态后的只读投影：`TaskStateV2 + TaskEventLog + Evidence + Runtime state -> TaskRunAnalyticsProjector -> SQLite`。Repository Reality、TaskStateV2、Verification Evidence 和 Review Evidence 仍是控制平面事实。Controller、Provider 路由、恢复、审批和完成判断均不读取 Analytics 表；投影失败采用 fail-open，并写入 Analytics 自身诊断表。

投影只在 Task 进入终态时执行。Launchpad 查询使用 SQLite 聚合，不在前端遍历完整事件流。`analytics:backfill` 只读取已有 durable state，可重复执行，不恢复 Session、不修改 Evidence 或 Git。

## SQLite schema

- `task_run_analytics_migration`：独立、事务化的 Analytics schema 版本记录。
- `task_run_summary`：每个 `(session_id, task_id)` 一行，唯一约束与 upsert 保证重启和回填幂等。
- `task_run_stage`：每次 EXECUTE、VERIFY、REVIEW、AI_REPAIR、RUNTIME_REPAIR、HUMAN_WAIT 的开始、结束和耗时。
- `task_run_reason`：按事件保存明确的 `reason_code`，供失败与修复原因聚合。
- `task_run_analytics_diagnostic`：投影或持久化失败的自诊断；不反向影响 Task 状态。

Provider 列表以 JSON 字段保存，但 identity 来自现有 runtime/provider 标识。历史通用路由 `codex-or-deepseek` 不能证明实际 Provider，因此显示“未知”。缺失的历史指标保存为 `NULL`、`UNKNOWN` 或空列表，不推测。

## 指标定义

- `total_duration_ms`：第一个 Task 事件（缺失时用 Session 开始时间）到 Task 终态事件（缺失时用 durable 终态时间）。
- `execute_count`：`AGENT_DISPATCHED(action=EXECUTE)` 次数；`execute_duration_ms` 为每次 dispatch 到对应完成/失败的累计耗时。
- `verify_count`：`VERIFICATION_STARTED` 次数；验证耗时为开始到通过/失败的累计值；失败数只计 `VERIFICATION_FAILED`。
- `review_count`：Review dispatch 次数；审查耗时为开始到通过/失败的累计值；失败数只计 `REVIEW_FAILED`。
- `ai_repair_count`、`runtime_repair_count`：各自明确 start 事件次数；兼容历史 durable runtime-repair 事实。耗时由配对 start/end 事件累计。
- `human_required_count`：明确 `HUMAN_REQUIRED` 次数；旧数据仅在该事件完全缺失时兼容 approval/suspended 事件。
- `human_intervention_count` / `human_action_count`：运行中真实用户动作次数。创建并启动不计入；用户点击修复计 action。
- `human_decision_count`：真实语义 decision/approval 次数。自动 AI Repair、Runtime Repair、failover、reconciliation、review 不计入。
- `repair_triggered_by_user`：用户动作明确触发 AI Repair 的次数，与语义 decision 分开。
- `provider_switch_count`：明确 `PROVIDER_SWITCHED` 事件次数。
- `restart_count`：Task resume 中扣除已记录的人为动作和当前 runtime repair 后的自动重启次数。
- `reconciliation_count`：明确 reconciliation required/completed 事件次数。
- `first_pass_success`：首次 implementation attempt 后，没有因验证失败或审查失败再次进入 EXECUTE；Provider timeout、quota、failover 或 Runtime Repair 本身不判失败。没有 implementation attempt 时为未知。
- `zero_human_completion`：Session 创建到 Task 终态期间没有真实用户 action、decision、approval、resume input 或 manual intervention。自动修复与自动协调不算人工介入。
- `commit_result`：`COMMITTED`、`ALREADY_SATISFIED`、`NO_CHANGES_REQUIRED`、`COMMIT_FAILED`、`NOT_REQUESTED` 或 `UNKNOWN`；commit hash 单独保存。
- 变更文件数来自 Task Git state，Evidence 数来自 Task completion evidence。

## 查询与展示

Launchpad 提供 `/api/analytics/tasks/:taskId`、`/api/analytics/sessions/:sessionId`、`/api/analytics/recent?limit=5|10|20`、`/api/analytics/reasons?limit=20`。API 使用稳定英文 machine schema；页面、Task 报告和 Windows 通知使用中文展示映射。最近任务的完成率、零人工完成率、平均阶段耗时、失败、修复及 Provider 切换全部由 SQLite query 计算。

运行报告是 SQLite 结构化记录的中文呈现，不是另一套事实源。通知保持短摘要，并链接到 Launchpad 完整报告。
