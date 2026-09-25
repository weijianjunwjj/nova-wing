# NovaWing v0.1 独立内核切片

## 可安装包与 Host Snapshot V3

仓库根包为 `nova-wing@0.1.0`，正式私有发布包为
`@weijianjunwjj/nova-wing@0.1.0`，要求 Node.js 24 或更高版本。仓库根继续保留
`"private": true` 和 `UNLICENSED`，用于阻止未经授权的真实发布；正式 manifest 仅在被
Git 忽略的 `release-package/` 内生成。本地构建和 tarball 验收不受影响。

安装者只能从以下四个公共入口导入，类型声明和运行时代码都来自 `dist/`：

```text
@weijianjunwjj/nova-wing/core
@weijianjunwjj/nova-wing/sqlite
@weijianjunwjj/nova-wing/testing
@weijianjunwjj/nova-wing/host-snapshot
```

`package.json#exports` 拒绝源码、migration、registry 等深层路径。可分发包只包含构建后的
`.js`、`.d.ts`、本 README 和 package metadata，不包含源码、测试、脚本、设计文档、
source map 或临时 SQLite 文件。

```bash
npm run build
npm run check
npm run pack:check
npm run consumer:selftest
npm run release:prepare
npm run release:inspect
npm run release:selftest
npm audit
```

`pack:check` 连续构建两次，比较 `dist/packages` 文件清单及逐文件 SHA-256，并审计
`npm pack --dry-run --json` 的白名单。`consumer:selftest` 真实生成 tarball，在系统临时目录
创建全新项目，以 `--ignore-scripts` 安装，然后验证四个公共入口、migration、提案创建与
批准、Context 读取以及深层导入拒绝。两个命令都不发布包。

`novawing.snapshot.v3` 是 SQLite adapter 已有的 NovaWing 子系统 manifest；
`host.snapshot.v3` 是本切片新增的宿主组合 manifest。`@weijianjunwjj/nova-wing/host-snapshot` 只提供类型、
manifest 构造与验证、显式 registry、NovaWing 组件 adapter 和生命周期协议，不提供任何具体
宿主的导出、恢复或文件替换实现。

组件必须显式注册。同一权威表只能属于一个组件；宿主组件不能声明 `nw_*`，NovaWing
组件必须且只能声明冻结的三张权威表。表与组件顺序不影响摘要；未知组件、格式、版本、
缺失组件、摘要篡改或任一组件恢复后校验失败都会拒绝整个组合快照。

生命周期顺序为：停止新请求、排空活动操作、关闭全部写连接、打开专用连接、导出或恢复到
隔离候选库、校验组件 manifest、校验组合 manifest、执行全部恢复后校验、原子替换或宣布
成功、重新打开运行时连接。运行中的生产文件禁止原地部分恢复，任一组件失败都不得产生
半成功状态。

Host Snapshot V3 技术决策见
[`docs/adr/0002-distribution-source-and-host-snapshot-v3.md`](docs/adr/0002-distribution-source-and-host-snapshot-v3.md)；
GitHub Packages 发布与不可变消费策略见
[`docs/adr/0003-private-github-packages-and-immutable-consumption.md`](docs/adr/0003-private-github-packages-and-immutable-consumption.md)。

本仓库当前实现 NovaWing 的独立、离线、可测试领域内核。它只保存经过人工批准的跨应用长期主线，不保存或推导任何宿主领域的当前状态。

本切片使用临时独立 SQLite 文件验证闭环；没有连接、修改或引用真实 OfferFlow 源码与数据库。冻结 PRD 保持原样。

## 已实现闭环

```text
宿主提交证据化提案
→ draft → pending
→ 用户编辑后批准，或拒绝
→ 单个 BEGIN IMMEDIATE 事务追加主线、终结提案、递增 revision
→ 宿主通过 Facade 重新读取同一读事务中的最新主线快照
```

终态为 `approved` 或 `rejected`，不能再次转换。同一提案由状态条件、`source_proposal_id UNIQUE`、`applied_core_revision UNIQUE` 和 revision CAS 共同保证最多生效一次。

## 目录

