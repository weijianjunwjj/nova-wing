# NovaWing v0.4.0 Phase 3 Report

日期：2026-09-21。范围：Windows x64、固定 Electron 44.4.3、现有隔离 offline fake workload。未使用真实 Codex Task 或用户数据。

## 1. Changes

- 新增 Main `notifications.mjs` provider 与集中 `identity.mjs`。
- Production 新增 `desktopNotifier?: WorkSessionNotifier | null`：省略保持 CLI/旧 Windows adapter，`null` 明确禁用，实例显式替换为 Electron provider。
- 解耦完成邮件 opt-in 和 Desktop COMPLETED；为新 Desktop channel 增加历史 FAILED 恢复过滤。
- Host 维护 live Session → Control mapping，窗口增加 `showSession(sessionId)`，处理隐藏、最小化、映射撤销和导航期间关闭的竞争。
- 新增 provider、composition、路由测试及独立真实 Electron notification smoke；原 Phase 1/1B/2A/2B 门禁继续运行。
- 修复验收中复现的 HTTP preconnection strict-close 缺口：Control / Launchpad 在已接纳工作与 SSE drain 后，仅清理从未产生 HTTP request 的 TCP 连接，防止浏览器预连接拖住退出。

## 2. Notification Architecture

```text
WorkSessionRuntime 真正业务状态
→ existing WorkSessionNotifier / notificationChannels
  ├─ EMAIL SMTP provider（已有）
  └─ Electron Desktop provider（Main 显式注入）
     → Electron Notification
     → OS Notification
```

通知仍由原 Runtime 管线唯一生成；没有从 activity、SSE、Renderer、Tray 或 polling 发通知。业务 package 不 import Electron。旧 Runtime repair notifier 还包含一条额外任务完成提醒：显式 Desktop composition 仅过滤其 COMPLETED，统一交给 durable terminal 管线；repair SUCCESS/FAILURE 及未注入的 CLI 行为保留，Windows adapter 本身未改。

重新核实了 notifier、Production 两个 control-plane 分支、Runtime durable guard、channel status/retry、Windows task/repair adapters 和既有 tests。原聚合把全 SKIPPED 视作 ALL_SUCCEEDED 的行为没有扩大重写；新 provider 在不支持时完全不注册，避免进入该路径。

## 3. Event Semantics

| 事件 | 唯一业务来源 |
| --- | --- |
| COMPLETED | `state=COMPLETED` 且 `completionReason=ALL_TASKS_COMPLETED`；原 durable completion attempt guard |
| FAILED | 既有结构化 FAILED 终态，带 failureStage/failureCategory；保留原 failure identity |
| HUMAN_REQUIRED | `SUSPENDED + humanRequired + humanRequiredGeneration`，且不是 USER_PAUSED |
| USER_PAUSED | 不发送 HUMAN_REQUIRED |

idle、future schedule、SOFT_LIMIT、MAX_TASKS 不产生目标完成通知。observer/renderer/native delivery 故障不是 Task FAILED 来源。三类任务均验证通知失败不改变业务结果。

## 4. Email / Desktop Isolation

显式 Desktop provider 存在时独立注册 terminal capability；SMTP 的 COMPLETED capability 仅在用户 `email.notifyOnCompleted=true` 时保留。不修改该配置、不强制设为 true。

测试覆盖 SMTP OFF/Desktop ON；SMTP ON/完成邮件 OFF/Desktop ON；两者 ON；Desktop unavailable/Email ON；两者 OFF；另验证两个 Production control-plane 分支接收同一 additive seam。SMTP transport 使用内存 fixture，不连接外部邮箱。未注入时保留旧 adapter 和 CLI completion opt-in 行为。

## 5. Native Provider

`Notification.isSupported()` 为 false 或检查抛错返回 absent provider，Main 显式传 `null`，不注册 DESKTOP、不 fallback 旧 toast adapter。provider 声明 DESKTOP 及三种真实 capability。

只有原生 `show` 事件 resolve delivery；`failed`、构造/show 抛错、确认前 close、5 秒无确认均 reject。错误诊断使用固定安全原因，不暴露 OS 原始错误内容。既有 Windows adapter 的 8 秒上限包含外部脚本 worker；Electron 没有该启动成本，本轮选择明确可测试的 5 秒本地 OS 确认上限，避免缺失事件拖死 strict drain。复用 Runtime 初次加一次 retry、默认间隔 1 秒，缺失 ack 的单渠道等待最多约 11 秒，不包含其他工作的 drain 时间。smoke 用 80ms 可注入超时验证同一逻辑。

