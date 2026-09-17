# NovaWing v0.3.1 Runtime UI 信息架构

本轮是 v0.3.0 发布后的 UI 开发，不是 hotfix 或 release certification。基线为
`a83d06804e01032b6d8cbe9e0558bb15bf345926`；v0.3.0 标签与旧 certification 结果保持冻结。

## 展示结构

控制台保留原有 Task 列表、操作按钮与需要人工处理/恢复入口，运行信息收敛为：

1. 运行概览：状态、当前阶段、创建时间、开始方式、实际开始、预计完成、实际完成、总耗时、Executor、轮次。
2. 活动日志：普通用户唯一主要运行时间线。
3. Debug：默认折叠，展示完整安全 snapshot、全量 ledger、结构化 Task events、验证结果与原始输出引用。

独立 Execution Activity Feed、Raw Runtime Log、开始时间、当前活动与重复 Execution 卡已移除。
UI 沿用深色 HTML/CSS/vanilla JS，不引入依赖或桌面壳。

## 数据边界

`activity-projection.ts` 与 `runtime-overview.ts` 是只读投影；输入是既有
`WorkSessionDurableState`、Task event log、完整 execution ledger、进程内安全 progress 和 coding execution metadata。
没有改变 runtime、Golden Path、Verifier、recovery、approval 或完成判定。

Snapshot 新增 `activities`、`runtimeOverview`、`eta`、`debug`。
进程内 progress 增加 Task identity，控制事件使用同一可注入时钟；既有事件与 ledger 不删除。
Debug 延续原有凭据保护边界：不复制自由 provider output、隐藏推理或用户决策原文；
保留技术事件 identity、状态、action、reason code、验证/计划、checkpoint、失败分类及 `rawOutputRef`。
完整原始证据仍在已有本地 durable state、ledger 与输出文件。

## 活动语义

按 Session、Task、phase 和执行 occurrence 生成稳定 identity。
每个数据源先配对开始/结束，再对齐不同来源；同阶段完成更新原活动，SSE/poll 复用 DOM 行。
时间校准只用于同 Task/phase 的跨来源匹配，不按同秒删除事件。
真实不同 Executor 周期、Task、verifier、checkpoint、人工操作及通知渠道结果保持区分。
FINALIZING/COMPLETED/SESSION_COMPLETED 收敛到 Task 完成活动；没有 Task 完成的独立 Session 终态仍有对应结果。
耗时来自阶段开始/结束时间差或明确 duration，不把累计 elapsed 当作阶段耗时。

例如旧界面同一次收尾显示：

```text
Executor 执行中 · 已完成
正在验证 · 进行中
正在验证 · 已完成
正在完成收尾 · 进行中
已完成 · 已完成
Work Session 状态已更新
Work Session 已完成
Task 已完成
```

新界面阶段开始时出现一行，完成后原行更新为：

```text
16:06:28 Executor 完成 · 6分14秒
16:06:30 验证通过 · 2秒
16:06:30 已创建 checkpoint · c08d459
16:06:31 Task UAT-V030-001 已完成
```

运行概览的总耗时是实际开始到 Session 完成的墙钟时长；完成后冻结。
既有 `activeElapsedMs` 仍保留排除暂停时间的 runtime 语义。终态缺少完成时间的旧记录使用
durable 终态 ledger/updatedAt，不使用刷新时钟。用户时间均由浏览器按本地时区显示。

## ETA

`task-eta.ts` 同步提供预测，不等待网络。初始输入包括 Task Brief、风险、allowed paths、
Verification Plan 的步骤/成本/范围/package roots、执行路径、真实 provider/model。

- 第一次：完成 Planning（`VERIFICATION_PLANNED`/持久化 plan）后异步尝试一次模型预测。
- 调整：首次 Executor 完成后，使用真实已耗时间加剩余验证、Review（适用时）和收尾成本，最多再调用一次。
- 模型：复用已有 `createCodexRepairModelRunner` 与 ChatGPT 登录；独立只读、无工具/网络访问的预测请求，10 秒超时。
  正式 Brain 的 review 合约仍只用于正式 Review，未混入 ETA。
- fallback：Golden/Advanced 基准成本、风险、范围、package 数和 verifier 数；模型不可用、超时、无效 JSON、cache 错误均保留预测。
- 历史接口可接入同仓库/同 provider、任务开始前已完成且无人工等待的 Executor 中位耗时。
  当前生产默认未额外查询 analytics；未声称历史 model 匹配，也未新增 analytics schema。
- `confidence=low` 显示“粗略估计”，较高 confidence 显示“约 ±N 分钟”，Executor 后标记“已调整”。预测不是 SLA，不包含不可预测的人工等待。

