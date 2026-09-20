# NovaWing v0.4.0 Phase 1B Report

日期：2026-09-20。范围：Windows x64、Electron 44.4.3、隔离 fake workload 的现有 Launchpad / Control UI 承载。

## 1. Changes

- `desktop/main/host.mjs` 创建、启动、持有和关闭既有 Launchpad，通过其已有 `createWorkSession` dependency seam 包装 Production UI 的 start/close，登记及撤销 Control origin。
- `desktop/main/window.mjs` 创建安全 BrowserWindow，加载实际 HTTP Launchpad，统一限制主进程 loadURL、Renderer 导航、重定向、请求、新窗口、webview 和权限。
- `desktop/main/navigation.mjs` 按 server owner 保存精确 HTTP loopback origin，支持不同端口、多 owner、关闭撤销。
- `desktop/main/index.mjs` 替换 Phase 1 静态页，实际执行 ready → fixture → Host → Launchpad → BrowserWindow；最后一个窗口关闭后经 before-quit 等待 Host close。
- `desktop/main/isolation.mjs` 在 Electron ready 前校验绝对 config/data/repo，设置临时 userData/sessionData/crashDumps。`isolated-fixture.mjs` 通过现有依赖注入点限制外部能力，并将已有 FakeTaskRunner 注入真实 WorkSessionRuntime。
- `scripts/desktop-isolation.mjs` 为 dev/smoke 创建全新临时目录、解析已安装 Electron binary、验证删除目标；`desktop-dev.mjs` 使交互开发入口同样只使用隔离环境。
- `desktop/tests/launchpad-smoke.mjs` 替换旧静态 shell smoke；另加 fixture 真实工厂回归与精确 origin registry 回归。已有 runtime compatibility / resource tracker 保留。
- smoke runner 输出完整 `DESKTOP_LAUNCHPAD_SMOKE`，由外部 Node 补充真实进程 exit、Chromium 子进程检查及清理证据；README 和 Desktop JS 检查范围同步更新。

业务 packages、HTTP/SSE UI、Root exports/files、production dependencies、Electron 版本及锁文件均未修改。未添加 preload、IPC、Tray、后台模式、single instance、通知、电源或分发功能。未触碰已有未跟踪 Survey。

## 2. Desktop Host Architecture

```text
Electron Main
  → Desktop Host
    → existing createNovaWingLaunchpad()
      → existing createProductionWorkSessionUi()
        → existing WorkSessionRuntime
          → existing FakeTaskRunner（仅本轮隔离 fixture）

BrowserWindow
  → Launchpad HTTP origin
    → existing Composer + token/auth + create API
      → Host 登记 Control HTTP origin
        → existing window.location.assign(controlUrl)
          → existing Control UI fetch + EventSource
```

Host 不定义 Task 状态机、不判定 COMPLETED、不复制 Production wiring、不创建第二个 Runtime。包装的 start 先等待已有 Control server listen，再登记其实际 origin，最后才返回 address；Launchpad 随后返回 create API 的 controlUrl。关闭包装在 finally 撤销该 owner。

Fixture 有意将其生成的临时 config 显式保存为 `controlPlane: 'v1'`，Production UI 与 Runtime 使用一致定义。现有 FakeTaskRunner 不提供 V2 Controller completion authorization；本轮没有伪造 V2 授权。这证明 Host/UI/HTTP/SSE 集成，不证明 Golden/V2 真实执行链。

## 3. UI Integration

| 项目 | 实际验证 |
| --- | --- |
| Launchpad HTTP | 200，原 HTML/CSP，正确标题和可见窗口；原 app.js 的 analytics 渲染及 Composer 点击处理生效 |
| Launchpad API | Renderer 原生 fetch 成功；无 token 的 create 请求返回 403；原 Composer 带既有 token 提交返回 202 |
| Control UI HTTP | 不同随机端口，原 window.location.assign 跳转成功；原 /api/status 返回 RUNNING 后 COMPLETED |
| SSE | 原生 EventSource，通过 Chromium Network.eventSourceMessageReceived 观察 connected 和 snapshot；释放 fake task 后原 UI 显示“已完成” |
| Navigation registry | 只登记 Host 所有服务；Control URL 在返回 Renderer 前登记；对应 Control close 后撤销 |
| Renderer reload | session ID、startedAt、completedTaskIds 保持一致；实际 persisted workflow snapshot 前后一致；Production UI、Runtime、Task、Fake execution 均仍为 1 |