active objects 最多 64 个，成功后最长保留 15 分钟；保留 click/close listeners，避免 Windows timeout-close 后立即丢失实例。容量满时优先释放 settled object，全部 pending 时拒绝新增投递。retention timer 不阻止进程退出；dispose 清除 timer、listener、对象并结算 pending Promise。

核对安装版 `electron.d.ts` 和官方 [Notification API](https://www.electronjs.org/docs/latest/api/notification)。Windows `handleActivation` 是 process-lifetime callback，实际 `ActivationArguments` 提供 type/raw arguments 和可选 action/reply/userInputs，但没有 notification id/session 字段或文档化身份编码。本轮注册集中 handler，但拒绝猜测 raw string 或执行 URL；运行中保留实例的 click 完整路由，无法关联的集中 activation 只记录安全诊断。两种回调在 shutdown requested 后立即 fail-closed。

## 6. Click → Session

```text
内部 notification identity
→ provider 保存的 sessionId
→ Host.resolveSessionUrl(sessionId)
→ 当前 live Control mapping + exact owned origin
→ show / restore / focus + load Control
→ 无效时 fallback Launchpad
```

mapping 来自受信任的 Production config 与真实 server.start 结果；Control close 受理时同步撤销映射，Host close 清空。`isLive()`、origin 和映射在异步窗口创建/导航后复查；即使 origin 仍在 strict drain 中，失效 Session 也不能成为旧 URL 导航目标。通知中的 report/control URL 从不读取。

点击路径不调用 Host/Runtime/Session 工厂。真实 smoke 对三种通知逐次比较 Host 数、Runtime 数和 execution 数，全部不变；COMPLETED fake workload 只执行一次。映射失效回 Launchpad、最小化 restore、focus、隐藏显示和关闭后 fail-closed 均验证。

## 7. Delivery / Retry / Dedup

使用现有 payload notificationId：COMPLETED `${session}:completed`，FAILED `${session}:failed`，HUMAN_REQUIRED `${session}:${task或none}:${generation}`。provider 对 `[sessionId, kind, notificationId]` 求稳定 hash，作为内部/native id，Session hash 作为 groupId；没有 random/time identity，没有新增 durable schema 或 attempt 计数。

Runtime 按失败渠道独立执行最多一次 retry；EMAIL SENT 不因 DESKTOP FAILED 重发，反向也验证。投递失败只写原 notification channel result / ledger。completion attempt、human generation、failed delivery facts 继续负责 durable 去重；provider 内存合并不是持久化去重替代品。

历史 COMPLETED/HUMAN_REQUIRED hydration 原本不投递。历史 FAILED 原本会恢复发送，本轮 additive `NotificationChannelEntry.notifyOnRestore=false` 仅过滤显式新 Desktop、且仅针对原持久状态没有 attempt 标记的历史失败；EMAIL/旧 adapter 恢复保持。FAILED 原 durable attempt 已存在、ledger 尚无结果的待投递工作仍沿原规则恢复；没有扩大其他类型的重启重试。

真实 Electron 中执行 reload、hide/show、renderer crash/recovery、两次真实 EventSource 连接、窗口销毁重建和 status polling，通知创建数不变；专项测试另覆盖重启 hydration、成功和 retry 耗尽的 durable 去重。

## 8. Windows Real-host Result

| 验收层 | 结果与边界 |
| --- | --- |
| Business integration | PASS；真实 Production/Runtime，安全 fake workload |
| Electron event integration | PASS；隐藏窗口时三类均收到真实 native show |
| Main click handler routing | PASS；自动调用与实例 click 共用的 Main handler，验证正确 Session/restore/focus/无重复 Runtime |
| Windows visible Toast / 真人点击 | NEEDS_PACKAGED_VALIDATION；没有完成真人视觉与系统 Toast 点击认证 |
| persisted Action Center / cold-start | NEEDS_PACKAGED_VALIDATION；不声称 PASS |
| macOS notification | 未验证，需签名包和 macOS real-host |

```text
WINDOWS_NATIVE_TOAST_VISUAL: NEEDS_PACKAGED_VALIDATION
```

本机开发进程能收到 show；这不证明系统弹窗实际可见或真人点击通过，也不能推定有 app identity 故障。已发起人工验收询问，未收到通过证据时保持上述结果。未自动 Pin electron.exe、修改快捷方式/注册表或设置永久系统配置。官方 [development bootstrap](https://www.electronjs.org/docs/latest/tutorial/notifications#notifications-in-development) 不能替代 installer identity 验证。集中 identity 目前只定义 appName=NovaWing，正式 AppUserModelID/ToastActivatorCLSID 留空；Phase 4 与 electron-builder 必须使用同一经确认身份。

## 9. Test Results

最终代码门禁全部通过。以下均为最终实现上的真实命令结果：

| 命令 | 结果 |
| --- | --- |
| `npm run desktop:smoke`（preconnection 修复后） | PASS；四个独立 Electron entry 全部 exit 0、无 timeout，真实 secondary 正常退出，隔离目录清理 PASS |
| `node --test --test-reporter=tap --test-concurrency=1 dist-tests/tests/work-session-strict-control-lifecycle.test.js dist-tests/tests/work-session-launchpad-strict-lifecycle.test.js` | PASS；46/46，0 fail / cancelled / skipped，2635.1486ms |
| `npm run check` | PASS；业务测试 1092/1092（635572.156ms）+ Desktop 63/63（10336.1022ms），均为 0 fail / cancelled / skipped；typecheck、unused、migration、exports、repository/platform boundaries 全通过 |
| `npm run pack:check` | PASS；两次构建的 238 个 runtime 文件 SHA-256/清单一致，tarball 240 个文件，边界检查通过 |
| `npm run consumer:selftest` | PASS；fresh tarball consumer 的 migration / proposal / approval / context / snapshot import / deep-import rejection 均通过 |
| `git diff --check` / `git diff --cached --check` | PASS；提交前复核通过 |

阶段性专项命令：`npm run build`、`npm run build:tests`、`npm run check:platform`、`npm run check:desktop` 均 PASS；通知六文件测试集合 85/85、provider 16/16、Host/Window 路由 33/33 均 PASS。六文件集合为 `desktop-notification-composition`、`notification-channel-status`、`work-session-w006-completed-notification`、`work-session-w006-notification-runtime`、`work-session-w006-smtp`、`work-session-execution-ledger`，由 `node --test --test-reporter=tap --test-concurrency=1 dist-tests/tests/<name>.test.js` 执行。后补的 repair 完成提醒隔离测试由完整 check 覆盖；真实 smoke 同时断言 FAILED/HUMAN_REQUIRED 的单次 provider invocation。

最终 smoke 机器统计：Notification 20/20（18 个用户要求的业务 gate + 外部 exit/isolation cleanup）、Background 34/34、Launchpad 35/35、Strict Shutdown 10/10。通知场景 10 个 Production Runtime 全部关闭，资源 tracker live 数组为空；pending delivery 在 strict quit 下两次有限超时，237.8037ms 完成 drain，业务仍 COMPLETED，最终 refs/timers/pending 全部零。

失败与修复记录：

- 首轮完整 check 的 1090 项业务测试通过，但 platform guard 拒绝新测试中的硬编码 Windows 隐私样例路径/命令。改为 `join(tmpdir(), ...)` 和通用拒绝样例；没有增加 boundary allowlist，随后完整 check PASS。
- smoke 第 1、3 轮 native entry、第 4 轮既有 background entry 曾 60 秒超时；第 2、5 轮 PASS。诊断确认原生通知已 settle，停顿在既有 HTTP server.close，未放宽超时、断言或 strict drain。
- 独立最小实验在 Node 24.14.1 及固定 Electron 44.4.3 / Node 24.21.0 各复现 3 种场景：无 request 的 TCP 预连接能保持 close pending；定向关闭该连接即释放；活动 SSE 不受影响。已用共用 preconnection tracker 修复，并新增两种真实 server 回归覆盖空连接、半个请求头和未完成业务/SSE。修复后的正式 `npm run desktop:smoke` 全部 PASS。历史超时未取得当次完整 socket 证据，因此不宣称每次都已被精确归因。
- smoke 另修正轮询时未消费的 HTTP response body，但后续反例表明它不是已确认的唯一超时根因。临时内部 socket 探针已移除。
- 专项 composition 初轮清理失败定位为 Windows libSQL 临时文件 EBUSY，递归删除内部 retry 放大到约 67 秒；业务构造/执行/close 均已完成，采用仓库已有有限外层重试模式，仅对明确的 OS 占用错误记录残留路径。

证据在 Git 忽略的 `artifacts/desktop/bootstrap-smoke/`：各轮 `phase3-desktop-smoke-attempt*.log`、最终 `phase3-desktop-smoke-final.log`、`first-attempt-*` / `third-attempt-*` / `fourth-attempt-*` / `fifth-attempt-*`、`notification-diagnostic*`、`phase3-http-close-preconnect-probe.log`、`phase3-preconnection-regression.log`、`native-notification-result.json`、`background-runtime-result.json`、`launchpad-result.json`、`strict-shutdown-result.json`、`result.json`，及专项/完整命令日志。失败记录未改写为 PASS。

## 10. Security

通知只在 Main。Renderer 保持 nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true、webviewTag=false，无 preload/业务 IPC。exact origin registry、权限拒绝、外部导航/webview/window-open 禁止继续有效。

三类文案只用固定中文标题和说明，不包含 prompt、路径、token、原始模型输出或长错误堆栈。click/activation 不解释任意 URL、file path、shell command 或外部/localhost payload。provider 与路由错误不会更改业务状态；shutdown 后不能重新打开窗口或接纳工作。

## 11. Findings / Remaining Risks

- Windows packaged AppUserModelID / Toast identity、系统 Toast 视觉及真人点击是 Phase 4 硬门禁；对象保留期之外和 cold-start/persisted activation 尚未支持可靠 Session 关联。
- Git Bash packaged discovery 未改；完整 check 只在当前命令进程设置 `NOVAWING_GIT_BASH_PATH=D:/Git/bin/bash.exe`。
- real Codex、真实用户数据、packaging/installer、auto update、macOS signed notification 均未认证。
- system shutdown/logoff、force kill、断电不属于本次受控 Quit 证明。
- 多轮 smoke 的间歇 HTTP close 超时促成了已复现 preconnection 缺口修复；历史每次停顿无法逐一归因，保留失败证据，后续 real-host 继续观察。
- Electron show 确认平台接受调用，不保证 Focus Assist/OS 用户设置下可见；不能据此改变通知或业务成功定义。
- Windows Node 测试的部分 libSQL 临时目录在进程内清理时被 OS 锁定。可选的后续临时目录删除被自动审批审查拒绝（只返回 `blocked by policy`），未执行或绕过；可能保留少量系统 Temp 下测试目录。Electron smoke 自己的隔离目录由外部 runner 在进程退出后清理，最终该门禁 PASS。

## 12. Git

```text
branch: feat/v0.4-desktop
HEAD before: cb291a2e4f63fbdbd9e8cebc0f196935babb71b6
HEAD after: 包含本报告的提交，准确 SHA 见最终交付回复
commit: feat(desktop): add native task notifications
working tree: 本轮改动已提交；仅保留原有未跟踪 Survey（下列路径）
```

本轮文件全部纳入该提交；工作区仅保留原有未跟踪 `docs/plan/NovaWing-v0.4.0-Desktop-Architecture-Survey.md`，保留原样、不纳入提交。提交后的准确 SHA 与 `git status` 复核结果见最终交付回复。不 push、merge 或 tag。

## 13. Verdict

**PASS WITH FIXES**。通知代码与全部自动门禁通过；验收中发现的 completion opt-in / repair 重复提醒耦合、历史 FAILED backfill、异步 Session 映射撤销及 HTTP preconnection 关闭缺口均已修复并验证。Windows 系统 Toast 视觉与真人点击仍为 **NEEDS_PACKAGED_VALIDATION**，不等同于代码 Gate 失败，也不宣称已完成最终产品身份认证。

## 14. Next Step

仅在 Phase 3 审查通过后进入 **Phase 4 — Windows Package & Real-host**：electron-builder、stable appId、Windows installer、packaged PATH、Git Bash discovery、Codex packaged resources、SQLite/libSQL、Native Notification identity、clean install 和真实 Codex Task。本轮不开始 Phase 4，交付后停止等待审查。
