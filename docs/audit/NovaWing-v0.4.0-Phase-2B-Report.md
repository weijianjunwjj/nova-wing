# NovaWing v0.4.0 Phase 2B Report

日期：2026-09-21。范围：Windows x64 开发环境、固定 Electron 44.4.3、隔离 offline fake workload。继续使用已有 Electron Main → Launchpad → Production Work Session → Runtime → HTTP/SSE。

## 1. Changes

- Main 在创建 fixture、Host、Launchpad 或数据库之前取得 single-instance lock；secondary 直接退出，primary 复用窗口入口。
- 集中 BrowserWindow 生命周期：普通 close 隐藏，统一 show/restore/focus，窗口销毁及 renderer crash 后恢复已有 Host 的 UI。
- 增加最小 Tray 与 module-relative PNG 资源，以及由真实 activity lease 驱动的 Power adapter。
- 在通用代码中增加可选、无 Electron 依赖的 activity observer，复用既有 operation ownership/drain；补齐 scheduled 实际 claim 与独立 ETA model runner 的生命周期。
- 原 strict shutdown coordinator 增加成功 drain 后的 native cleanup continuation，没有第二套退出逻辑。
- 增加 deterministic tests、真实 background smoke、外部 secondary runner、机器证据并更新 README。

没有新增 Native Notification、preload、IPC、packaging、installer、自动更新或发布流程；没有真实 Codex 调用或真实用户数据操作。

## 2. Background Lifecycle

```text
普通 BrowserWindow close
→ preventDefault / hide
→ Main、Tray、Host、Runtime、任务和 activity lease 继续存活

明确 Quit
→ 原 before-quit / shared shutdown Promise
→ 停止 admission / strict drain 已接纳工作
→ activity finally release
→ Host cleanup 成功
→ Power fail-safe / Tray destroy / window destroy
→ final app.quit
```

Main 显式接管 `window-all-closed`，该事件不会退出应用。隐藏、崩溃、reload、Tray 操作均不会调用 Host.close 或释放 Power。重复 Quit 仍复用 Phase 2A coordinator；Host cleanup 失败时不进入 native cleanup，不宣称 graceful quit 成功。失败后保留 Tray 和诊断入口，admission 不重新开启，也不恢复已关闭的 Host。

## 3. Tray

Main 保持唯一 Tray 的强引用，ready 后创建，包含“打开 NovaWing”“当前状态：空闲/运行中”“隐藏 NovaWing”“退出 NovaWing”。点击图标与菜单打开共用 showWindow；退出调用 app.quit，经现有 before-quit 协调器执行 strict shutdown。

状态订阅真实 activity 数量，仅展示是否存在活动；不轮询 durable Task 状态，不创建第二个状态机，也不成为 Power 的输入。资源来自 `new URL('../assets/tray.png', import.meta.url)`，不依赖 cwd。仓库原先没有 app/tray icon，本轮只新增一个最小图标。macOS Template Image 真机表现未认证。

## 4. Single Instance

隔离 userData 配置后立即调用 `app.requestSingleInstanceLock()`，在任何业务 package/fixture 的动态 import 之前分支。未取得 lock 时 creation counters 均为零，没有 Host、Runtime、Launchpad、Tray 或 DB 创建路径，直接 clean quit。

primary 的 `second-instance` 等待原 startup 完成后调用同一 showWindow；隐藏时恢复并 focus，窗口已销毁时只重建 BrowserWindow。`activate` 使用同一入口。当前测试沿用隔离 profile，同 profile 第二实例由外部 Node runner 启动；不同的 `desktop:dev` 隔离 profile 不是同一 single-instance lock 域。

## 5. Renderer Recovery

监听现代 `webContents.render-process-gone`；crashed/killed/oom/abnormal-exit 不影响 Host、Runtime 或任务。可复用窗口重载可信 URL；已销毁时 ensureWindow 重建。自动恢复保留隐藏意图，不因后台 crash 弹出窗口。

lastTrustedUrl 只记录通过现有 navigation registry 的、已提交的主框架导航；忽略待跳转地址、子框架及未登记 URL。恢复时重新验证当前 registry，Control origin 撤销后回 Launchpad。新窗口重新安装全部安全策略。

每 60 秒最多 3 次自动恢复；超过上限停止自动 reload，并输出结构化诊断。并发 show/ensure 与 recovery 共享创建/加载 Promise，旧窗口的失败清理不能销毁新窗口，quit/hide 可以阻止异步完成后的迟到 show。

## 6. Activity / Power Contract

```text
通用 activityObserver({phase, activityId, operation, sessionId?})
→ Main 全局 lease Set
→ 0→1: start('prevent-app-suspension')
→ 1→2→1: 保持同一个 blocker id
→ 1→0: stop(id)
```