Smoke 通过页面 Composer 创建并启动 Session；没有直接调用 runtime.start 代替 UI 路径，没有 mock Renderer fetch/EventSource，没有替换原 view。

## 4. Test Results

开发宿主：PowerShell 7.6.5、Node v24.14.1、npm 11.11.0。实际 Electron Main：Electron 44.4.3、Node 24.21.0、Chromium 152.0.7977.130、V8 15.2.124.28-electron.0、ABI 149、win32/x64。

| 实际命令 | 结果 |
| --- | --- |
| `npm run desktop:smoke` | PASS；真实 UI 与 runtime compatibility，两轮 Electron code 0，无 timeout；子进程退出及临时目录 cleanup PASS |
| `node scripts/desktop-smoke.mjs`（加强 close 触发证明后） | PASS；完整 Launchpad 29 项门禁，close 前确认实际 before-quit 已触发 Host close |
| `npm run check`（当前 pwsh 命令设置 `NOVAWING_GIT_BASH_PATH=D:/Git/bin/bash.exe`） | PASS；主测试 972/972、Desktop 6/6，无失败或跳过 |
| check 内的 typecheck / unused / migration / exports | 全部 PASS，含 Desktop checkJs/noUnused |
| check 内的 boundaries / platform | PASS；分别检查 308 / 198 个源文件，精确平台 allowlist 未扩大 |
| `npm run pack:check` | PASS；两轮确定性构建 232 个文件，tarball 234 个文件 |
| `npm run consumer:selftest` | PASS；全新临时 consumer 安装、migration/proposal/approval/context/snapshot 导入及 deep-import 拒绝 |
| `git diff --check` | PASS；提交前同时检查 staged patch |

机器可读证据保存在 Git 忽略的 `artifacts/desktop/bootstrap-smoke/`：

- `launchpad-result.json`：完整 UI/security/ownership/close/exit/cleanup。
- `result.json`：UI 与兼容性两轮结果、真实退出码、已登记子进程、超时及清理结果。
- `launchpad-smoke.stdout.log` / `.stderr.log`、`runtime-compatibility.stdout.log` / `.stderr.log`。
- `phase1b-*.log`：各正式门禁及诊断运行。

开发中的实际诊断保留：Windows `windowsHide:true` 会让目标窗口不可见，UI smoke 明确使用 false；窗口 closed 与 before-quit 并非同一时刻，测试先订阅并等待两个真实事件，再断言 Host 已经由应用触发关闭，最后只等待已有共享 promise。失败时输出真实 FAIL，不回退静态页。

## 5. Security

- BrowserWindow：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、`webviewTag:false`，无 preload；Renderer 的 require/process 均为 undefined。
- Allowed origins 仅为 Host 已启动的 Launchpad 和已登记的 Control server 精确 origin。127.0.0.1 只是候选地址格式，不能自行赋予信任；其他端口、localhost 别名和凭据 URL 不被信任。
- Main loadURL 在调用前验证，Renderer 导航和 redirect 受事件拦截，session webRequest 额外拒绝未登记地址。保留原 HTTP API 的 token、Origin/Host 检查及 CSP。
- 实测 https://example.com、活动但未登记的随机 127.0.0.1/localhost 服务、file:、javascript: 均未离开 Control UI；随机服务收到 0 请求，javascript sentinel 未执行。file/javascript 也受 Chromium 与原 CSP 限制，不把它们都归因于 navigation event。
- window.open 返回 null、窗口数不增加；webview 未附加；权限请求被拒绝，实测 Notification permission 为 denied。
- config/data/repo/home/profile 全部来自新 mkdtemp 根，裁剪继承环境，不加载真实用户配置、DB、repo、scheduler 状态。fixture 只接受自身 repo、立即执行、无 autoCommit/autoPush/email；真实模型/Git/repair 能力 fail closed，smoke 禁止能力尝试计数为 0。

## 6. Runtime Ownership

Runtime 由 Main 内既有 Production Work Session 持有。Renderer reload 前后生产工厂创建数、Runtime 创建数、Task run 和 Fake execution 均为 1；同一 durable snapshot 保留。Renderer 只是原 HTTP/SSE 控制界面。