- `packages/core`：领域类型、状态转换、稳定错误、存储端口与 `NovaWingFacade`。
- `packages/development-guardian`：仅供本仓库开发与本地运行使用的 Work Session、Guardian、Provider 路由和 Launchpad；不进入正式私有发布包。
- `packages/sqlite`：仅使用 `nw_` 表的 migration、追加式持久化和事务实现。
- `packages/testing`：只依赖 Facade 的 `FakeOfferFlowHost` 合约适配器。
- `tests`：领域、SQLite、并发/重复请求、重启和假宿主闭环测试。
- `scripts`：migration 确定性与仓库/领域边界检查。

## 公共包出口

调用方只能使用以下 package subpath：

```text
@weijianjunwjj/nova-wing/core
@weijianjunwjj/nova-wing/sqlite
@weijianjunwjj/nova-wing/testing
@weijianjunwjj/nova-wing/host-snapshot
```

根工作区还提供仅供 NovaWing 本地开发使用的 `nova-wing/development-guardian`；
正式 `@weijianjunwjj/nova-wing` 私有包不导出该入口。`package.json#exports` 会拒绝
`packages/*/src`、domain、migration 等深层路径。`npm run check:exports` 同时校验根工作区运行时键和深层导入拒绝行为。

## SQLite 连接所有权

- `openSqliteNovaWingStore` 创建并拥有连接，固定执行 migration，`close()` 负责关闭底层连接。
- `createInjectedSqliteNovaWingStore` 永不关闭注入连接；调用方必须明确选择 `migrationMode: 'apply' | 'validate'`。
- 所有 NovaWing 读写事务都要求连接处于 idle。若宿主已开启事务，NovaWing 返回 `TRANSACTION_OWNERSHIP_CONFLICT`，不会嵌套 `BEGIN`，也不会提交或回滚宿主事务。
- `close()` 可重复调用；关闭 wrapper 后不能再调用 Store，但注入连接仍归宿主所有。

宿主基础设施层可以注入连接，但业务层只持有 `NovaWingFacade`，不得获得原生连接、Store 或 `nw_*` SQL。

## Snapshot V3 合约

SQLite 包公开固定三表注册表、manifest 类型、导出前校验和恢复后校验。manifest 包含格式 `novawing.snapshot.v3`、版本 `3`、NovaWing schema version、`currentCoreRevision`，以及每张权威表的行数和 SHA-256 内容摘要。

当前只提供 NovaWing 自身合约；数据复制仅存在于测试宿主夹具，不代表真实 OfferFlow Snapshot 已接入。

## 本地验证

要求 Node.js 24（使用内置 `node:sqlite`）。测试运行时不访问网络。

```bash
npm install
npm run check
```

单独命令：

```bash
npm test
npm run typecheck
npm run check:migration
npm run check:exports
npm run check:unused
npm run check:boundaries
```

## Launchpad 与跨平台本机状态

Development Guardian Work Session 已实现串行 Task、独立确定性验证、Git checkpoint、
持久化暂停/恢复、Codex/DeepSeek 执行器路由及本地 Launchpad。它是受控的本地
development control surface，不改变 NovaWing 领域内核的权威数据边界。

当可信 Work Session 配置启用邮件通知时，可一次性保存 SMTP notification secrets：

```bash
npm run guardian:notification:setup -- --from-env
```

Node.js 24+ 下，Windows、macOS、Linux 均使用 `npm run guardian:launchpad`。
macOS/Linux 需要 PATH 上可执行的 Bash 与 Git；Windows 使用原生 Git for Windows Bash，
可通过 `NOVAWING_GIT_BASH_PATH` 指定安装位置，拒绝 WSL/System32/WindowsApps shim。
Windows 的 `NovaWing.vbs` 是可选启动器。V2 普通任务不依赖 AskBridge；V1 的安装与登录
使用 `guardian:chatgpt:install` / `guardian:chatgpt:login`，安装脚本从固定版本和补丁源码构建，
需要 Git、Rust/Cargo 以及第三方 Bridge 所需浏览器。安装目录统一为 `~/.local/bin`，
Windows 文件名带 `.exe`，其他平台不带；`NOVAWING_ASK_BRIDGE_PATH` 可覆盖。

