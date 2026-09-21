# NovaWing v0.4.0 Phase 4 Report

日期：2026-09-21。当前结论 **BLOCKED（等待 installed/manual real-host）**。自动测试、Windows 包、安装版真人证据严格分开；未完成项不记作 PASS。

当前优先阻塞项：安装版 Tray/Toast 唤醒短暂白屏。其他人工 Gate 暂停；窗口修复、新安装包及等待点见 [白屏修复报告](NovaWing-v0.4.0-Window-White-Screen-Blocker.md)。下面 Quick Fill 安装包与早期 Phase 4 记录均为历史证据，当前 installer 以白屏报告为准。

最新更新：用户已确认旧包安装/开始菜单启动、close→hide、真实 Codex COMPLETED、Verification/Evidence/Checkpoint（`888a2e5`）及系统通知出现。现暂停其余人工验收，优先处理 Quick Fill Release Blocker。新包与本轮门禁见 [Quick Fill 修复报告](NovaWing-v0.4.0-Quick-Fill-Blocker.md)；旧 installer obsolete。下面第 1–17 节是此前自动化交接快照，其中“尚未安装/没有 checkpoint”等表述为历史状态，不覆盖此更新。

## 1. Changes

- 正式 packaged Main 接入原 Production Launchpad/Work Session；开发/smoke 保持隔离 fake fixture。未重设计 Phase 1–3 生命周期、Runtime 或 HTTP/SSE。
- 固定产品身份，Main 极早设置 Windows AUMID/Toast CLSID。
- Windows Git installation resolver：注册表、自定义盘符、可验证的 PATH installation、标准目录；直接 Git 调用统一为绝对 executable，SDK 的实际子进程使用同安装的 PATH。
- 独立 staging、production dependency graph、package 内容审计、外部 Node 驱动的 packaged smoke、NSIS 构建和 SHA256 记录。
- 正式 GUI 启动留下安全的本地生命周期诊断；预备独立真实任务 repo，尚未代写任务目标文件。

## 2. Packaging Architecture

`artifacts/desktop/staging/` 包含独立 package.json、desktop/main/assets、dist/packages 与 production node_modules。manifest 保留 `name=nova-wing`、`type=module`、原 exports/dependencies，支持 `nova-wing/development-guardian` self-reference。产品版本 0.4.0，根 npm kernel 0.1.0 未变；原 exports/files/production dependencies 未变。

依赖复制以 lockfile production graph 和目标 win32/x64 为依据；无 root rebuild，`npmRebuild=false`、`nodeGypRebuild=false`。真实库加载通过后不再引入 rebuild 变量。`asar=false`。打包使用已固定且实际存在的 Electron distribution，不隐式选择新版 Electron。

package smoke 在系统 Temp 下创建完整 package 副本，物理位置位于源码之外，清除 NODE_PATH 等继承覆盖；仅验证副本加入测试入口、临时修改 main 来运行既有 harness。每个子进程仍由真正 NovaWing executable 启动，`app.isPackaged=true`，模块与 native binary 位于副本 resources/app。交付树不含 harness/fixture。独立 production smoke 使用原 Main 的无 fixture 分支，检查真实 Launchpad、Window、Tray、strict close。

NSIS 前核对 package smoke PASS 及完整 app 内容 SHA256；防止旧证据认证新包。

## 3. Product Identity

| 字段 | 值 |
| --- | --- |
| productName | NovaWing |
| Desktop version | 0.4.0 |
| root npm version | 0.1.0 |
| appId / AUMID | io.github.weijianjunwjj.novawing |
| ToastActivatorCLSID | {5F5D220B-E789-5710-A023-D7CA6AD8E382} |
| Electron / embedded Node | 44.4.3 / 24.21.0 |
| build host Node | 24.14.1 |
| electron-builder | 26.15.3（npm registry 当前 stable，精确锁定） |
| target / arch | NSIS / x64 |

