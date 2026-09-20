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

旧版本错误写入 POSIX `~/AppData` 或 `~/.novawing/NovaWing` 的数据不会自动合并或删除。
需要保留旧 session 时，先关闭旧 runtime，备份后迁移对应配置/数据，或显式配置旧路径；
SQLite session URL 已写入可信 config 的继续沿用原位置。
平台实现仅允许出现在明确 allowlist 的 adapter；`npm run check:platform`（已接入 `check`）
阻止 common runtime 再引入 OS 路径、工具、环境变量和 locale 硬编码。


## Desktop Bootstrap（v0.4.0 Phase 1B）

```powershell
npm run desktop:dev
npm run desktop:smoke
```

`desktop:dev` 先 build，再以全新临时 config/data/repo/home/profile 启动 Electron Main。
Main 内的薄 Desktop Host 调用现有 Launchpad，BrowserWindow 加载它的真实 HTTP UI；
关闭最后一个窗口会调用 Host → Launchpad close，再退出并删除临时目录。
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

Electron 精确固定在 devDependencies；若首次安装尚未下载平台二进制，先执行
`npx --no install-electron`。smoke 在缺少二进制时返回机器可读失败，不在门禁中隐式下载。
每个 smoke Electron 进程限时 60 秒，超时只清理本次创建的进程树。stdout/stderr 和 JSON 结果
位于 `artifacts/desktop/bootstrap-smoke/`；`launchpad-result.json` 含完整
`DESKTOP_LAUNCHPAD_SMOKE` 门禁（含外部 runner 确认的 exit/cleanup），`result.json`
汇总 UI 与兼容性两轮结果。关闭失败和退出后的临时目录清理失败分别记录。
Desktop JS 类型/unused、包边界、平台边界及资源检测回归均已纳入 `npm run check`。
Windows 的完整测试仍需配置有效的 `NOVAWING_GIT_BASH_PATH`（见上文）。

本阶段只验证已完成的隔离 fake workload 正常关闭，尚未交付生产级 strict shutdown。
下一步先做 Phase 2A：Host/Launchpad/Runtime drain、错误传播和 start/close race；
之后才进入 Phase 2B 的后台模式与 Tray。根 npm exports/files 保持原边界，
Desktop 后续使用独立 packaging staging。本轮完整证据见
[`Phase 1B Report`](docs/audit/NovaWing-v0.4.0-Phase-1B-Report.md)。

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
