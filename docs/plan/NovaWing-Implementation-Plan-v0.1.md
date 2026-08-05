# 星翼 NovaWing v0.1 实施计划

**副标题：基于已冻结 PRD 与 System Design 的落地拆分（不含代码）**

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.1 |
| 依据文档 | 星翼 NovaWing PRD v0.1（已冻结）、System Design v0.1 |
| 目标产品版本 | NovaWing v0.1 |
| 首发宿主 | OfferFlow（参考代码：`D:\VSCode\offer-pilot`） |
| 文档状态 | 待实现前评审 |
| 创建日期 | 2026-07-25 |
| 产品负责人 | 魏建军 |

> 本计划只做工程拆分与顺序编排，不改变冻结 PRD 的产品结论、P0 范围或非目标；不引入独立服务、多端平台、RBAC 或全量版本系统。

## 0. 阅读约定

- **路径基准**：除非显式标注「（nova-wing 仓库）」，下文所有实现路径均以 **OfferFlow 仓库根**（`D:\VSCode\offer-pilot`）为基准。本 `nova-wing` 仓库仅承载 `docs/`（PRD / System Design / 本计划）与未来可能抽离的独立包。
- **代码归属**：v0.1 NovaWing 以**内部强边界模块**形式直接落在 OfferFlow 仓库内（同进程、同库），逻辑独立、物理不独立（PRD §5.1、Design §3）。这细化了 Design §4.2 的「全部置于 `src/modules/nova-wing`」——因 OfferFlow 后端 `server/` 独占 SQLite 句柄，核心与持久化落在 `server/`，仅 Vue UI 落在 `src/`。
- **确认标记**：`【已审计】` 为实现前只读审计已确认的路径 / 事实；`【待确认】` 为据审计推断、动工前须在 OfferFlow 复核的路径。
- **不写代码**：本文件不含实现代码，只列目标、文件、依赖、测试、完成标准与回滚。

## 1. NovaWing 在 OfferFlow 中的实际目录结构

```text
offer-pilot/                                # OfferFlow 仓库根（= 路径基准）
├─ server/
│  └─ nova-wing/                            # NovaWing 服务端（核心+持久化+接入）
│     ├─ core/                              # 领域内核，禁止 import 任何 OfferFlow 代码
│     │  ├─ domain/                         # 领域类型、MemoryKey 校验、投影规则
│     │  ├─ application/                    # 用例：createProposal / approve / reject
│     │  ├─ ports/                          # Repository / TxManager 接口
│     │  ├─ errors.ts                       # NovaWingErrorCode 稳定错误码
│     │  └─ facade.ts                       # NovaWingFacade 实现（组合 application）
│     ├─ sqlite/                            # SQLite 适配器（better-sqlite3）
│     │  ├─ migrations/                     # nw_ 表迁移（并入 OfferFlow 迁移数组 v9+）
│     │  ├─ repositories/                   # ports 的 better-sqlite3 实现
│     │  ├─ registry.ts                     # ★ NovaWing 权威表注册表（唯一纳表来源）
│     │  ├─ snapshot.ts                     # Snapshot V3 导入校验（供 server/sync 调用）
│     │  └─ store.ts                        # 组装 facade+repos，接收注入的 db 句柄
│     ├─ integration/                       # OfferFlow 接入（服务端）
│     │  ├─ adapter.ts                      # OfferFlowNovaWingAdapter（求职→通用输入）
│     │  ├─ context-assembler.ts            # 有效主线 → 结构化主线块 + 4 字段元数据
│     │  └─ routes.ts                       # /api/nova-wing/* HTTP 封装（供 UI 调用）
│     └─ index.ts                           # 模块 barrel，对外唯一出口
└─ src/
   ├─ modules/
   │  └─ nova-wing/                         # NovaWing UI（客户端，OfferFlow 正式模块）
   │     ├─ PersonalMainlinePage.vue        # “个人主线”页（当前主线 / 待审核提案两页签）
   │     ├─ components/                     # 当前主线、待审核提案子组件
   │     └─ novaWingApi.ts                  # apiGet/apiSend 封装（仿 strategyWindowApi.ts）
   ├─ app/prompt.ts                         #【已审计】纯函数，新增可选主线块入参（不 import NovaWing）
   ├─ router/index.ts                       #【已审计】新增 1 条路由记录
   └─ App.vue                               #【已审计】新增 1 个侧边栏入口（约 3 处编辑）
```

