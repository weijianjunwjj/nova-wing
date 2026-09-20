# NovaWing v0.4.0 Phase 1 Report

日期：2026-09-20。范围：Electron Desktop Shell + isolated Main Runtime compatibility smoke。

## 1. Changes

- `desktop/main/index.mjs`：Electron Main ESM 最小静态窗口；显式关闭 Node integration，启用 context isolation、sandbox、web security。拒绝新窗口、导航、webview 和权限请求，关闭窗口退出应用。
- `desktop/tests/shell-smoke.mjs`：实际启动同一个窗口入口，验证页面可见、标题、Renderer 无 `require/process`，等待真实 `closed` 事件。
- `desktop/tests/runtime-compatibility.mjs`：实际导入 `nova-wing/development-guardian` 公开出口，验证数据库和现有 Runtime。使用既有 FakeTaskRunner，已到期的临时 schedule 也覆盖 ScheduledStartStore；保留 ledger 与持久化快照断言。
- `desktop/tests/resource-tracker.mjs` 及回归：按 asyncId 跟踪包括 unref 在内的 timer、process、TCP/PIPE/UDP/TLS 资源；防止仅按类型计数掩盖泄漏。
- `scripts/desktop-smoke.mjs` 及精确平台环境适配器：外部 Node 启动真实 Electron，临时隔离 config/data/repo/home/profile，60 秒单进程超时，仅处理自己持有的 ChildProcess。记录 stdout/stderr、JSON、退出码、子进程存活与删除结果。
- 根 scripts、Electron 精确开发依赖与锁文件；独立 `tsconfig.desktop.json` 将 Desktop JS 纳入 checkJs/unused。Desktop Main 和 tests 都进入包/平台静态检查，并增加负例测试。
- README 增加使用和门禁说明。根 package.json 没有新增 main；exports、files、正式包版本与 production dependencies 均未改变。

未修改 Runtime、Task 状态机、Golden Path、Evidence、Checkpoint、Launchpad 或 HTTP/SSE 实现。未创建 preload、IPC、后台模式、通知、电源或分发能力。

## 2. Electron Runtime