关闭验证等待真实 window closed 和 app before-quit，在测试调用 shutdownDesktop 前断言 Host closeCalls 已为 1；随后等待同一关闭 promise。Runtime close 成功 1 次、Control close pending 为 0、错误列表为空、对应 Control origin 确实已 unregister。外部 runner 独立确认 Electron Main 和登记的 Chromium 子进程退出，然后删除临时数据。

## 7. Findings / Risks

1. **Launchpad shutdown 尚不严格。** `packages/development-guardian/work-session/launchpad/server.ts:644` 的 close 在 645 对重入早退；648/654/658–668 使用 bounded，2150 的 helper 在 2156 通过 Promise.race 到时返回，并不取消或保证 drain。659/663/667 的 allSettled 结果未传播，670 清空 liveApps。activeDeletes 和部分 manual repair 路径也未纳入完整 drain。本轮只记录，不重构。
2. **Start/close race 保留。** 同一 Launchpad start 的初始 closed 检查位于异步 hydrate/preflight 之前，607 的 listen 与 622 的 interval 可迟到。Desktop Main 在 Host 尚未赋值时收到 quit，也可能缓存空 close promise；Host.start 在 await 后没有完整关闭竞争协议。当前 Host 观察已进入 Control close 的 pending/errors，不能证明所有迟到创建和启动都已结束。
3. **关闭错误链存在缺口。** `packages/development-guardian/work-session/production.ts:961` 先 await server.close（962），后 runtime.close（963），前者失败会跳过后者；`packages/development-guardian/work-session/control-ui/server.ts:104` 先关闭 HTTP（112），再 controller.close（116）。既有 Runtime 自身已在 `packages/development-guardian/work-session/runtime.ts:2506–2510` 共享 close promise，2513 起 drain，2539 汇总错误；下一步应补齐外层 owner 链。
4. **动态 Control 端口。** 本轮通过真实跨端口导航证明登记时序，并测试撤销。后续恢复、异常 listen、启动中关闭、并发删除等应在 strict lifecycle 阶段覆盖，不能扩为任意 loopback 白名单。
5. **Git Bash discovery。** 全量 Node check 的 D 盘 Git Bash override 仅存在于当前命令进程；产品不硬编码该路径、不改全局环境、不使用 shell:true 或 WSL fallback。隔离 UI fake smoke 不执行真实 Git。packaged / real-host dependency discovery 仍是后续风险。
6. **SQLite/libSQL。** 真实 Electron Main 中 node:sqlite/libSQL create/read/write/close、原 Runtime 的持久化关闭重开再次通过；没有 rebuild 或修改原生依赖。这只证明当前 Windows x64 / ABI 149 组合，不能外推到其他 OS/arch、packaged 路径或未来 Electron 版本。
7. **Electron lifecycle 证据范围。** ESM 不在模块顶层等待 app ready；profile 在 ready 前设置。测试只证明已完成的隔离 fake workload 正常关闭。Electron app.quit 不保证采用 process.exitCode，因此 runner 同时验证机器 JSON 的 PASS 与 OS 退出状态；不能只凭 code 0 判断成功。

## 8. Git

```text
branch: feat/v0.4-desktop
HEAD before: 8a685aef0180ef86b1f4299ee999f0167054f6e0
commit message: feat(desktop): host existing launchpad in Electron
```

全部门禁通过后才提交本报告与实现。HEAD after 为包含本报告的实施提交，准确 SHA 及提交后的 working tree 在交付回复中记录。原有未跟踪 `docs/plan/NovaWing-v0.4.0-Desktop-Architecture-Survey.md` 保持原样，不纳入提交。不 push、merge 或 tag。

## 9. Verdict

**PASS**。仅代表 Windows x64 上的本轮隔离 Desktop Bootstrap、现有 UI 承载与回归门禁通过；不代表生产级 strict shutdown、真实模型执行或跨平台分发已完成。

## 10. Next Step

本轮通过后先进入 **Phase 2A — Strict Desktop Host Shutdown + Runtime Lifecycle**：app quit、Launchpad/Runtime drain、shutdown 时拒绝新任务、共享 close promise、关闭错误传播、start/close race。

完成 Phase 2A 后才进入 **Phase 2B — close→hide + Tray + single instance + Prevent Sleep**。本轮停止并等待审查。