> **既有分析链路（【已审计】，阶段 5 据此接入）**：
> `server/routes/llm.ts`（`registerLlmRoutes`，持 `app.db`，唯一有 DB 与请求上下文的层）
> → `server/llm/analyzeJob.ts`（`buildAnalyzeJobPrompt(input)` / `analyzeJob(input)`）
> → `src/app/prompt.ts`（`buildAnalysisPrompt(profile, job, company)`，**纯函数、客户端可 import、无 DB / 无 async**）。
> ∴ NovaWing Context 的**异步读取只能发生在 `server/routes/llm.ts`**（那里有 `app.db` → NovaWing store）；主线块以**纯字符串**逐层下传至 `buildAnalysisPrompt`，`prompt.ts` 与 `analyzeJob.ts` 均不得 import NovaWing 模块，以守住 `core/**` ↔ OfferFlow 的边界与 isomorphic 纯度。

**边界规则（以 ESLint `no-restricted-imports` 固化，Design §4.3）**：
`server/nova-wing/core/**` 禁止 import OfferFlow 岗位/简历/城市实体、AI Payload、页面组件；`server/nova-wing/sqlite/**` 禁止 import OfferFlow 业务实体；OfferFlow 业务代码禁止直接写 `nw_*` SQL，只能经 `server/nova-wing/index.ts` 出口。

## 2. 实现前须复核的 OfferFlow 接入点（动工前置）

Design §22 阶段 0 只读审计已完成，以下为动工前须最终定位的残留项（不阻塞规划，阻塞编码）：

| 编号 | 事项 | 现状 |
|---|---|---|
| A1 | SQLite 迁移有序数组位置与当前最大版本号（NovaWing 从下一版起接续） | 【待确认】审计示例为 v9+ |
| A2 | OfferFlow 装配 repositories 并注入 `Database.Database` 句柄的位置 | 【待确认】NovaWing store 复用同一句柄 |
| A3 | 快照：`SYNC_TABLES`（7 表）在 `server/sync/types.ts`；导出 `server/sync/exportSnapshot.ts`、导入 `server/sync/importSnapshot.ts`、一致性 `server/sync/consistency.ts`、表读写 `server/sync/tables.ts`；V2 回归基线 `server/sync/productionV2.spec.ts` | 【已审计】`SNAPSHOT_SCHEMA_VERSION=2`；`exportSnapshot.ts:23` `openProductionDb` 对 DB 迁移版本做 `!==2` 相等校验 |
| A4 | 分析链路：`server/routes/llm.ts`（持 `app.db`）→ `server/llm/analyzeJob.ts`（`buildAnalyzeJobPrompt`/`analyzeJob`）→ `src/app/prompt.ts`（`buildAnalysisPrompt`，纯函数、客户端可 import、无 DB）；结果写 `jobs.data_json` 落点 | 【已审计】详见 §附录·分析链路 |
| A5 | 服务端路由挂载入口（`registerLlmRoutes(app)` 风格，Fastify `app.post`；`/api/nova-wing/*` 仿此注册） | 【已审计】`server/routes/llm.ts` 用 `registerLlmRoutes(app: FastifyInstance)` |
| A6 | 生产库升级策略：拒绝自动迁移，须走授权 backup-first 升级 | 【已审计】影响各阶段回滚 |

## 3. 贯穿性约束（所有阶段适用）

- **并发与两类错误的严格区分（影响阶段 2）**：OfferFlow `journal=DELETE`（非 WAL）、无 `busy_timeout` → 并发写事务立即 `SQLITE_BUSY`。批准事务用 `BEGIN IMMEDIATE`。**两类失败必须分开、不得混用**：
  - **`SQLITE_BUSY`（锁竞争，瞬时可恢复）→ 映射为 `STORE_BUSY`**：TxManager 内小幅退避重试 N 次；重试仍失败才向上抛 `STORE_BUSY`，语义为「可重试」，调用方（含 UI）可安全重试整笔操作。
  - **修订号 CAS 失败（`compareAndSetCoreRevision` expected≠实际，即另一笔已推进主线）→ `CORE_REVISION_CONFLICT`**：语义为「基准已过期」，**不可**盲目重试，须回到当前主线重新决策。
  - 二者均不向 OfferFlow 泄露原始 SQL 错误（Design §9、§12）；`STORE_BUSY` 为对 Design §12 错误枚举的实现级新增（可重试类），`CORE_REVISION_CONFLICT` 保持原义。