| OS | Config / secrets | Data（SQLite、analytics、execution、ETA、audit） |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%/NovaWing` | 同左 |
| macOS | `~/Library/Application Support/NovaWing` | 同左 |
| Linux | `$XDG_CONFIG_HOME/NovaWing`，默认 `~/.config/NovaWing` | `$XDG_DATA_HOME/NovaWing`，默认 `~/.local/share/NovaWing` |

`NOVAWING_CONFIG_DIR` 覆盖可信 task config 目录；`NOVAWING_DATA_DIR` 覆盖数据根目录。
SMTP 位于 config 根下的 `secrets/smtp.json`；Windows 使用经验证、禁止继承的当前用户
ACL，macOS/Linux 使用 `0700` 目录和 `0600` 文件。保护失败不会写入 secret，替换失败
保留旧文件。此保护不是静态加密。完整 7 个 SMTP 环境变量优先，部分配置 fail closed。
桌面通知是可选能力：Windows Toast；macOS/Linux 无此 adapter 时返回 SKIPPED，不阻断任务或邮件。

V2 Controller 可显式启用 Jev next-action shadow（只观察，不参与 dispatch）：

```bash
export NOVAWING_JEV_SHADOW=1
export TYPESAFE_API_KEY='...'
export NOVAWING_JEV_MODEL='jev-latest'              # 可选
export NOVAWING_JEV_BASE_URL='https://api.typesafe.ai' # 可选，测试可指向本地 server
```

Shadow 记录以 JSONL 追加到 data 根目录的 `jev-shadow-decisions.jsonl`；请求只包含结构化
allowlist，不包含源码、prompt、路径、原始 evidence/provider 输出或密钥。网络、鉴权、限流、
超时与响应校验失败全部 fail open，不改变 `TaskController` 的权威动作。运行
`npm run jev:shadow:report` 可查看 match、混淆矩阵、p50/p95、confidence 与 token 汇总；
报告只保存 token 数，不在 runtime 中固化价格。

旧版本错误写入 POSIX `~/AppData` 或 `~/.novawing/NovaWing` 的数据不会自动合并或删除。
需要保留旧 session 时，先关闭旧 runtime，备份后迁移对应配置/数据，或显式配置旧路径；
SQLite session URL 已写入可信 config 的继续沿用原位置。
平台实现仅允许出现在明确 allowlist 的 adapter；`npm run check:platform`（已接入 `check`）
阻止 common runtime 再引入 OS 路径、工具、环境变量和 locale 硬编码。


## Desktop Native Notification（v0.4.0 Phase 3）

```powershell
npm run desktop:dev
npm run desktop:smoke
```

`desktop:dev` 先 build，再以全新临时 config/data/repo/home/profile 启动 Electron Main。
Main 内的薄 Desktop Host 调用现有 Launchpad，BrowserWindow 加载它的真实 HTTP UI；
普通关闭窗口只隐藏；Main、Tray、Host 与正在执行的 Runtime 保持存活。
Tray 提供打开、当前活动状态、隐藏、退出；只有明确 Quit 才调用 Host → Launchpad strict close，
等待已接纳工作和通知投递 drain，最后释放 Notification、Power、Tray、窗口并退出。
Control 与 Launchpad 在 drain 后清理尚未产生 HTTP request 的 TCP 预连接，避免浏览器预连接拖住退出。
重复 Quit 复用同一 shutdown Promise；关闭失败输出结构化错误并保持停止接纳状态。
此入口只接受终端输出的临时 repo：Composer 的 branch 使用 `desktop-smoke-fixture`，
allowed paths 使用 `fixture.txt`，关闭 auto commit、auto push 和 email。
Session 通过现有 Production Work Session 工厂创建，执行既有 FakeTaskRunner。
fixture 显式使用 v1 协议；不运行真实模型、Git 写入或用户历史任务，不是 V2 执行认证。

`desktop:smoke` 验证真实 Composer → 创建 Session → 不同随机端口的 Control UI，
原生 fetch/EventSource、完成状态、持久化及 reload 后不重复 Runtime/任务。
导航仅信任 Host 已登记的 Launchpad/Control 精确 origin，关闭 Control 时撤销；
外部网址、其他本机服务、file/javascript、新窗口、webview 和权限请求均被阻止。
保持 nodeIntegration=false、contextIsolation/sandbox/webSecurity=true，无 preload/IPC。
同时保留 Phase 1 的 production 导入、node:sqlite、libSQL、Runtime close/reopen 与资源检查。
Phase 2A 还验证执行中的第二个 gated fake workload、重复 Quit、关闭后 mutation 拒绝、
真实 SSE 结束及所有已登记资源归零。单元/集成门禁覆盖启动竞争、repair/recovery drain 与多错误传播。

Phase 2B 在创建 fixture/Host/数据库前取得 Electron single-instance lock；第二实例只通知主实例显示窗口。
打开、second-instance 与 activate 共用 show/restore/focus；被销毁的窗口重建时复用原 Host/Runtime。
Renderer 的 `render-process-gone` 只恢复 UI，最多在 60 秒内自动尝试 3 次；
恢复地址来自已提交且通过现有 exact owned-origin registry 的主页面导航，失效回 Launchpad。
Power 由通用代码的进程内 operation activity observer 驱动，多 Session lease 共用一个
`prevent-app-suspension` blocker；真实工作全部 settle 后释放，屏幕仍允许熄灭。
持久化 `RUNNING`、未来 scheduled、人工等待、窗口/SSE/Tray 本身均不是 Prevent Sleep 的依据。

Phase 3 的 Electron Main provider 通过现有 `WorkSessionNotifier` 注入 Production，
只接收真正的 `ALL_TASKS_COMPLETED`、结构化 `FAILED`、`SUSPENDED + humanRequired`；
USER_PAUSED、普通 idle、future schedule 不触发人工介入通知。通知不来源于 activity、UI 或 SSE。
Desktop COMPLETED 独立于 `email.notifyOnCompleted`，不会偷偷打开完成邮件；
`Notification.isSupported()` 为 false 时不注册 DESKTOP，也不回落旧 Windows adapter。
每次投递以原生 `show` 事件确认；`failed` 或 5 秒未确认进入既有最多一次渠道独立重试，
EMAIL 已成功时不会重发。通知失败不改变业务结果，历史通知不会因打开 UI 被补发。
Main 强引用最多 64 个通知、最长保留 15 分钟，退出 drain 后清理对象、listener 和 timer。

通知文案只包含固定标题和说明；click 仅携带 session identity，Main 查询仍存活的
Control mapping 并经原 exact origin registry 验证后 show/restore/focus；映射失效回 Launchpad。
不会从通知读取 URL、路径或命令，也不会创建第二个 Host/Runtime。
Windows centralized activation 已按固定 Electron API 注册，但其原始 arguments 没有文档化的
Session identity 格式，因此不猜解析；超出对象保留期、持久 Action Center 和 cold-start 点击
必须在 Phase 4 installer 中认证。集中身份配置在 `desktop/main/identity.mjs`；
正式 AppUserModelID / ToastActivatorCLSID 尚未指定，不修改用户快捷方式或注册表。

Electron 精确固定在 devDependencies；若首次安装尚未下载平台二进制，先执行
`npx --no install-electron`。smoke 在缺少二进制时返回机器可读失败，不在门禁中隐式下载。
每个 smoke Electron 进程限时 60 秒，超时只清理本次创建的进程树。stdout/stderr 和 JSON 结果
位于 `artifacts/desktop/bootstrap-smoke/`；`launchpad-result.json` 含完整
`DESKTOP_LAUNCHPAD_SMOKE` 门禁（含外部 runner 确认的 exit/cleanup），`result.json`
汇总 UI、后台行为与兼容性结果；`strict-shutdown-result.json` 保存 `DESKTOP_STRICT_SHUTDOWN`，
`background-runtime-result.json` 保存 `DESKTOP_BACKGROUND_RUNTIME`（含真正第二 Electron、renderer crash 和退出清理）。
`native-notification-result.json` 保存 `DESKTOP_NATIVE_NOTIFICATION`；系统 Toast 视觉验收
使用独立的 `WINDOWS_NATIVE_TOAST_VISUAL` 字段，原生事件和模拟点击路由不代表真人视觉/点击通过。
关闭失败和退出后的临时目录清理失败分别记录。runner 的 60 秒只用于判定 smoke 失败，
并非 Desktop 产品的退出超时；strict close 不通过 timeout 假报 drain 成功。
Desktop JS 类型/unused、包边界、平台边界及资源检测回归均已纳入 `npm run check`。
Windows Git discovery 会验证官方安装信息、PATH 中的 Git installation 及标准目录；
支持显式 `NOVAWING_GIT_BASH_PATH`，不要求 Start Menu 用户预先设置它，不使用 WSL Bash。

Desktop 显式使用 `createNovaWingLaunchpad({ shutdownMode: 'strict' })`；
现有 CLI/default close 保留 bounded 兼容语义。strict 的新接纳在 close 调用时停止，
已接纳 workflow 按现有 Runtime 语义完成，不新增取消 Task 或强制退出。
Windows unpacked app 已有独立 smoke，安装版真实 Codex / 真人 Toast / 卸载等仍须
real-host 验收。系统 shutdown/logoff、force kill 和 macOS 签名通知不在当前自动证明范围。

### Windows packaging（Phase 4）

```text
npm run desktop:package:dir
npm run desktop:package:smoke
npm run desktop:build:win
```

固定 Electron 44.4.3 / electron-builder 26.15.3，NSIS x64，`asar=false`。
独立 `artifacts/desktop/staging/package.json` 表达产品 0.4.0；根 kernel 仍为 0.1.0。
staging 保留 self-reference/exports，仅复制 Desktop Main/assets、dist 与 lockfile production
依赖；排除 fixture/tests/docs/secrets/user DB/dev artifacts。不运行根依赖 rebuild。

package smoke 将 win-unpacked 复制到源码之外的临时目录，在验证副本加入离线 harness，
由外部 Node 启动其中的 NovaWing executable；不会让源码 node_modules 成为祖先搜索路径。
交付的 unpacked/installer 不含 harness。另测真正 Production Main（无 fixture）的启动/退出。
NSIS 生成前必须有匹配当前包内容 SHA256 的 package smoke PASS。

安装包为 `artifacts/desktop/NovaWing Setup 0.4.0.exe`；所有产物与本机证据保持 Git ignored。
正式包直接加载现有 Production Launchpad；业务数据继续使用 Platform Adapter，默认 Windows
`LOCALAPPDATA/NovaWing`，保留显式绝对路径 overrides。Desktop 诊断在 data root 的
`desktop/events.jsonl`，只记录身份、路径、生命周期和通知路由，不记录 prompt/token。

完整状态见 [Phase 4 Report](docs/audit/NovaWing-v0.4.0-Phase-4-Report.md)，
操作见 [安装版人工验收](docs/audit/NovaWing-v0.4.0-Phase-4-Manual-Acceptance.md)。

## 当前切片假设

- 为满足当前独立开发边界，本阶段使用独立临时 SQLite；未来同库运行时仍只注入 SQLite 连接/路径，不改变 Core API，也不得查询宿主表。
- `sourceType` 使用通用的 `host | manual`，真实宿主名放在弱 `sourceSystem` 字段，避免把 NovaWing 核心绑定到某个应用。
- 在冻结设计的 `pending → approved|rejected` 外增加了显式 `draft → pending`，用于安全编辑尚未提交的手动提案；宿主通过 `createPendingProposal` 直接创建 pending。详细决策见 `docs/adr/0001-draft-proposal-state.md`。
- `node:sqlite` 在 Node 24 仍会输出实验性 API 警告；SQLite 文件格式和 SQL 约束本身是标准 SQLite，未来可在不改变 Core 的前提下替换适配器。

## 未来真实宿主的最小适配面

真实宿主只需要持有 `NovaWingFacade`，并实现与假宿主等价的两个方向：

```ts
interface NovaWingHostAdapter {
  submitMainlineProposal(input: HostProposalInput): MemoryProposal
  readLatestMainline(scopes: readonly MainlineScope[]): MainlineContext
}
```

审批仍由用户通过 `NovaWingFacade.editPendingProposal`、`approveProposal` 或 `rejectProposal` 完成。宿主不得获得主线 Repository、SQLite 句柄或直接 `nw_*` SQL。

## 明确未实现

真实 OfferFlow 同进程/同库接入、OfferFlow UI、真实 Prompt 注入、Host Snapshot V3 的具体宿主数据复制/文件替换实现、跨设备同步、RBAC、独立客户端和复杂版本快照均未实现。