Main 和 builder 共用 committed identity。NSIS 模板实际调用 `WinShell::SetLnkAUMI` 写相同 APP_ID。CLSID API 在 Main lock、BrowserWindow、Tray、Notification 前执行；[Electron API](https://www.electronjs.org/docs/latest/api/app#appsettoastactivatorclsidid-windows) 要求早期设定，但这不是 installed shortcut/真人点击已经成功的证据。配置依据 [electron-builder v26](https://www.electron.build/v26/docs/configuration/)。

## 4. Package Contents

`PACKAGED_CONTENT_AUDIT: PASS`；staging 8436 files，最终 resources/app 5309 files（builder 继续过滤 dependency 开发元数据）。机器清单：`artifacts/desktop/packaged-content-audit.json`。

检查 Main、ICO/Tray PNG、runtime dist、SDK→CLI→win32-x64 vendor、codex.exe、code-mode-host、rg、command-runner、sandbox-setup、codex-package manifest、libSQL `.node`。原始 production dependency version/integrity 与 HEAD lockfile 比较无变化。

不含源码 tests/docs/.git/.env、业务 DB、日志、临时 repo、Desktop fixture、Electron/builder/TypeScript 开发依赖。第三方依赖运行时代码/许可证和原有 runtime exports 保留。

## 5. Git / Bash Discovery

自动 packaged probe 在无 `NOVAWING_GIT_BASH_PATH`、无 NODE_PATH、外部 cwd 下：

```text
source: registry
root: D:\Git
bash: D:\Git\bin\bash.exe
git: D:\Git\cmd\git.exe
direct git / bash git: git version 2.47.1.windows.1
```

必须存在 Bash、cmd/git 和 MSYS DLL，并通过原生 MINGW/msys 与 Git for Windows version fingerprint。拒绝 WSL/System32/WindowsApps、裸 bash、缺失 installation、错误 fingerprint；显式无效 override 不退回其他来源。缓存按 discovery 输入区分，仅进程内生效，不写系统 env。

preflight/verifier Bash 复用 Platform shell contract；production/checkpoint/MCP/legacy recovery/executor checkpoint 的直接 Git 使用同 resolver。Codex SDK 子进程 PATH 只在真实实例创建处准备，纯配置/环境过滤函数保持可测试的无宿主副作用契约。

**Start Menu installed discovery：待人工启动及后续读回，未认证。**

## 6. Codex Packaged Runtime

`codex_packaged_resolver: PASS`，`codex --version: codex-cli 0.151.0`。真实路径位于外部 Temp package 副本的 `resources/app/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`。

没有全局 Codex/PATH fallback。全部 vendor helpers/resources 保留；CLI、libSQL 解析路径与实际加载 native modules 检查必须处于 package 内。未重命名或破坏源码 node_modules；利用独立物理祖先路径证明解析隔离。

## 7. SQLite / libSQL

unpacked：node:sqlite create/insert/select/close PASS；真实 `@libsql/win32-x64-msvc/index.node` 位于 package 内，SQL create/insert/select/close PASS；原 Runtime create、fake task、ledger/snapshot、close、reopen、无重复执行、资源归零 PASS。

installed：仍待真实安装后验证，不能用 unpacked 结果替代。

## 8. Windows Installer

```text
filename: NovaWing Setup 0.4.0.exe
path: D:\VSCode\nova-wing\artifacts\desktop\NovaWing Setup 0.4.0.exe
size: 218039664 bytes
SHA256: b8c777bde5c14592b9b76c2df6a88bc96cdb0c2ed4fed525ea1136b99bdcd1b2
signature: NotSigned（Get-AuthenticodeSignature 实测）
install path: NOT_OBSERVED
Start Menu launch: NEEDS_MANUAL_VALIDATION
uninstall/reinstall: NEEDS_MANUAL_VALIDATION
SmartScreen: EXPECTED / NOT_OBSERVED
```

oneClick、per-user、Start Menu + Desktop shortcuts、正确 app ICO；没有目录向导、服务、开机启动、updater 或 publish。卸载配置不删除业务 data。builder 日志出现 signing 阶段标签不代表已签名；以上以实际 Authenticode 结果为准。

## 9. Native Notification Real-host

```text
native provider / Main routing (automated): PASS
visible Toast (installed human): NOT_OBSERVED
human click: NOT_OBSERVED
correct Session (human click): NOT_OBSERVED
Action Center (running installed app): NOT_OBSERVED
cold-start activation: DEFERRED
```

仍需 COMPLETED 和 HUMAN_REQUIRED 的真人视觉/点击；FAILED 建议补测。现有对象保留最长 15 分钟，超出生命周期或 cold start 的 Session 关联未实现，不伪报。

## 10. Real Codex Task

专用 repo：`C:\Users\Administrator\AppData\Local\NovaWingAcceptance\desktop-realhost-20260921-151419`。

```text
branch: desktop-realhost-smoke
base commit: 43c77bb504edc601a9cc56aa9dfa0310f18437b9
task: src/sum.mjs + test/sum.test.mjs, node:test positive/negative/zero
allowed paths: those two files only
autoCommit: true
autoPush: false
remote: none
real Codex result / verification / evidence / checkpoint: NOT_RUN
```

只创建了测试仓库与 package.json，未代写任务实现/测试。需 installed GUI 启动后通过现有 Composer，保留当前 V2/Golden production 配置。参数保存在 ignored `artifacts/desktop/realhost-task.json`。

## 11. Background Runtime Real-host

unpacked automated：close→hide、Tray、真正第二实例、renderer recovery、HTTP/SSE、powerSaveBlocker、strict Quit、Runtime reopen 均 PASS。

installed actual task 的后台持续执行、Prevent Sleep、strict quit/restart、无重复 task/checkpoint/notification：待真人步骤及 durable evidence，未认证。

## 12. Test Results

| 命令 | 结果 |
| --- | --- |
| `npm run desktop:package:dir` | PASS |
| targeted shell 8 cases | PASS |
| targeted Codex + Git discovery 28 cases | PASS |
| `npm run desktop:smoke` | PASS，四个 Electron entry + secondary + cleanup |
| `npm run desktop:package:smoke` | PASS，五个 packaged entry + secondary + cleanup |
| `npm run desktop:build:win` | PASS，NSIS generated |
| `npm run check`（仅完整运行一次） | exit 1：业务 1097/1097、全部静态门禁 PASS；Desktop 62/63，唯一失败为旧 Phase 3 identity=null 断言 |
| `npm run check:desktop`（精确身份断言更新后） | PASS，63/63；Desktop checkJs/unused、platform 也再次 PASS |
| `npm run pack:check` | PASS，240 个确定性构建文件 / 242 个 tarball 文件 |
| `npm run consumer:selftest` | PASS，独立 tarball consumer 全部契约通过 |
| `git diff --check` | PASS |

没有为小修改反复运行完整 check。最终 check 不设置 Git Bash override。原始日志均在 ignored `artifacts/desktop/phase4-*.log`。完整命令的原始 exit 1 不改写为 exit 0；最小修复仅更新既有 identity test 为精确 appId/CLSID/version 和 Object.isFrozen 断言，产品代码与已验收包均未变化，故只复跑 Desktop tests/typecheck/platform。

失败定位与修复：npm 首次安装只有 electron-winstaller tgz 请求 EIDLETIMEOUT；从同一官方 registry 下载该 tgz 填充 cache，随后 offline install 成功，未增加 timeout。初版把宿主 Git discovery 放入纯 Codex env 过滤函数，专项测试暴露无宿主环境 fixture 的失败；移到真实 SDK 创建边界，28 targeted PASS。首轮 package smoke 新探针错误使用 CommonJS resolve 解析 ESM-only SDK（ERR_PACKAGE_PATH_NOT_EXPORTED）；产品 resolver/Codex version 已通过，修正探针为 import.meta.resolve，仅重跑 package gate，五 entry 全 PASS。保留首轮失败 JSON，不计为 PASS。

## 13. Security

沿用 sandbox、context isolation、无 Node Renderer、无 preload/业务 IPC、exact owned origins、既有 token/Origin/Host/CSP。staging 只复制允许的生产树；机器拒绝 tests/docs/secrets/data/logs/symlink。源码依赖不会被 native rebuild 覆盖。任务 repo 无 remote，不 push。包装/日志/安装包全部 ignored。

## 14. Remaining Risks

Windows unsigned/SmartScreen；未验证 installed Toast identity、真人 click 和真实 Codex 链；系统 shutdown/force kill/断电；macOS；GitHub Actions；Auto Update。没有实现后四项，也没有用自动化替代人工证据。

## 15. Git

```text
branch: feat/v0.4-desktop
HEAD before: 1ce8111065051a7256d73a2d61d1551ea4fccf37
HEAD after: 1ce8111065051a7256d73a2d61d1551ea4fccf37
commit: NOT_CREATED (all-gates condition not met)
working tree: Phase 4 implementation/report remain uncommitted
```

原有未跟踪 Survey 保留原样，不纳入本轮实现。未 push、merge、tag。用户要求全部通过后才 commit；人工硬门禁未完成，故当前不能提交指定 feat commit。

## 16. Verdict

**BLOCKED**：已推进到需要实际安装、Start Menu 和真人 Toast 的位置；不宣称 Phase 4 PASS。

自动子门禁在上述定向修复后均已满足；完整 check 原始失败及最小复跑范围保留。安装器已生成并核验 unsigned 状态，尚未观察实际安装、真人通知点击或 installed real Codex，不存在 checkpoint SHA 可报告。

## 17. Next Step

按 [最少人工操作及等待点](NovaWing-v0.4.0-Phase-4-Manual-Acceptance.md) 完成安装并从 Start Menu 启动，再收集真实 Task、Toast、restart 和 uninstall 证据。全 Gate 通过后才提交 `feat(desktop): package Windows desktop app`；不开始 Phase 5。