- **唯一性策略**：OfferFlow 无 `SQLITE_CONSTRAINT` 捕获惯例 → 业务层事务内预检 + DB 唯一约束兜底，不靠异常捕获做业务分支。
- **迁移政策（影响阶段 1/3 回滚）**：NovaWing 迁移只**新增** `nw_` 表，对 OfferFlow 既有表零改动；真实生产库须走 A6 备份优先升级路径。
- **领域所有权红线（P0，PRD §16.4 / Design §24）**：`career.job_selection_priority`、`global.current_phase` 等只存**跨场景提炼结论**，不得镜像 OfferFlow 的 `StrategyWindowType` / `DecisionGate` / `jobSearchFocus` 等确定性字段；Core 单向被读取、从不回写。
- **总闸**：`NOVAWING_INJECT_ENABLED`（阶段 5 注入）、`NOVAWING_UI_ENABLED`（阶段 6 入口）两个开关在验收通过前保持关闭，是各阶段的主回滚手段。

## 4. 阶段依赖总览

```text
阶段1 数据库迁移+仓储
      │
      ├──────────────┐
      ▼              ▼
阶段2 提案/审批事务   （阶段1 的注册表供阶段3）
      │              │
      ├───────┬──────┴───────┐
      ▼       ▼              ▼
阶段4 Assembler 阶段3 SnapshotV3   阶段6 审批UI（仅依赖阶段2）
      │
      ▼
阶段5 岗位分析接入（发布前必须先完成阶段3，保证主线数据可持久化）
      │
      ▼
阶段7 测试与验收（汇总全部）
```

阶段 3、4、6 可与相邻阶段并行；阶段 5 上线前阶段 3 必须完成（否则已批准主线不进快照，违反 Design §17.6）。

## 阶段 1 · 数据库迁移与领域仓储

**目标**：建立 `nw_meta` / `nw_proposals` / `nw_mainline_entries` 三表、领域类型与投影、Repository Port 及 better-sqlite3 实现；初始化 `current_core_revision=0`；建立**权威表注册表**。本阶段只做 CRUD/追加原语，不含批准事务编排。

**具体修改文件**（新增，除非标注）：
- `server/nova-wing/core/domain/`：MainlineEntry / MemoryProposal / CoreRevision 类型、MemoryKey 正则校验（Design §5.1）、当前有效主线投影（Design §7）。
- `server/nova-wing/core/ports/`：`MainlineRepository`、`ProposalRepository`、`MetadataRepository` 接口。
- `server/nova-wing/core/errors.ts`：Design §12 全部错误码 + 实现级新增可重试类 `STORE_BUSY`（区别于不可重试的 `CORE_REVISION_CONFLICT`，见 §3）。
- `server/nova-wing/sqlite/migrations/`：三表 DDL + 索引 + append-only 触发器（Design §6），`INSERT OR IGNORE` 初始化修订号。
- `server/nova-wing/sqlite/repositories/`：`append`、`findLatestByMemoryKey`、当前投影查询、提案读写、修订号读/CAS。
- `server/nova-wing/sqlite/registry.ts`：登记 3 张权威表并声明 `includeInSnapshot=true`（Design §17.6-1）。
- `server/nova-wing/sqlite/store.ts` + `index.ts`：组装并导出。
- 【修改】A1 迁移数组：接续追加 NovaWing 迁移条目；【修改】A2 装配处：实例化 NovaWing store（注入既有 db 句柄）。

**依赖**：无（首阶段）。前置须解决 A1、A2。

**测试**（Design §18.2）：迁移可重复执行幂等；外键 ON 生效；主线表 UPDATE/DELETE 被触发器拒绝；`source_proposal_id`、`core_revision` 唯一；action/status/statement CHECK 约束生效；MemoryKey 正则与长度校验；当前投影正确（最新 set 有效、deprecate 后不返回、重设已废弃 Key 恢复）。夹具用 temp-file DB（非 `:memory:`），`vitest run`。

**完成标准**：全新库迁移成功建 3 表+索引+触发器，修订号=0；注册表恰好登记 3 表且全部标记纳入快照；§18.2 仓储单测通过；`core/**` 对 OfferFlow 与 SQLite 均零耦合（ESLint 边界通过）。

**回滚方式**：迁移仅新增 `nw_` 表、零改 OfferFlow 表。未发布 → 从迁移数组移除 NovaWing 条目并撤销代码；已在开发库执行 → `nw_` 表处于孤立无用状态，可保留（下阶段续用）或手动 `DROP TABLE nw_*`；生产库回退须走 A6 备份恢复（SQLite `user_version` 单调递增，不能就地降版）。

## 阶段 2 · 提案 / 审批事务

**目标**：实现 createProposal / approveProposal / rejectProposal 用例；批准走 `BEGIN IMMEDIATE` 原子事务，含陈旧提案检测与修订号 CAS，一次批准恰好 +1 修订号、恰好一条主线记录（Design §8–§11、§24）。

