# NovaWing v0.1 独立内核切片

## 可安装包与 Host Snapshot V3

当前包名/版本为 `nova-wing@0.1.0`，要求 Node.js 24 或更高版本。仓库继续保留
`"private": true` 和 `UNLICENSED`，用于阻止未经授权的真实发布；本地构建和 tarball
验收不受影响。

安装者只能从以下四个公共入口导入，类型声明和运行时代码都来自 `dist/`：

```text
nova-wing/core
nova-wing/sqlite
nova-wing/testing
nova-wing/host-snapshot
```

`package.json#exports` 拒绝源码、migration、registry 等深层路径。可分发包只包含构建后的
`.js`、`.d.ts`、本 README 和 package metadata，不包含源码、测试、脚本、设计文档、
source map 或临时 SQLite 文件。

```bash
npm run build
npm run check
npm run pack:check
npm run consumer:selftest
npm audit
```

`pack:check` 连续构建两次，比较 `dist/packages` 文件清单及逐文件 SHA-256，并审计
`npm pack --dry-run --json` 的白名单。`consumer:selftest` 真实生成 tarball，在系统临时目录
创建全新项目，以 `--ignore-scripts` 安装，然后验证四个公共入口、migration、提案创建与
批准、Context 读取以及深层导入拒绝。两个命令都不发布包。

`novawing.snapshot.v3` 是 SQLite adapter 已有的 NovaWing 子系统 manifest；
`host.snapshot.v3` 是本切片新增的宿主组合 manifest。`nova-wing/host-snapshot` 只提供类型、
manifest 构造与验证、显式 registry、NovaWing 组件 adapter 和生命周期协议，不提供任何具体
宿主的导出、恢复或文件替换实现。

组件必须显式注册。同一权威表只能属于一个组件；宿主组件不能声明 `nw_*`，NovaWing
组件必须且只能声明冻结的三张权威表。表与组件顺序不影响摘要；未知组件、格式、版本、
缺失组件、摘要篡改或任一组件恢复后校验失败都会拒绝整个组合快照。

生命周期顺序为：停止新请求、排空活动操作、关闭全部写连接、打开专用连接、导出或恢复到
隔离候选库、校验组件 manifest、校验组合 manifest、执行全部恢复后校验、原子替换或宣布
成功、重新打开运行时连接。运行中的生产文件禁止原地部分恢复，任一组件失败都不得产生
半成功状态。

依赖来源和发布策略见
[`docs/adr/0002-distribution-source-and-host-snapshot-v3.md`](docs/adr/0002-distribution-source-and-host-snapshot-v3.md)。

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
- `packages/sqlite`：仅使用 `nw_` 表的 migration、追加式持久化和事务实现。
- `packages/testing`：只依赖 Facade 的 `FakeOfferFlowHost` 合约适配器。
- `tests`：领域、SQLite、并发/重复请求、重启和假宿主闭环测试。
- `scripts`：migration 确定性与仓库/领域边界检查。

## 公共包出口

调用方只能使用以下 package subpath：

```text
nova-wing/core
nova-wing/sqlite
nova-wing/testing
```

`package.json#exports` 会拒绝 `packages/*/src`、domain、migration 等深层路径。`npm run check:exports` 同时校验公开运行时键和深层导入拒绝行为。

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
npm run lint
npm run check:migration
npm run check:exports
npm run check:unused
npm run check:boundaries
```

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

真实 OfferFlow 同进程/同库接入、OfferFlow UI、真实 Prompt 注入、Snapshot V3、跨设备同步、RBAC、后台任务、独立客户端和复杂版本快照均未实现。