| 实际工作 | lease 边界 |
| --- | --- |
| immediate / scheduled execution | Runtime 的实际 startExecution；scheduled 成功取得 claim 后开始，整个执行、verification、checkpoint/finalization settle 后释放 |
| resume / interrupted recovery | Controller 已接纳的真实 resume Promise，包含其后续工作 |
| verification approval / durable approval recovery | 原 approval/continue operation |
| runtime repair / checkpoint recovery | 原 repair/recover Promise，失败也 finally release |
| Launchpad AI repair | 实际 repairLlmAgent.repair Promise |
| ETA model runner | 底层 runner Promise；展示 timeout 不能提前释放 lease |

observer 的同步 throw 和异步 reject 都被隔离，不能改业务返回值、error identity 或阻塞 drain。activity helper/类型没有 Electron、Tray 或 Power import；Runtime 仅新增 additive observation seam，不修改 Task 终态、checkpoint 或完成规则。

不读取 durable RUNNING 决定 Power。hydration、只读 status、普通 SSE/HTTP/窗口/Tray、未来未执行的 scheduled session 以及已 settle 的 SUSPENDED/HUMAN_REQUIRED/USER_PAUSED/terminal 均不持有执行 lease。若同时仍有独立 model runner，按真实存活工作继续持有，直到它 settle。

scheduled 的时间判断不能代替实际执行：测试覆盖读取 snapshot 期间跨过 due time，随后成功 claim 的工作仍取得 lease。多 Session 的 activityId 全局独立。native stop 失败保留 blocker id 以便重试；最终 fail-safe 只在 strict Host drain 成功后执行，不在长任务等待期间提前释放。

## 7. Test Results

已完成的真实 Electron 门禁：`npm run desktop:smoke` PASS，exit 0。三个 entry（Launchpad/strict shutdown、Runtime compatibility、Background Runtime）均 exit 0，无 timeout；真正 secondary 也 clean exit。Background 34/34、Launchpad 35/35、Strict Shutdown 10/10 检查 PASS（含对应的外部退出/清理证据）。实际环境为 Windows x64、Electron 44.4.3、Electron Node 24.21.0、Chromium 152.0.7977.130。

Background A–K 证据包含：真实 close→hide；隐藏时任务完成并持久化，重开仍是同一 Session/Runtime/单次执行；真实 Tray 及菜单 actions；外部启动的第二 Electron 锁失败且创建计数为零、配置与数据库文件 SHA256 不变；真实 forcefullyCrashRenderer 与 render-process-gone，UI 恢复时任务和 blocker 存活；真正销毁窗口后重建；两 Session 重叠只有一次 start/stop、id 不变；throw 后释放；未来 schedule 零执行零 blocker；真实 HUMAN_REQUIRED→SUSPENDED 后 blocker OFF；隐藏 active 时 Tray Quit 保持 blocker 至 gate 释放，然后完成 strict cleanup、Tray destroy、真实 exit。8 个真实 Production/Runtime owner 全部关闭，最终 resource tracker 的 live 数组为空。

异常 smoke 特意保留既有 Runtime 行为：runner 抛错后 durable state 仍可能是 RUNNING，但 `hasActiveSession()` 已为 false，原错误从 Runtime Promise 传播且 blocker OFF。没有为了通过测试改 Task 终态；准确的 Error 对象 identity 另由 deterministic observer tests 证明。

首两轮 smoke 均记为 FAIL 并保留日志：第一轮新 UI entry 被 runner 的 `windowsHide` 隐藏，导致可见性断言失败；第二轮测试错误地假设 throw 后 durable state 必须离开 RUNNING。修正 runner 启动选项与断言后，第三轮完整 smoke PASS；不是通过放宽 activity、process exit 或 cleanup 检查取得通过。

机器证据及日志保存在 Git 忽略的 `artifacts/desktop/bootstrap-smoke/`：`background-runtime-result.json`（DESKTOP_BACKGROUND_RUNTIME）、`launchpad-result.json`、`strict-shutdown-result.json`、`result.json`、secondary stdout/stderr，以及 `phase2b-desktop-smoke-attempt1/2/3.log`。

专项命令：

```powershell
npm run typecheck
npm run build:tests
node --test --test-concurrency=1 dist-tests/tests/work-session-activity.test.js dist-tests/tests/work-session-strict-control-lifecycle.test.js dist-tests/tests/work-session-task-eta.test.js
node --test --test-concurrency=1 dist-tests/tests/work-session-scheduled-start.test.js dist-tests/tests/work-session-scheduled-recovery.test.js dist-tests/tests/work-session-launchpad-strict-lifecycle.test.js
node --test desktop/tests/power-tray.test.mjs desktop/tests/window-lifecycle.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.desktop.json
```

以上均 PASS；两个 TypeScript 专项集合分别 64/64、58/58，Power/Tray + Window 集合 24/24。新 `work-session-activity.test.ts` 包含 25 个 tests（含 subtests），均纳入完整 check。交错次序以 deferred gates 和 mock clock/timers 控制，不使用固定 sleep 推测竞争结果；Electron UI/OS 状态使用有截止时间的条件观察。