**具体修改文件**：
- `server/nova-wing/core/application/`：`create-proposal.ts`（校验+写 pending，不改主线）、`approve-proposal.ts`（读提案→确认 pending→读修订号与目标最新记录→`validateProposalAgainstCurrentState`→插入主线→条件更新 approved→CAS 修订号）、`reject-proposal.ts`（条件 UPDATE，影响行数须=1）。
- 【修改】`server/nova-wing/core/facade.ts`：暴露 §12 全部方法。
- `server/nova-wing/core/ports/`：新增 `TxManager` 接口（`immediate(fn)`）。
- 【修改】`server/nova-wing/sqlite/store.ts`：以 `db.transaction(fn).immediate()` 实现 `TxManager`；**`SQLITE_BUSY` → 退避重试 N 次，耗尽才抛可重试的 `STORE_BUSY`**；修订号 CAS 失败单独抛不可重试的 `CORE_REVISION_CONFLICT`（见 §3，二者不得混用）。

**依赖**：阶段 1（表、投影、仓储、注册表）。

**测试**（Design §18.1、§18.3）：仅 pending 可审核；approved/rejected 不可再批准；同一提案连续批准两次、并发批准两次均只成功一次；两个不同提案并发批准得到不同修订号；陈旧目标（`baseTargetEntryId` 不符）被 `STALE_PROPOSAL` 阻止；中途失败完整回滚、不留半完成、不增修订号；`finalStatement` 选择规则；deprecate 目标不存在/已废弃的拦截；**`SQLITE_BUSY` 经重试后成功 / 耗尽后抛 `STORE_BUSY`（可重试语义）**；**修订号 CAS 失败抛 `CORE_REVISION_CONFLICT` 且不被当作 BUSY 重试**（两类错误路径互不串味）。

**完成标准**：§18.1+§18.3 全通过；Facade 完整实现 §12 接口且只返回稳定错误码；「一次批准 → 恰好一条 entry 且修订号 +1」「失败事务无任何状态迁移」不变量成立。

**回滚方式**：纯应用逻辑，无 schema 变更 → 撤销代码即还原，阶段 1 表保持不变。在阶段 5/6 开关启用前不产生真实提案数据；若测试外意外写入坏数据，凭 append-only 约束不会破坏历史，必要时走 A6 备份恢复。

## 阶段 3 · Snapshot V3

**目标**：把注册表声明纳入的 `nw_` 权威数据接入 OfferFlow 快照 / 恢复边界。两条正交决策：①以**显式注册表**纳表（非 `nw_` 前缀自动纳表）；②**按 `snapshotVersion` 分流**——V2 走 V2 独立路径、V3 走 V3 独立路径、**未知版本明确拒绝**。V3 路径做修订号与完整性校验（Design §17.6、§18.2.1、PRD §13.4）。

> **术语澄清（关键）**：`snapshotVersion`（快照格式契约版本，`server/sync/types.ts` 现为 `SNAPSHOT_SCHEMA_VERSION=2`）与 `databaseSchemaVersion`（DB 迁移计数，`getDatabaseSchemaVersion`，NovaWing 迁移后升至 v9+）是**两个独立维度**。本计划**不采用「放宽 schemaVersion 门限」思路**；改为让快照读写以 `snapshotVersion` 为唯一分流键，每个版本各自声明其兼容的 DB 契约，从而与 DB 迁移计数解耦。

**具体修改文件**：
- 【修改】`server/sync/types.ts`：新增 `SNAPSHOT_SCHEMA_VERSION_V3=3` 与 V3 快照 / manifest 类型（在 V2 结构上追加可选 `novaWing` 段：注册表纳入表的行数据 + `currentCoreRevision`）；`nw_` 表清单从 `server/nova-wing/sqlite/registry.ts` **读取**（不在 `types.ts` 硬编码 `nw_` 名）。V2 类型与 `SYNC_TABLES`（7 表）保持不变。
- 【修改】`server/sync/exportSnapshot.ts`：导出**一律写 V3**（`snapshotVersion:3`），按注册表附加 `novaWing` 段。`openProductionDb`（:23）当前的 `databaseSchemaVersion !== 2` 相等校验，改为**按导出目标格式 V3 校验其所需 DB 契约**（接受 NovaWing 迁移后的 v9+），**不是**放宽为「≥2」——而是「V3 导出要求 DB 满足 V3 契约」的精确匹配，消除 v9+ 后导出抛错。
- 【修改】`server/sync/importSnapshot.ts`：入口先读 `snapshotVersion` **分流**：
  - **`=== 2`** → **V2 导入路径**（现有逻辑原样保留，无 `novaWing` 段；NovaWing 视为未初始化、不触发第 4 步校验）；
  - **`=== 3`** → **V3 导入路径**（按注册表写入 `nw_` 表 + `current_core_revision`，随后强制完整性校验）；
  - **其他（缺失 / <2 / >3 / 非法）** → **明确拒绝并报错**，不降级、不「尽力导入」、不产生半完成。