新增的唯一持久化是可替换的 UI sidecar：
`%LOCALAPPDATA%/NovaWing/runtime-ui/eta/*.json`（缺少 LOCALAPPDATA 时使用用户目录 `.novawing`）。
结构包含 `estimatedDurationMs`、`estimatedCompletionAt`、`confidence`、`reason`、`updatedAt`、
`uncertaintyMs`、`source`、`basis`、`adjusted` 与 `taskId`。
每个 Session/Task/milestone 在调用前用独占创建写入 fallback claim；poll、并发控制台及 restart 不重复调用。
缓存不保存 Task Brief、凭据或模型自由文本。完成后不接收迟到预测，旧完成记录只重建/读取预测。
没有 Task/时间锚点才显示“正在估算…”。ETA 失败不阻塞 start、resume 或 Task 执行。

## 轮次

轮次是当前 Task 进入 Executor 执行周期的次数。优先数 durable
`AGENT_DISPATCHED(action=EXECUTE)`，以带真实 `PROVIDER_DISPATCHED` 证明的安全活动补齐尚未落盘的开始；
多个来源取同一语义周期，不能相加。V2 仅切入 EXECUTING、尚未找到 Executor 时不计轮次；
legacy V1 可使用其 EXECUTING phase 证据。
不使用 Controller decision 数、Verifier 次数或内部 `iteration=0`。
Golden 真实 path 显示 `1 / 2`、`2 / 2`；Advanced 不伪造上限，显示“第 N 轮”。
尚未执行显示“尚未执行”；完成及 resume/restart 从既有 durable 记录恢复最终轮次。

## 验证

新增测试覆盖聚合与同秒独立事件、重启 identity、阶段耗时、终态冻结、真实 Executor 周期、
模型失败/超时/cache 错误、调用上限、跨控制台同步、真实 Golden runtime 的预测时机、页面结构、
稳定 DOM、Debug 与原控制按钮认证端点。

统一运行 targeted tests（包括现有 Launchpad/control-ui/recovery/approval/scheduled tests），随后
`npm test`、`npm run typecheck`、`npm run check:unused`、`npm run check:boundaries` 与 `git diff --check`。
本轮不运行或改写 v0.3.0 release certification。

2026-09-17 本轮验证记录：

- 广泛 targeted 回归：226/226 通过（Launchpad、control-ui、定时启动、恢复、审批与新投影）。
- 最后审查补修后的 focused targeted：52/52 通过。
- 最终 `npm test`：865/865 通过，0 失败、0 跳过。
- `typecheck`、`check:unused`、`check:boundaries`、`git diff --check`：通过。
- 浏览器实际核验模拟完成态：10 项运行概览、冻结总耗时、Codex 已完成、1 / 2、语义活动日志与默认折叠 Debug，展开后排障信息可访问。
- 现有 Windows SQLite/libSQL 临时数据库 `EBUSY` 清理提示仍可能出现，未更改该技术债；功能测试全部通过。
- v0.3.0 annotated tag object 仍为 `ff1f81bd935741031cf5bde46c8286b45f8d0192`，解引用提交与 main 均为上述发布基线。

## 文件清单

- `packages/development-guardian/work-session/control-ui/activity-projection.ts`：用户活动聚合。
- `packages/development-guardian/work-session/control-ui/runtime-overview.ts`：运行概览、轮次、安全 Debug 投影。
- `packages/development-guardian/work-session/control-ui/task-eta.ts`：预测、fallback、独立 cache。
- `packages/development-guardian/work-session/control-ui/controller.ts`：组合投影、Task identity、统一时间源。
- `packages/development-guardian/work-session/control-ui/events.ts`：只读 snapshot 类型扩展。
- `packages/development-guardian/work-session/control-ui/view.ts`：合并卡片与语义时间线。
- `packages/development-guardian/work-session/production.ts`：ETA 生产接线。
- `tests/runtime-activity-projection.test.ts`：语义聚合与窗口淘汰边界。
- `tests/runtime-overview.test.ts`：耗时、dispatch 轮次与重启。
- `tests/runtime-ui-eta-integration.test.ts`：Controller 与真实 Golden runtime 的 ETA 集成。
- `tests/runtime-ui-view.test.ts`：页面结构、DOM identity、控制按钮。
- `tests/work-session-task-eta.test.ts`：ETA 模型、缓存、fallback。
- `tests/work-session-w005-a-dom-safety.test.ts`：适配新界面的原 DOM 安全测试。
- 本文档：设计边界与验证说明。