选型时核对 [44.4.3 官方发布页](https://releases.electronjs.org/release/v44.4.3)、[支持策略](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) 与 npm registry。44.4.3 是当前稳定版，Node 24 满足项目 `>=24`，Main 支持 ESM；是否支持本项目原生库由真实 smoke 验证。

| 项目 | 实际 Electron Main 输出 |
| --- | --- |
| Electron | 44.4.3 |
| Chromium | 152.0.7977.130 |
| Node | 24.21.0 |
| V8 | 15.2.124.28-electron.0 |
| modules / ABI | 149 |
| OS | Windows 11 Home / 10.0.22621 |
| platform / arch | win32 / x64 |
| execPath | 仓库 node_modules/electron/dist/electron.exe |
| cwd | 本轮 mkdtemp 目录下的绝对 repo 路径 |

开发宿主：PowerShell 7.6.5、Node v24.14.1（ABI 137）、npm 11.11.0。

安装：`npm install --save-dev --save-exact electron@44.4.3`。首次官方 Node 下载器停滞；改用同一官方 GitHub release 的 Windows x64 archive 下载并校验安装包内 SHA-256：`790a355b684d5c7cc8dc3cdd8c4cca7c4b2d054685427c7554a956879a82e70b`。没有修改业务原生依赖或执行 rebuild。runner 解析已安装的 Electron metadata，不在门禁中隐式联网下载；缺少 binary 时返回 FAIL。

## 3. Compatibility Results

```text
Desktop shell:  PASS
guardian import: PASS
node:sqlite:     PASS
libSQL:          PASS
Runtime create:  PASS
Fake task:       PASS
Runtime close:   PASS
Runtime reopen:  PASS
resources:       PASS
cleanup:         PASS
```

实际 import production / Launchpad factories，并创建原 WorkSessionRuntime。临时状态 `SCHEDULED → COMPLETED`，T1 执行恰好一次；同库重开恢复相同 session 与 completedTaskIds，重开不执行任务。两个独立数据库探针和两个 Runtime owner 都已 close。

资源基线与最终均仅为两条 stdio PipeWrap，无增量；asyncId tracker 的 live 为空。两个 Electron Main 正常退出、code 0、无 signal/timeout；已登记的 Chromium 子进程不再存活。最后在外部 Node 删除同一临时根目录成功。真实用户配置/DB、模型和 Git 写入均不参与 smoke。

本地机器可读证据：`artifacts/desktop/bootstrap-smoke/result.json`；同目录保存 shell/runtime stdout、stderr 和检查日志。证据包含本机路径，保持 Git 忽略。

## 4. Tests

| 实际命令 | 最终结果 |
| --- | --- |
| `npm run desktop:smoke` | PASS；两个真实 Electron Main code 0，无 timeout；cleanup PASS |
| `npm run check`（当前 pwsh 命令先设置 `NOVAWING_GIT_BASH_PATH=D:/Git/bin/bash.exe`） | PASS；主套件 972/972，Desktop 资源检测 1/1，均无失败/跳过 |
| check 内的 typecheck / unused / migration / exports | 全部 PASS；Desktop JS 同时通过 checkJs/noUnused |
| check 内的 boundaries / platform | PASS；分别检查 299 / 189 个源文件 |
| `npm run pack:check` | PASS；232 个确定性构建文件，tarball 234 个文件 |
| `npm run consumer:selftest` | PASS；独立安装消费、迁移、proposal/approval/context/snapshot 导入及禁止 deep import |
| `npm pack --dry-run --json` | PASS；234 个文件，Desktop/源码/测试等越界文件为 0 |
| `git diff --check` | PASS |

首次无 Git Bash override 的 `npm run check` 为 873 通过、99 失败。原因是本机原生 Git Bash 在 D 盘，未设置既有 resolver 的配置；对照基线，该 resolver 和失败测试未修改。仅为当前 pwsh 进程设置已核实的路径后完整重跑，通过 972/972。没有改用户全局环境或放宽断言。初次日志保留为 `check-initial-missing-bash.log`。

最终 smoke 已在源文件收尾后重跑，完整 check 和分发检查的日志保留于上述本地证据目录。manifest 对照进一步确认 name/version/exports/files/production dependencies 原样保留。

## 5. Risks / Findings

- Electron ABI 149 与普通 Node ABI 137 不同。本机 `@mastra/libsql@1.21.0 → @libsql/client@0.17.4 → libsql@0.5.29 → @libsql/win32-x64-msvc@0.5.29` 实际初始化和 SQL 读写成功，不需要 rebuild；不能据此声称其他 OS/arch/未来版本已经验证。若后续需要 rebuild，只应操作独立 packaging staging，不能覆盖根 node_modules。
- `node:sqlite` 在目标 Electron Main 中实际完成 DatabaseSync create/table/insert/select/close，继续使用现有数据库实现。
- Windows EBUSY：本轮 Electron smoke 在进程退出后清理成功，无 EBUSY。既有 Node scheduled-start 测试仍可能输出关闭后的临时 libSQL 句柄诊断；新 smoke 不吞 Runtime close 错误，文件清理错误另列且仍使整体失败。
- 修复了 Main ESM 顶层 await ready 导致的启动死锁；模块求值先结束，再经 ready Promise 执行。窗口 smoke 等待真实 closed 事件，不把 close() 调用当成已经销毁。
- 当前只验证 Windows x64 开发形态。macOS、packaged 路径、原生库目标平台分发、签名、ASAR、安装与更新均待后续阶段。
- `npm audit --json` 报告两个 high dependency entries（js-yaml、nodemailer）；锁文件核对确认它们的版本与基线相同。本轮未扩大依赖升级范围，此命令不属于既有 check 门禁。
- 自动审批以 `blocked by policy` 拒绝清理额外下载缓存；缓存保留在本地 artifacts/desktop 与安装器临时下载目录，均未加入提交。这与已通过的 smoke 临时数据 cleanup 是独立事项。

## 6. Git

```text
branch: feat/v0.4-desktop
HEAD before: a9936908e242c1588154a558c5aa60b283b87171
commit message: feat(desktop): add Electron shell and isolated runtime compatibility smoke
```

开始时已有未跟踪 `docs/plan/NovaWing-v0.4.0-Desktop-Architecture-Survey.md`；本轮保持原文件，不纳入实施提交。最终提交 SHA 与工作区状态见交付回复；不 push、merge 或 tag。

## 7. Verdict

**PASS**。仅代表本报告限定的 Windows x64 Desktop Bootstrap 与隔离兼容性门禁通过，不代表 v0.4.0 Desktop Runtime & Distribution 已交付。

## 8. Next Step

全部门禁通过后，下一步应为 **Phase 1 后半：Main 持有现有 Launchpad + Renderer 加载现有 HTTP/SSE UI**。本轮不继续实施，等待审查。