- `server/nova-wing/sqlite/snapshot.ts`：暴露 `verifyImportedConsistency(store)` 供 V3 导入路径调用（`current_core_revision == MAX(core_revision)`、每条 `source_proposal_id` 命中且对应提案 approved、修订号无重复无跳号）。**只被 `importSnapshot.ts` 调用，自身不 import `server/sync`**（避免环，见文末结论）。
- 【修改】`server/sync/productionV2.spec.ts`：作为 V2 路径回归基线保持绿；新增 V3 用例另置。

**依赖**：阶段 1（注册表、表结构）、阶段 2（approved 提案供校验）。

**测试**（Design §18.2.1）：导出为 V3 且含注册表声明纳入的全部 `nw_` 表；注册表驱动——新登记「纳入」表被覆盖、「不纳入」表被排除、**未登记** `nw_*` 表按错误处理；V3 往返一致（主线/提案/修订号）；**分流正确**——V2 快照走 V2 路径（NovaWing 未初始化、不校验）、V3 走 V3 路径（强制校验）；**未知版本（缺失 / <2 / >3 / 非法）一律拒绝**；修订号失步拒绝导入；不存在「只同步修订号丢 `nw_` 数据」路径；NovaWing 迁移到 v9+ 后关闭 / 导出不再抛错；OfferFlow 既有 7 表 V2 同步回归（`productionV2.spec.ts`）不破坏。

**完成标准**：注册表为唯一纳表来源；导入严格按 `snapshotVersion` 分流、V2/V3 各自独立处理、未知版本拒绝；`snapshotVersion` 与 `databaseSchemaVersion` 解耦，无「放宽门限」式判断；OfferFlow V2 快照回归全绿。

**回滚方式**：撤销 `server/sync/*` 改动即恢复旧 V2 导出/导入，`nw_` 数据仍留在本地库与 `VACUUM INTO` 全文件备份中不丢。**排序约束**：先上线「能分流读 V2 与 V3」的导入端，再切换导出端写 V3；一旦已产生 V3 快照，导入端的 V3 分支不可回退（回退将使 V3 快照落入「未知版本拒绝」而无法读入）。导出端回退到只写 V2 安全（本地数据不丢，只是新快照缺 `novaWing` 段）。

## 阶段 4 · Core Context Assembler

**目标**：服务端上下文装配。经 `facade.getContext(['global','career'])` 读当前有效主线，产出一个可注入的**纯字符串主线块**与 4 字段元数据（`usedNovaWingCoreRevision` / `usedNovaWingMemoryKeys` / `novaWingContextDigest` / `novaWingContextUsedAt`）；实现 OfferFlow Adapter。本阶段**不改 `llm.ts` / `analyzeJob.ts` / `prompt.ts`**，仅产出装配件供阶段 5 调用（Design §13、§14）。

> **数据流定位（据 A4 审计链路）**：装配器输出 `{ block: string, meta: {...4 字段} }`。`block` 是无副作用字符串，阶段 5 在 `server/routes/llm.ts` 内取得后，经 `analyzeJob.ts` 透传给 `prompt.ts` 新增的可选入参。装配器只依赖 `facade`，**不依赖** OfferFlow 岗位/Prompt 类型，保持 `integration` 层对既有分析链路的零侵入。

**具体修改文件**：
- `server/nova-wing/integration/context-assembler.ts`：有效主线 → 主线块字符串 + digest + 4 字段；只读、不回写 Core；排除历史/已废弃/pending/证据全文/审核备注/OfferFlow 主键。
- `server/nova-wing/integration/adapter.ts`：`proposeCareerMainline`（求职证据→通用 `CreateProposalInput`，只传最小摘要与弱 `sourceRef`）、`getCareerContext`。
- digest 稳定化：memoryKey+coreRevision 归一化后哈希（同集合同修订号 → 同 digest）。
- 【修改】`server/nova-wing/index.ts`：导出 integration 接口。

**依赖**：阶段 2（Facade 已具备 getContext 投影）。与阶段 3 相互独立。