完整 `npm run check` 已 PASS，exit 0：主测试 1063/1063、Desktop 41/41，全部零失败、取消或跳过；typecheck、unused、migration、exports、repository boundaries 和 platform boundaries 均通过。外部 Node 为 24.14.1，PowerShell 为 7.6.5。命令仅在本次 PowerShell 进程设置 `$env:NOVAWING_GIT_BASH_PATH = 'D:/Git/bin/bash.exe'`，未修改产品 discovery 或持久环境。完整日志为 `phase2b-check.log`。

正式门禁汇总：

| 命令 | 最终结果 | 证据 |
| --- | --- | --- |
| `npm run desktop:smoke` | PASS；三个真实 Electron entry 和 secondary 正常退出，Background 34/34；cleanup PASS | `phase2b-desktop-smoke-attempt3.log`、`background-runtime-result.json`、`result.json` |
| `npm run check` | PASS，exit 0；主测试 1063/1063、Desktop 41/41，全部静态/边界门禁通过 | `phase2b-check.log` |
| `npm run pack:check` | PASS，exit 0；236 个 deterministic build files、238 个 tarball files，无 Desktop/tests/docs 泄漏 | `phase2b-pack.log` |
| `npm run consumer:selftest` | PASS，exit 0；全新 tarball consumer 的 migration/proposal/approval/context/snapshot-import/deep-import-rejection | `phase2b-consumer.log` |
| `git diff --check` / `git diff --cached --check` | PASS；提交前再次检查工作树及暂存区 | Git diff |

主测试耗时 608572.2147 ms，Desktop Node 测试耗时 10333.5699 ms（均为 runner 汇总）。已有 SQLite experimental warning 和既有 scheduled tests 的 Windows libSQL 临时句柄提示保留；没有新增失败、取消或跳过，也没有为本轮放宽原业务验收。

## 8. Security

所有创建/重建窗口保持 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`、`webviewTag=false`，没有 preload/IPC，也没有设置 backgroundThrottling=false。

Main load 与 Renderer 导航仍通过原 exact owned-origin registry；未登记 loopback、external、file、javascript 被阻止，拒绝新窗口、webview 和权限请求。原 HTTP/SSE token、Host/Origin、CSP 边界保持。第二实例命令行没有被当作导航目标。

API 行为核对了安装版 Electron 类型定义和官方 [app 生命周期/单实例文档](https://www.electronjs.org/docs/latest/api/app)、[Tray](https://www.electronjs.org/docs/latest/api/tray)、[powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)、[webContents](https://www.electronjs.org/docs/latest/api/web-contents)，实际行为以本机固定版本 smoke 为准。

## 9. Findings / Remaining Risks

- Git Bash packaged discovery 未解决；完整 check 的环境覆盖只设置于当前命令进程。
- real Codex、真实模型、真实用户数据未验证；strict 等待工作 settle，没有产品强制退出超时。
- system shutdown/logoff、force kill、断电不属于受控 Quit 证明。
- packaging、签名、安装、发布、auto update 和 macOS real-host 待后续阶段。
- Notification 留在 Phase 3，本轮不发送 COMPLETED/FAILED/HUMAN_REQUIRED 原生通知。
- 本轮 fixture 仍显式使用既有 v1 FakeTaskRunner，证明原生产 composition 与 Runtime lifecycle，不宣称 V2 真实执行认证。
- 原生资源 API 故障会记录诊断；如 OS 拒绝 blocker.start，业务 operation 按 observer 非干预契约继续执行，不能据此保证机器仍被阻止休眠。
- libSQL 临时 DB 的 OS handle 清理由外部 runner 在真实进程退出后验证；不宣称 close 返回后任何时刻都能在同进程删除文件。

## 10. Git

```text
branch: feat/v0.4-desktop
HEAD before: 526f15e75e6880b410af43a86e6c0c2bc45e181e
HEAD after: 包含本报告的提交，准确 SHA 见最终交付回复
commit: feat(desktop): keep runtime alive in background
working tree: 提交后以最终 git status 为准
```

原有未跟踪 `docs/plan/NovaWing-v0.4.0-Desktop-Architecture-Survey.md` 保留原样，不纳入本轮提交。不 push、merge 或 tag。

## 11. Verdict

PASS

全部正式 Gate 通过。后台窗口生命周期、单实例、Renderer 恢复和真实 activity 驱动的 Power 已在上述 Windows x64 隔离范围验证，Phase 2A strict shutdown 及包消费边界继续通过。本轮已完成，等待审查。

## 12. Next Step

只有 Phase 2B PASS 且审查通过后，才进入 **Phase 3 — Native Notification**，复用既有 Notification abstraction，覆盖 COMPLETED、FAILED、HUMAN_REQUIRED，以及点击通知打开对应 Session。本轮不开始 Phase 3，交付后停止等待审查。