**测试**：getContext 只返回有效、范围匹配的主线且带正确 coreRevision；主线块格式符合 Design §14 且不含被排除项；digest 确定性（相同集合两次装配 digest 一致，主线变化 digest 变化）；空主线优雅处理（无有效主线时块为空、digest 稳定）；断言装配全程不触发对 Core 的写；Adapter 只透传摘要与弱引用，不泄露完整岗位/简历对象。

**完成标准**：主线块与 4 字段可由有效主线纯函数产出；「读取不改变 Core」不变量成立（§24 单向依赖）；Adapter 输出不含 OfferFlow 专属实体字段。

**回滚方式**：纯新增模块，阶段 5 前无任何实际调用方 → 删除 `integration/context-assembler.ts`、`adapter.ts` 即可，对 OfferFlow 运行零影响。

## 阶段 5 · OfferFlow 岗位分析接入

**目标**：把主线块作为**新增段落**注入现有岗位分析链路，分析后将 4 字段随岗位记录持久化；由 `NOVAWING_INJECT_ENABLED` 开关控制。v0.1 唯一 AI 注入入口，不新增通道 / Provider（Design §14、PRD §17.5、§21.3）。

**具体修改文件**（据 A4 真实链路，自下而上改三层）：
- 【修改】`src/app/prompt.ts`（`buildAnalysisPrompt(profile, job, company)`，【已审计】纯函数、:79–168）：**新增可选入参 `novaWingBlock?: string`**，非空时作为一个独立段落插入返回数组（如置于「公司与机会补充」后）；**保持纯函数、不 import 任何 NovaWing / server 代码**、`novaWingBlock` 缺省时输出与今完全一致。
- 【修改】`server/llm/analyzeJob.ts`（`AnalyzeJobInput` / `buildAnalyzeJobPrompt` / `analyzeJob`，【已审计】）：`AnalyzeJobInput` 增加可选 `novaWingBlock?: string` 与 `novaWingMeta?`；`buildAnalyzeJobPrompt` 把 `novaWingBlock` 透传给 `buildAnalysisPrompt` 第 4 参；**本文件仍不 import NovaWing 模块**，只透传字符串。
- 【修改】`server/routes/llm.ts`（`registerLlmRoutes`，持 `app.db`，【已审计】唯一有 DB 上下文的层，含 `/api/llm/analyze-job` 与 `-stream`）：**唯一新增 NovaWing 依赖处**——开关开启时经 NovaWing store 调 context-assembler 取 `{block, meta}`，注入 `resolved.input.novaWingBlock`；分析后把 `meta` 4 字段并入结果对象（非流式返回体 / 流式 `type:'done'` 事件），供落库。
- 【修改】A4 落点：4 字段写入 `jobs.data_json` 柔性 blob，**无需新增列 / 迁移**（写库路径以 A4 复核为准）。
- 【修改】A5 / bootstrap：确保 `registerLlmRoutes` 可取到 NovaWing store（同 `app.db` 句柄）；接 `NOVAWING_INJECT_ENABLED` 开关。

**依赖**：阶段 4（Assembler / Adapter）；真实验证需阶段 1、2（有数据）。发布前须先完成阶段 3（主线可持久化）。

**测试**（Design §18.4）：`prompt.ts` 缺省 `novaWingBlock` 时输出逐字节等同今（纯函数回归）；pending 提案不进 Context / Prompt；批准后 coreRevision 增、下一次分析读到新主线、Prompt 含新主线段落；4 字段随 `analyze-job` 与 `-stream` 两路径落库；`NOVAWING_INJECT_ENABLED=false` 时 `llm.ts` 完全不触达 NovaWing、链路等同原 analyze-job（回归）。

**完成标准**：至少一个真实 AI 分析入口注入 NovaWing Context；结果记录 4 字段；固定样本中批准前后出现可解释判断差异（现金流优先于转型纯度，Design §18.5）；未扩展浏览器 / 桌面 / 多 Agent / 其他 AI 入口。

**回滚方式**：置 `NOVAWING_INJECT_ENABLED=false` 即刻恢复原 analyze-job 行为，无需改码——此时 `llm.ts` 不注入 `novaWingBlock`，`prompt.ts` 的可选入参缺省、输出逐字节等同今；`jobs.data_json` 中已写的 4 字段对旧逻辑无害（缺失亦合法）。完全撤销则移除三层的可选入参与注入点。风险低。

## 阶段 6 · 审批 UI

**目标**：OfferFlow 内「个人主线」正式模块——当前主线 + 待审核提案两页签；新增路由与侧边栏入口；客户端 API 与服务端 HTTP 封装。仿 StrategyWindow 模式，`NOVAWING_UI_ENABLED` 控制入口（Design §15、PRD §11）。

**具体修改文件**：
- `src/modules/nova-wing/PersonalMainlinePage.vue` + `components/`：当前主线（coreRevision、有效主线、类别/范围/性质、内容与理由、来源、生效时间；禁止原地编辑/删除/切换启用）；待审核提案（建议动作、目标 Key、来源、理由证据、提交时与当前修订号、陈旧风险；批准/修改后批准/拒绝；批准前显示「Core Revision：12 → 13」；陈旧提案提示重建）。
- `src/modules/nova-wing/novaWingApi.ts`：仿 `strategyWindowApi.ts` 用 `apiGet`/`apiSend`，无 Pinia、组件内 ref。
- `server/nova-wing/integration/routes.ts`：`/api/nova-wing/*`（list 主线 / list 提案 / create / approve / reject）薄封装 Facade。
- 【修改】`src/router/index.ts`：新增 `/personal-mainline` 路由；【修改】`src/App.vue`：新增「个人主线」侧边栏入口（约 3 处）；【修改】A5：挂载 routes。

**依赖**：阶段 2（Facade）。可与阶段 4、5 并行。

**测试**：主线视图渲染 coreRevision 与有效主线；提案列表含陈旧标记；批准显示修订号预告；陈旧提案警示并阻止直接批准；批准/修改后批准/拒绝命中正确端点；UI 所有数据操作经 Facade（无直连 `nw_` SQL）。UI 走手动 E2E。

**完成标准**：「个人主线」页可经侧边栏进入、查看与审核、创建手动提案；陈旧提案被提示并阻止;全部数据操作经 NovaWing Facade;符合 naive-ui/OfferFlow 惯例。

**回滚方式**：置 `NOVAWING_UI_ENABLED=false` 隐藏入口；完全撤销则删路由记录、侧边栏入口、`src/modules/nova-wing/`、卸载 `/api/nova-wing/*`。数据读写在阶段 2 Facade，UI 撤销不影响数据。风险低、隔离。

## 阶段 7 · 测试与验收

**目标**：汇总全测试矩阵（单元 / 数据库 / 快照 / 并发 / 集成 / E2E），跑通 OfferFlow 既有回归，按 Design §18.5 固定样本验收，逐条核对 DoD 与不变量，确认断网闭环、无 P0，发布 NovaWing v0.1。

**具体修改文件**：
- `server/nova-wing/**/__tests__/`：聚合各阶段测试；补 §18.4 集成链路测试。
- E2E / 验收脚本：固定同类岗位样本 + 相同模型配置，批准前后各跑一次分析并对比。
- 【修改】若 OfferFlow 有本地 `selftest`/`vitest run` 入口：接入 NovaWing 套件。
- 【修改】ESLint 边界规则：固化 §1 的 `no-restricted-imports`，纳入 CI 前置检查（本地）。

**依赖**：阶段 1–6 全部。

**测试**：Design §18 全量（§18.1 域、§18.2 仓储、§18.2.1 快照、§18.3 并发、§18.4 集成、§18.5 E2E）；OfferFlow 既有 sync / strategy-window 等回归；断网下查看主线、创建/批准/拒绝提案、读取正式主线全通。

**完成标准（发布判定，三维全绿且两开关启用）**：
- **产品验收（PRD §21）**：输入控制 / 输出干预 / 可追溯性（4 字段）/ 替代废弃 / 数据完整性（注册表纳入数据与修订号同边界、版本分流、一致性校验）/ 本地运行全达标。
- **系统 DoD（Design §25）**：逐条勾选，含「显式注册表纳表、不按前缀自动纳表」「导入按版本分流、未知版本拒绝」「V2 兼容导入」等新增项。
- **不变量守卫（Design §24）**：pending∉context、approved→恰好一条 entry、一次提交→修订号+1、失败事务无副作用、Core 不回写 OfferFlow、注册表成员制纳表、按版本分流导入 —— 全部有测试覆盖。

**回滚方式**：本阶段只增测试与文档、无运行时改动，验收失败不发布即可（无需回滚代码）；阶段 5/6 两开关为集成总闸，在三维验收全绿前保持关闭。

## 5. 里程碑与并行建议

| 里程碑 | 含阶段 | 交付 |
|---|---|---|
| M1 持久化内核 | 1、2 | `nw_` 表+仓储+批准事务，域/仓储/并发测试绿 |
| M2 数据存活 | 3 | Snapshot V3 注册表纳表+版本分流+校验，快照测试绿 |
| M3 AI 闭环 | 4、5 | 岗位分析注入主线+4 字段，集成测试绿（开关内测） |
| M4 人工审核面 | 6 | 「个人主线」页可审可创建（开关内测） |
| M5 验收发布 | 7 | 全矩阵+固定样本+DoD 全绿，启用双开关，发布 v0.1 |

M2 与 M3 的阶段 3、4 可并行；M4 阶段 6 仅依赖阶段 2，可自 M1 完成后与 M2/M3 并行推进。阶段 5 上线前必须并入阶段 3。

## 6. 循环依赖复核结论（注册表接入 server/sync ↔ nova-wing/sqlite）

**问题**：阶段 3 让 `server/sync` 读取 `server/nova-wing/sqlite/registry.ts`，是否与 NovaWing 侧对 `server/sync` 的引用形成环？

**复核（基于已审计 import 关系）**：
- 现状：`server/sync/exportSnapshot.ts`、`importSnapshot.ts` 均 import `./types`；`types.ts` 目前不 import 任何 NovaWing 代码。NovaWing 侧尚未落地。
- 阶段 3 后的**期望依赖方向（单向）**：

```text
server/sync/{types,export,import}.ts
        │  import（读取纳表清单 / 调用一致性校验）
        ▼
server/nova-wing/sqlite/{registry.ts, snapshot.ts}
        │  import
        ▼
server/nova-wing/sqlite/{store, repositories}  →  core/ports、core/domain
```

**结论：不会构成循环依赖，前提是遵守两条硬规则**：
1. **`registry.ts` 保持纯声明、零 import `server/sync`**：只导出「表名 + 主键 + `includeInSnapshot` 标志」等自有类型；`server/sync/types.ts` 若需 `nw_` 表名，单向从 registry 读取。**严禁** `registry.ts` 反向 import `server/sync` 的 `SyncTableName` / `SnapshotTable` 等类型（否则 `types.ts → registry.ts → types.ts` 成环）。
2. **`snapshot.ts` 的一致性校验只依赖 NovaWing store，零 import `server/sync`**：V3 导入路径由 `importSnapshot.ts` **调用** `snapshot.ts` 的 `verifyImportedConsistency(store)`，方向为 `sync → nova-wing`；`snapshot.ts` 在 NovaWing 自有仓储上校验，不回引 `server/sync` 的类型或函数。跨层共享的行结构走 `sync` 侧类型或中性 DTO，由 `sync` 侧适配，不让 NovaWing 依赖 `sync`。

**落地保障**：把上述方向写进 §1 的 ESLint `no-restricted-imports`——`server/nova-wing/**` 全面禁止 import `server/sync/**`；`server/sync/**` 仅允许 import `server/nova-wing/sqlite/registry` 与 `server/nova-wing/sqlite/snapshot`（或经 `server/nova-wing/index.ts` 收窄的专用出口），不得深入其它 NovaWing 内部。阶段 3 与阶段 7 各跑一次依赖环检测（如 `madge --circular`）作为回归。

## 附录 · analyze-job 既有装配调用链（阶段 5 依据）

```text
POST /api/llm/analyze-job(-stream)             server/routes/llm.ts  ← 持 app.db，唯一有 DB+请求上下文
  └─ resolveAnalyzeJobInput(app, body)         读 JobRepository / ProfileRepository → AnalyzeJobInput
  └─ analyzeJob(input) / buildAnalyzeJobPrompt(input)   server/llm/analyzeJob.ts
        └─ buildAnalysisPrompt(profile, job, company)   src/app/prompt.ts  ← 纯函数/客户端可 import/无 DB
```

- **注入位置裁决**：NovaWing Context 的异步读取**只能在 `server/routes/llm.ts`**（`analyzeJob.ts` 与 `prompt.ts` 均无 `app.db`，且 `prompt.ts` 为客户端可 import 的 isomorphic 纯函数，不能引服务端 NovaWing store）。
- **传递方式**：路由取 `{block, meta}` → 注入 `input.novaWingBlock`（字符串）→ `buildAnalyzeJobPrompt` 透传 → `buildAnalysisPrompt` 新增可选第 4 参消费。全链只多传一个字符串，`analyzeJob.ts` / `prompt.ts` 不新增对 NovaWing 的 import。
- **两路径一致**：非流式 `analyzeJob()` 与流式 `chatCompletionStream(...)` 均经 `buildAnalyzeJobPrompt`，注入点唯一、天然覆盖两路；4 字段分别并入非流式返回体与流式 `type:'done'` 事件。
