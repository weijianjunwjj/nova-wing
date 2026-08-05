# 星翼 NovaWing 系统设计 v0.1

**副标题：个人主线记忆内核与 OfferFlow 首发集成设计**

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.1 |
| 对应 PRD | 星翼 NovaWing PRD v0.1 |
| 目标产品版本 | NovaWing v0.1 |
| 文档状态 | 待实现前评审 |
| 创建日期 | 2026-07-24 |
| 产品负责人 | 魏建军 |
| 首发宿主 | OfferFlow |
| 仓库名称 | `nova-wing` |
| 架构形态 | 独立领域内核、同进程运行、同库分表、OfferFlow 内嵌 UI |

> 本文是实现前技术基线，不得扩大冻结 PRD 的产品范围。OfferFlow 只读代码审计可以修正具体接入方式，但不能擅自增加多端平台、独立服务、RBAC 或全量版本系统。

---

## 1. 系统设计目标

NovaWing v0.1 必须以最低工程成本实现以下闭环：

```text
OfferFlow 产生主线提案
→ 用户人工审核
→ NovaWing 原子写入正式主线
→ coreRevision 递增
→ OfferFlow 下次分析读取最新主线
→ 决策结果发生可解释变化
```

系统必须保证：

1. 未批准提案绝不进入正式上下文；
2. OfferFlow 不能绕过 NovaWing API 直接修改主线；
3. 同一提案最多生效一次；
4. 正式主线追加写入，不原地覆盖；
5. 当前有效主线只有一种计算方式；
6. `coreRevision` 只是轻量水位线，不演变为全量版本平台；
7. NovaWing 不依赖 OfferFlow 的岗位、简历、公司、城市等领域表结构；
8. 将来出现第二子端时，不需要推翻核心领域模型；
9. v0.1 不引入独立服务、HTTP、IPC、RBAC 或多端同步。

---

## 2. 明确非目标

v0.1 不设计或实现：

- 独立 NovaWing 客户端；
- 独立进程、服务或网络端口；
- 独立 SQLite 数据库文件；
- 多用户与登录体系；
- 子端注册、权限和 RBAC；
- 多设备或多端同步；
- 浏览器扩展和桌面端；
- 全量 Core 快照；
- 分支、合并、版本树和一键回滚；
- 通用 Event Sourcing 框架；
- 向量检索和语义召回；
- AI 自动审核或自动修改正式主线；
- 通用个人知识库；
- 企业级通用审计平台。

---

## 3. 核心架构裁决

### 3.1 逻辑独立

NovaWing 拥有独立的：

- 领域类型；
- 数据表与迁移；
- Repository Port；
- Application Service；
- API Facade；
- 错误码；
- 单元测试和数据库测试夹具。

NovaWing 核心不得引用：

- OfferFlow 岗位实体；
- OfferFlow 简历、公司、城市等业务实体；
- OfferFlow AI Payload；
- OfferFlow 页面组件；
- OfferFlow 领域服务。

### 3.2 物理不独立

v0.1 中 NovaWing：

- 与 OfferFlow 运行在同一进程；
- 复用 OfferFlow 已有 SQLite 连接与事务能力；
- 使用同一个数据库文件；
- 不开放 HTTP；
- 不使用 IPC；
- 不运行单独后台服务。

### 3.3 同库分表

逻辑上需要三张表：

```text
nw_meta
nw_proposals
nw_mainline_entries
```

其中：

- `nw_proposals` 与 `nw_mainline_entries` 是业务表；
- `nw_meta` 只保存轻量内核元数据；
- 所有表使用 `nw_` 前缀；
- OfferFlow 业务代码不得直接访问 `nw_` 表；
- NovaWing 不与 OfferFlow 表执行跨领域 JOIN。

### 3.4 UI 内嵌

OfferFlow 中增加正式模块：

```text
个人主线
├─ 当前主线
└─ 待审核提案
```

UI 属于 OfferFlow 展示层，但全部数据操作必须经过 NovaWing Facade。

---

## 4. 代码组织基线

> 下面是审计前推荐结构。最终采用独立仓库、本仓库 workspace package 或内部强边界模块，由 OfferFlow 只读审计后裁决；产品与领域边界不随代码摆放方式变化。

### 4.1 NovaWing 目标仓库结构

```text
nova-wing/
├─ packages/
│  ├─ core/
│  │  ├─ src/
│  │  │  ├─ domain/
│  │  │  ├─ application/
│  │  │  ├─ ports/
│  │  │  └─ index.ts
│  │  └─ package.json
│  ├─ sqlite/
│  │  ├─ src/
│  │  │  ├─ migrations/
│  │  │  ├─ repositories/
│  │  │  └─ sqlite-nova-wing-store.ts
│  │  └─ package.json
│  └─ testing/
│     ├─ src/
│     └─ package.json
├─ docs/
│  ├─ prd/
│  │  └─ NovaWing-PRD-v0.1-Frozen.md
│  └─ design/
│     └─ NovaWing-System-Design-v0.1.md
├─ pnpm-workspace.yaml
└─ package.json
```

包名建议：

```text
@novawing/core
@novawing/sqlite
@novawing/testing
```

### 4.2 OfferFlow 集成层建议

```text
offerflow/
└─ src/
   └─ modules/
      └─ nova-wing/
         ├─ adapter/
         ├─ context/
         ├─ ui/
         ├─ routes.ts
         └─ index.ts
```

### 4.3 依赖方向

```text
OfferFlow UI
     ↓
OfferFlow NovaWing Adapter
     ↓
NovaWing Facade / Core
     ↓
NovaWing Repository Ports
     ↑
NovaWing SQLite Adapter
     ↓
OfferFlow 现有 SQLite 连接
```

禁止：

```text
NovaWing Core → OfferFlow
NovaWing SQLite → OfferFlow 业务实体
NovaWing Repository → OfferFlow 岗位表
OfferFlow 页面 → nw_* SQL
```

---

## 5. 核心领域模型

### 5.1 MemoryKey

`memoryKey` 是一条主线语义的稳定身份：

```text
<namespace>.<name>
```

v0.1 允许的命名空间：

```text
global
career
```

示例：

```text
global.current_phase
global.product_priority
global.data_ownership_principle
career.job_selection_priority
career.city_strategy
```

校验规则：

- 只允许小写字母、数字、短横线和下划线；
- 必须包含一个命名空间分隔符；
- 总长度不超过 100；
- 不允许动态生成无意义随机 Key；
- 相同语义必须复用相同 Key。

推荐正则：

```text
^(global|career)\.[a-z0-9][a-z0-9_-]{1,79}$
```

#### 5.1.1 与 OfferFlow 领域字段的消歧（重要）

NovaWing 的 `memoryKey` 保存的是**跨场景的个人主线结论**（原则 / 阶段 / 优先级 / 决定），即使名称与 OfferFlow 字段相近，也**不是同一事实、不共享真相源**：

| NovaWing 主线（跨场景结论，用户确认） | OfferFlow 正式领域状态（OfferFlow 独占管理） |
|---|---|
| `global.current_phase`：用户确认的人生/求职阶段原则（如"先生存，再发展"） | `StrategyWindowType`（由证据等级确定性推导，AI 不可改）；`jobSearchFocus` 枚举（用户在 OfferFlow 内设置） |
| `career.job_selection_priority`：用户确认的选岗指导原则（如"不因缺 AI 标签拒绝可接受的自研高级前端岗"） | `StrategyAction.priority`（确定性、AI 被禁止写入）；`DecisionGate` 状态（确定性） |
| `career.city_strategy`：用户确认的城市取向原则 | MarketPosition 的 `city_priority` 决策门（确定性 / 用户确认，留在 OfferFlow） |

约束：

- NovaWing **不得**把 OfferFlow 的原始领域字段（枚举值、门状态、匹配分等）原样晋升为主线；只有提炼后的跨场景原则/决定才可进入 Core；
- NovaWing 主线用于**约束** OfferFlow 的判断，但 OfferFlow 领域状态的权威计算仍在 OfferFlow，Core 不回写、不覆盖（详见 §13、§24）。

### 5.2 MainlineEntry

```ts
type MainlineOperation = 'set' | 'deprecate'

type MainlineCategory =
  | 'phase'
  | 'priority'
  | 'principle'
  | 'constraint'
  | 'decision'

type AssertionType =
  | 'user_decision'
  | 'confirmed_fact'
  | 'working_hypothesis'

type MainlineScope = 'global' | 'career'

interface MainlineEntry {
  id: string
  memoryKey: string
  operation: MainlineOperation
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  statement: string | null
  rationale: string
  supersedesEntryId: string | null
  sourceProposalId: string
  coreRevision: number
  createdAt: string
}
```

不保存可变的 `active` 状态。当前状态由每个 `memoryKey` 最新的 `coreRevision` 决定。

### 5.3 MemoryProposal

```ts
type ProposalAction = 'set' | 'deprecate'
type ProposalStatus = 'pending' | 'approved' | 'rejected'
type ProposalSourceType = 'offerflow' | 'manual'

interface MemoryProposal {
  id: string
  action: ProposalAction
  memoryKey: string
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  proposedStatement: string | null
  finalStatement: string | null
  rationale: string
  evidenceSummary: string
  sourceType: ProposalSourceType
  sourceRef: string | null
  baseCoreRevision: number
  baseTargetEntryId: string | null
  status: ProposalStatus
  reviewNote: string | null
  appliedCoreRevision: number | null
  createdAt: string
  reviewedAt: string | null
}
```

正式记录通过 `nw_mainline_entries.source_proposal_id` 反查，避免在提案表和主线表之间维护双向事实。

### 5.4 CoreRevision

```ts
type CoreRevision = number
```

约束：

- 初始值为 `0`；
- 每次正式主线变化递增 `1`；
- 创建、拒绝提案不递增；
- 一次批准只能产生一个新修订号；
- 不保存全量快照；
- 不提供回滚树、分支和合并；
- **`current_core_revision` 只存放在 `nw_meta`，不得写入 OfferFlow 的 `app_meta` 或任何独立于 `nw_` 数据同步的元数据表**。此约束保证修订号与其对应的 `nw_mainline_entries` 处于同一持久化 / 快照 / 恢复边界（详见 §17.6），杜绝"同步了修订号却丢失主线记录"的失步。

---

## 6. 数据库逻辑 DDL

> 正式 SQL 必须适配 OfferFlow 当前 SQLite 驱动、迁移和事务框架。下列 DDL 是逻辑约束基线，不要求在审计前直接执行。

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS nw_meta (
  key TEXT PRIMARY KEY,
  integer_value INTEGER,
  text_value TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (integer_value IS NOT NULL AND text_value IS NULL)
    OR
    (integer_value IS NULL AND text_value IS NOT NULL)
  )
);

INSERT OR IGNORE INTO nw_meta (
  key,
  integer_value,
  text_value,
  updated_at
) VALUES (
  'current_core_revision',
  0,
  NULL,
  CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nw_proposals (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL
    CHECK (action IN ('set', 'deprecate')),
  memory_key TEXT NOT NULL,
  category TEXT NOT NULL
    CHECK (category IN (
      'phase', 'priority', 'principle', 'constraint', 'decision'
    )),
  assertion_type TEXT NOT NULL
    CHECK (assertion_type IN (
      'user_decision', 'confirmed_fact', 'working_hypothesis'
    )),
  scope TEXT NOT NULL
    CHECK (scope IN ('global', 'career')),
  proposed_statement TEXT,
  final_statement TEXT,
  rationale TEXT NOT NULL
    CHECK (length(trim(rationale)) > 0),
  evidence_summary TEXT NOT NULL
    CHECK (length(trim(evidence_summary)) > 0),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('offerflow', 'manual')),
  source_ref TEXT,
  base_core_revision INTEGER NOT NULL
    CHECK (base_core_revision >= 0),
  base_target_entry_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  review_note TEXT,
  applied_core_revision INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  CHECK (
    (action = 'set'
      AND proposed_statement IS NOT NULL
      AND length(trim(proposed_statement)) > 0)
    OR
    (action = 'deprecate'
      AND proposed_statement IS NULL)
  ),
  CHECK (
    (status = 'pending'
      AND reviewed_at IS NULL
      AND applied_core_revision IS NULL)
    OR
    (status = 'approved'
      AND reviewed_at IS NOT NULL
      AND applied_core_revision IS NOT NULL)
    OR
    (status = 'rejected'
      AND reviewed_at IS NOT NULL
      AND applied_core_revision IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS nw_mainline_entries (
  id TEXT PRIMARY KEY,
  memory_key TEXT NOT NULL,
  operation TEXT NOT NULL
    CHECK (operation IN ('set', 'deprecate')),
  category TEXT NOT NULL
    CHECK (category IN (
      'phase', 'priority', 'principle', 'constraint', 'decision'
    )),
  assertion_type TEXT NOT NULL
    CHECK (assertion_type IN (
      'user_decision', 'confirmed_fact', 'working_hypothesis'
    )),
  scope TEXT NOT NULL
    CHECK (scope IN ('global', 'career')),
  statement TEXT,
  rationale TEXT NOT NULL
    CHECK (length(trim(rationale)) > 0),
  supersedes_entry_id TEXT,
  source_proposal_id TEXT NOT NULL UNIQUE,
  core_revision INTEGER NOT NULL UNIQUE
    CHECK (core_revision > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supersedes_entry_id)
    REFERENCES nw_mainline_entries(id),
  FOREIGN KEY (source_proposal_id)
    REFERENCES nw_proposals(id),
  CHECK (
    (operation = 'set'
      AND statement IS NOT NULL
      AND length(trim(statement)) > 0)
    OR
    (operation = 'deprecate'
      AND statement IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_nw_entries_memory_revision
  ON nw_mainline_entries(memory_key, core_revision DESC);

CREATE INDEX IF NOT EXISTS idx_nw_entries_scope_revision
  ON nw_mainline_entries(scope, core_revision DESC);

CREATE INDEX IF NOT EXISTS idx_nw_proposals_status_created
  ON nw_proposals(status, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_nw_entries_no_update
BEFORE UPDATE ON nw_mainline_entries
BEGIN
  SELECT RAISE(ABORT, 'nw_mainline_entries is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_nw_entries_no_delete
BEFORE DELETE ON nw_mainline_entries
BEGIN
  SELECT RAISE(ABORT, 'nw_mainline_entries is append-only');
END;
```

---

## 7. 当前有效主线投影

唯一投影规则：

1. 对每个 `memory_key` 找到 `core_revision` 最大的记录；
2. 最新操作为 `set` 时有效；
3. 最新操作为 `deprecate` 时无效；
4. 不读取待审核提案；
5. 不额外维护 `is_active`、当前指针或全量快照。

```sql
WITH latest_entries AS (
  SELECT
    entry.*,
    ROW_NUMBER() OVER (
      PARTITION BY entry.memory_key
      ORDER BY entry.core_revision DESC
    ) AS row_number
  FROM nw_mainline_entries AS entry
)
SELECT *
FROM latest_entries
WHERE row_number = 1
  AND operation = 'set'
  AND scope IN (?, ?);
```

短期内存缓存允许存在，但必须通过 `coreRevision` 失效，缓存不能成为权威源。

---

## 8. 创建提案流程

```ts
interface CreateProposalInput {
  action: 'set' | 'deprecate'
  memoryKey: string
  category: MainlineCategory
  assertionType: AssertionType
  scope: MainlineScope
  proposedStatement?: string
  rationale: string
  evidenceSummary: string
  sourceType: 'offerflow' | 'manual'
  sourceRef?: string
}
```

流程：

```text
读取 currentCoreRevision
→ 校验 memoryKey、action、statement
→ 读取该 memoryKey 的当前最新记录
→ deprecate 时确认目标存在且有效
→ 保存 baseTargetEntryId
→ 写入 nw_proposals(status = pending)
→ 返回提案
```

创建提案不改变正式主线，不递增 `coreRevision`。

---

## 9. 批准事务

推荐 SQLite 使用 `BEGIN IMMEDIATE` 或当前数据库框架的等价写事务，以防多个批准同时读取相同修订号。

事务步骤：

1. 读取提案；
2. 确认状态仍为 `pending`；
3. 读取当前 `coreRevision`；
4. 读取目标 `memoryKey` 当前最新记录；
5. 比较 `baseTargetEntryId`，检测陈旧提案；
6. 计算 `nextRevision = currentRevision + 1`；
7. 插入正式主线记录；
8. 条件更新提案为 `approved`；
9. 比较并更新 `current_core_revision`；
10. 提交事务。

任何失败必须完整回滚。

伪代码：

```ts
async function approveProposal(input: {
  proposalId: string
  finalStatement?: string
  reviewNote?: string
}) {
  return transactionManager.immediate(async () => {
    const proposal = await proposalRepository.get(input.proposalId)

    if (!proposal) {
      throw new NovaWingError('PROPOSAL_NOT_FOUND')
    }
    if (proposal.status !== 'pending') {
      throw new NovaWingError('PROPOSAL_ALREADY_REVIEWED')
    }

    const currentRevision =
      await metadataRepository.getCurrentCoreRevision()
    const latestEntry =
      await mainlineRepository.findLatestByMemoryKey(
        proposal.memoryKey
      )

    validateProposalAgainstCurrentState({
      proposal,
      latestEntry,
      currentRevision,
    })

    const nextRevision = currentRevision + 1
    const statement =
      proposal.action === 'set'
        ? normalizeStatement(
            input.finalStatement ?? proposal.proposedStatement
          )
        : null

    const entry = await mainlineRepository.append({
      memoryKey: proposal.memoryKey,
      operation: proposal.action,
      category: proposal.category,
      assertionType: proposal.assertionType,
      scope: proposal.scope,
      statement,
      rationale: proposal.rationale,
      supersedesEntryId: latestEntry?.id ?? null,
      sourceProposalId: proposal.id,
      coreRevision: nextRevision,
    })

    const reviewed = await proposalRepository.markApproved({
      proposalId: proposal.id,
      finalStatement: statement,
      reviewNote: input.reviewNote ?? null,
      appliedCoreRevision: nextRevision,
      expectedStatus: 'pending',
    })

    if (!reviewed) {
      throw new NovaWingError('PROPOSAL_CONCURRENTLY_REVIEWED')
    }

    const revised =
      await metadataRepository.compareAndSetCoreRevision({
        expected: currentRevision,
        next: nextRevision,
      })

    if (!revised) {
      throw new NovaWingError('CORE_REVISION_CONFLICT')
    }

    return { entryId: entry.id, coreRevision: nextRevision }
  })
}
```

---

## 10. 陈旧提案处理

不能仅因 `baseCoreRevision` 小于当前修订号，就阻止所有提案，因为无关 Key 的变化不应导致提案失效。

允许继续批准：

- 目标 `memoryKey` 自提案创建后未变化；
- 当前最新记录 ID 与 `baseTargetEntryId` 一致；
- action 仍然有效。

必须阻止：

- 目标 Key 已被其他正式记录修改；
- 要废弃的 Key 已被废弃；
- 创建时不存在的 Key 现在已有不兼容内容；
- 旧提案试图覆盖更新后的正式主线。

v0.1 不提供自动 Rebase。陈旧提案需基于当前主线重新创建。

---

## 11. 拒绝提案

拒绝只条件更新提案：

```sql
UPDATE nw_proposals
SET
  status = 'rejected',
  review_note = ?,
  reviewed_at = CURRENT_TIMESTAMP
WHERE id = ?
  AND status = 'pending';
```

影响行数必须等于 `1`，否则返回 `PROPOSAL_ALREADY_REVIEWED`。

拒绝不产生正式记录、不递增 `coreRevision`、不改变上下文。

---

## 12. NovaWing Core API

```ts
interface NovaWingFacade {
  getCurrentCoreRevision(): Promise<number>

  getContext(input: GetContextInput):
    Promise<MainlineContext>

  listCurrentMainline():
    Promise<MainlineContext>

  createProposal(input: CreateProposalInput):
    Promise<MemoryProposal>

  listProposals(input?: ListProposalInput):
    Promise<MemoryProposal[]>

  getProposal(proposalId: string):
    Promise<MemoryProposal | null>

  approveProposal(input: ApproveProposalInput):
    Promise<ApproveProposalResult>

  rejectProposal(input: RejectProposalInput):
    Promise<void>

  getEntrySource(entryId: string):
    Promise<MainlineEntrySource | null>
}
```

稳定错误码：

```ts
type NovaWingErrorCode =
  | 'INVALID_MEMORY_KEY'
  | 'INVALID_PROPOSAL'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_REVIEWED'
  | 'PROPOSAL_CONCURRENTLY_REVIEWED'
  | 'TARGET_MEMORY_NOT_FOUND'
  | 'TARGET_MEMORY_ALREADY_DEPRECATED'
  | 'STALE_PROPOSAL'
  | 'CORE_REVISION_CONFLICT'
  | 'TRANSACTION_FAILED'
  | 'STORE_NOT_INITIALIZED'
```

业务层不得向 OfferFlow 泄露原始 SQL 错误。

---

## 13. OfferFlow Adapter

OfferFlow Adapter 负责把求职领域信息转换为 NovaWing 通用输入：

```ts
interface OfferFlowNovaWingAdapter {
  proposeCareerMainline(
    input: CareerMainlineProposalInput
  ): Promise<MemoryProposal>

  getCareerContext(): Promise<MainlineContext>
}
```

```ts
interface CareerMainlineProposalInput {
  memoryKey: string
  action: 'set' | 'deprecate'
  category: MainlineCategory
  assertionType: AssertionType
  proposedStatement?: string
  rationale: string
  evidence: {
    summary: string
    sourceRef?: string
  }
}
```

规则：

- 只传最小证据摘要，不传完整岗位、简历或分析对象；
- `sourceRef` 是弱引用，只用于回跳；
- NovaWing 不解析 SourceRef 主动读取 OfferFlow；
- 即使 SourceRef 失效，正式主线仍可凭证据摘要解释。

---

## 14. AI Context Assembler

v0.1 只接入一个真实 AI 决策入口，不同时改造全部 AI 功能。

```text
OfferFlow 准备分析输入
→ NovaWing.getContext(['global', 'career'])
→ 获取 coreRevision 与有效主线
→ 转换为结构化主线块
→ 注入 AI Payload / Prompt
→ 执行分析
→ 保存使用过的 Revision 与 MemoryKey
```

Prompt 片段示例：

```text
【用户已确认的个人主线】

以下内容经过用户人工确认，应作为当前决策的重要约束。
它们不是全部事实，也不能被过度外推。

1. [阶段｜global.current_phase]
   当前处于“先生存，再发展”阶段。

2. [优先级｜career.job_selection_priority]
   当前优先恢复稳定现金流，不能仅因岗位缺少 AI 标签就拒绝其他条件可接受的自研高级前端岗位。

使用规则：
- 优先遵循当前有效主线；
- 不得使用待审核提案；
- 不得将领域原则扩展为无条件规则；
- 现实岗位信息与主线冲突时，应明确说明冲突；
- 本次判断使用的 NovaWing Core Revision：13。
```

AI Payload 不包含：

- 历史或已废弃主线；
- 待审核或被拒绝提案；
- 全部证据；
- 审核备注；
- OfferFlow 数据库主键和 SourceRef。

OfferFlow 分析结果必须记录以下四项 NovaWing 上下文使用元数据：

```text
usedNovaWingCoreRevision   // 本次分析读取的 coreRevision（整数）
usedNovaWingMemoryKeys     // 本次注入 Prompt 的有效主线 memoryKey 列表
novaWingContextDigest      // 注入主线块的稳定摘要（如 memoryKey+coreRevision 归一化后的哈希），用于判定两次分析是否使用了相同主线上下文
novaWingContextUsedAt      // 读取并注入主线的时间戳
```

这些**属于 OfferFlow 分析元数据，不写回 NovaWing Core**（Core 不因被读取而改变，符合 §24 的单向依赖）。

落点与范围（依据实现前只读审计结论）：

- v0.1 的唯一注入入口是 OfferFlow 现有的岗位分析链路（`/api/llm/analyze-job` 及其流式版本 `/api/llm/analyze-job-stream`），它是当前唯一在生产中无条件注册且有真实 UI 触发的 AI 决策入口；
- 主线块作为一个新增段落注入现有 Prompt 装配函数（`buildAnalysisPrompt`），不改动 Provider 签名、不新增独立 AI 通道；
- 上述四个字段随岗位记录持久化（岗位分析结果存于 `jobs` 记录的 JSON 负载中），**无需新增数据库列 / 迁移**即可承载；
- 该链路只用于验证"NovaWing 上下文是否改善岗位判断"，**不扩展**浏览器扩展、桌面端、多 Agent 或其他 AI 入口（详见 PRD 冻结非目标）。

---

## 15. UI 接入基线

推荐路由：

```text
/personal-mainline
```

侧边栏名称：

```text
个人主线
```

页面包含：

### 15.1 当前主线

展示：

- 当前 `coreRevision`；
- 当前有效主线；
- `memoryKey`；
- 类别、范围和信息性质；
- 正式内容与理由；
- 生效时间与来源。

操作：

- 创建手动提案；
- 申请替代；
- 申请废弃；
- 查看来源。

禁止：

- 直接编辑正式记录；
- 直接删除；
- 直接切换启用状态。

### 15.2 待审核提案

展示：

- 建议动作和内容；
- 目标 `memoryKey`；
- 提案来源；
- 理由和证据摘要；
- 提交时与当前修订号；
- 陈旧风险。

操作：

- 批准；
- 修改后批准；
- 拒绝。

批准前显示：

```text
批准后 Core Revision：12 → 13
```

陈旧提案提示：

```text
该提案基于旧的主线内容，不能直接批准。
请根据当前主线重新创建提案。
```

---

## 16. 缓存策略

v0.1 可完全不做持久化缓存。每次正式 AI 分析前读取当前修订号和有效主线，当前数据量下成本可忽略。

如使用内存缓存：

1. 查询 `current_core_revision`；
2. 与缓存修订号一致则复用；
3. 不一致则重新查询投影。

缓存永远不是权威源。

---

## 17. 初始化与迁移

首次启动：

```text
执行 NovaWing Migration
→ 创建 nw_* 表
→ 初始化 current_core_revision = 0
→ 页面显示“尚未建立个人主线”
→ 用户可创建手动提案
```

不自动把 OfferFlow 历史策略批量导入 NovaWing。

推荐初始 Key：

```text
global.current_phase
career.job_selection_priority
global.data_ownership_principle
```

迁移应复用 OfferFlow 现有数据库启动流程。具体迁移目录和 API 由代码库审计确定。

### 17.6 持久化与快照边界（Snapshot V3）

**审计发现（必须处理）**：OfferFlow 真正的跨重启 / 跨设备 / 损坏恢复持久化，依赖其快照与同步机制，而该机制当前基于一份**硬编码表允许列表**，且**硬门限于 `schemaVersion === 2`**。后果：

- `nw_` 表不在允许列表中，会在快照导出 / 导入、跨设备同步、损坏恢复、全新克隆时被**静默丢弃**；
- `nw_` 表通过新迁移（v9+）加入后，库版本高于 2，会使基于 `schemaVersion === 2` 的导出**直接抛错**；
- 只有全文件 `VACUUM INTO` 备份天然包含 `nw_` 表，但它不是常规恢复路径。

**设计裁决**：v0.1 必须交付 **Snapshot V3**，把 NovaWing 权威数据纳入与 OfferFlow 同一条快照 / 恢复边界。要求如下：

1. **维护显式的"NovaWing 权威表注册表"（不按前缀自动纳表）**：Snapshot V3 **不再依据 `nw_` 前缀自动纳表**，而是维护一份显式的 **NovaWing 权威表注册表**（NovaWing authoritative table registry），快照 / 恢复只处理注册表中声明为"纳入快照"的表。v0.1 注册表登记三张权威表：`nw_mainline_entries`（canonical 主线）、`nw_proposals`（提案）、`nw_meta`（含 `current_core_revision`，即 version 信息）。v0.1 的 audit 以内联可追溯字段 + 应用日志实现，暂无独立审计表。**约束：任何未来新增的 `nw_*` 表都必须在注册表中显式声明是否进入快照——声明纳入的表必须走 V3 校验与恢复流程，声明不纳入的表必须写明理由；未在注册表登记的 `nw_*` 表既不得被静默纳入、也不得被静默丢弃，缺失登记应在开发期即视为错误。** 以显式注册取代前缀自动纳表，是为杜绝"新表因命名巧合被误纳"与"应纳表因未加前缀被漏纳"两类风险。
2. **同一原子边界**：`current_core_revision` 与 `nw_mainline_entries` 必须在同一次快照 / 恢复中整体进出。**禁止只同步 `current_core_revision` 而遗漏对应 `nw_` 数据**（这正是把修订号留在 `nw_meta`、不放进 `app_meta` 的原因，见 §5.4）。
3. **按快照版本分流校验（V2 按 V2、V3 按 V3、未知版本拒绝）**：导出端一律写出 `snapshotVersion: 3`。导入端**必须先读取 `snapshotVersion` 并据此分流**，不同版本走各自的导入与校验路径，禁止用同一套"放宽后的门限"笼统处理：
   - **`snapshotVersion === 2`**：按 V2 路径导入。V2 快照**不含** NovaWing 段，导入后 NovaWing 视为尚未初始化（`current_core_revision = 0`、无主线、无提案），不触发第 4 条的 NovaWing 完整性校验，保证向后兼容。
   - **`snapshotVersion === 3`**：按 V3 路径导入。必须依据 NovaWing 权威表注册表（第 1 条）读入全部已注册权威表，并强制执行第 2 条的原子边界与第 4 条的修订号 / 完整性校验。
   - **其他任何版本值（含缺失、低于 2、高于 3 或非法值）**：**明确拒绝导入并报错**，不得降级猜测、不得按最接近版本"尽力导入"，也不得产生半完成状态。
4. **修订号与完整性校验**：导入 / 恢复后必须校验
   - `nw_meta.current_core_revision == MAX(nw_mainline_entries.core_revision)`（无记录时为 0）；
   - 每个 `nw_mainline_entries.source_proposal_id` 能在 `nw_proposals` 命中，且对应提案为 `approved`；
   - `core_revision` 无重复、无跳号覆盖未提交事务；
   - 任一校验失败 → 拒绝导入并报错，不得产生半完成状态。
5. **边界说明（避免与冻结非目标冲突）**：Snapshot V3 是**数据持久化 / 备份 / 恢复能力**，不是"全量 Core 版本快照"或版本树。它不新增分支、合并、回滚树，也不保存每个修订的全量镜像；它只保证既有的追加式 `nw_` 数据随宿主快照一起存活。

---

## 18. 测试设计

### 18.1 领域单元测试

覆盖：

- MemoryKey 校验；
- set/deprecate 提案校验；
- `finalStatement` 选择规则；
- 只有 pending 可以审核；
- approved/rejected 不能再次批准；
- 陈旧目标检测；
- 当前主线投影；
- deprecate 后不再返回；
- 重设已废弃 Key 后重新生效。

### 18.2 SQLite / Repository 测试

覆盖：

- Migration 可重复执行；
- 外键配置；
- 主线记录禁止 UPDATE/DELETE；
- `source_proposal_id` 唯一；
- `core_revision` 唯一；
- CHECK 约束生效；
- 当前投影正确；
- SourceRef 可失效；
- 事务失败完整回滚。

### 18.2.1 Snapshot V3 快照与恢复测试

覆盖：

- 导出快照包含注册表中声明纳入的全部 `nw_` 权威表（entries / proposals / meta）；
- **注册表驱动纳表**：新增一张已登记"纳入"的 `nw_*` 测试表时，导出 / 导入会覆盖它；新增一张登记"不纳入"的表时被稳定排除；新增一张**未登记**的 `nw_*` 表时按错误处理（既不静默纳入，也不静默丢弃）；
- 快照往返（导出→导入）后主线、提案、`current_core_revision` 完全一致；
- **版本分流**：`snapshotVersion === 2` 走 V2 路径（无 NovaWing 段，视为未初始化且不报错、不触发 NovaWing 完整性校验）；`snapshotVersion === 3` 走 V3 路径（读入全部已注册表并执行完整性校验）；
- **未知版本拒绝**：缺失、低于 2、高于 3 或非法的 `snapshotVersion` 一律拒绝导入并报错，不降级猜测、不产生半完成状态；
- `current_core_revision` 与 `MAX(core_revision)` 一致性校验；失步时拒绝导入；
- 不存在"只同步修订号、丢失 `nw_` 数据"的路径；
- 迁移到 v9+ 后关闭 / 导出不再因 `schemaVersion === 2` 抛错。

### 18.3 并发与单次执行测试

覆盖：

1. 同一提案连续批准两次；
2. 同一提案并发批准两次；
3. 两个不同提案同时批准；
4. 中途任一步骤失败；
5. `coreRevision` 不重复；
6. 失败事务不增加修订号。

### 18.4 OfferFlow 集成测试

```text
创建提案
→ pending 不进入 Context
→ 批准
→ Revision 增加
→ Context 返回新主线
→ OfferFlow Prompt 包含新主线
→ 分析结果记录 usedNovaWingCoreRevision / usedNovaWingMemoryKeys
   / novaWingContextDigest / novaWingContextUsedAt
```

### 18.5 端到端验收

固定同类岗位样本，用相同模型配置和可比输入分别执行批准前与批准后分析。批准后结果必须体现现金流优先于转型纯度，并记录新 `coreRevision`。

---

## 19. 可观测性

不建立通用审计表，但应用日志至少记录：

```text
NOVAWING_MIGRATION_COMPLETED
NOVAWING_PROPOSAL_CREATED
NOVAWING_PROPOSAL_APPROVED
NOVAWING_PROPOSAL_REJECTED
NOVAWING_STALE_PROPOSAL_BLOCKED
NOVAWING_CORE_REVISION_CHANGED
NOVAWING_CONTEXT_READ
NOVAWING_TRANSACTION_FAILED
```

日志只记录：

- proposalId；
- memoryKey；
- coreRevision；
- sourceType；
- errorCode；
- duration。

日志不得保存完整个人主线、完整证据、原始 Prompt 和敏感信息。

---

## 20. 安全与隐私

- 正式主线只保存在本地 SQLite；
- 不依赖外部模型维护主线状态；
- 外部模型只收到当前任务所需的正式主线；
- 待审核提案不得进入 Prompt；
- v0.1 不提供删除正式主线历史的普通 UI；
- 未来隐私级永久删除需要单独的数据治理设计。

---

## 21. 性能边界

预计规模：

```text
当前主线 Key：少于 100
历史主线记录：少于 1,000
提案：少于 5,000
```

目标是本地查询、提案批准和 Context 装配无明显等待。v0.1 不为十万级数据建设分区、归档或搜索集群。

---

## 22. 实施顺序

### 阶段 0：OfferFlow 只读审计

核实：

- SQLite 驱动和连接；
- 迁移与事务；
- AI Prompt/Payload 链路；
- 首条 AI 业务入口；
- 分析元数据；
- 路由和 UI；
- 测试与备份。

### 阶段 1：领域内核

- 领域类型；
- Repository Port；
- Facade；
- 内存实现；
- 单元测试。

### 阶段 2：SQLite 实现

- Migration；
- 三张表；
- 当前投影；
- 批准事务；
- 不可变约束；
- Snapshot V3：显式权威表注册表纳表、按快照版本分流导入、修订号与完整性校验；
- Repository 测试。

### 阶段 3：OfferFlow 最小 UI 接入

- Adapter；
- “个人主线”路由；
- 当前主线；
- 待审核提案；
- 手动提案。

### 阶段 4：AI 决策闭环

- 选择一个真实分析入口；
- Context Assembler；
- Prompt/Payload 注入；
- 记录 Revision 和 MemoryKey；
- 批准前后结果对比。

### 阶段 5：验收

- 单元、数据库、集成和 E2E 测试；
- 固定样本验证；
- 确认无 P0；
- 发布 NovaWing v0.1。

---

## 23. 实现前代码库审计项

开发前必须只读检查 OfferFlow：

1. SQLite 驱动；
2. 事务 API；
3. Migration 机制；
4. 数据库元数据表；
5. AI 分析 Payload；
6. Prompt 装配位置；
7. 岗位或策略分析入口；
8. 分析结果元数据能力；
9. 路由和侧边栏扩展；
10. 测试框架与数据库测试夹具；
11. Monorepo 或包依赖方式；
12. 备份是否自然包含 `nw_` 表。

审计只能影响技术适配，不能修改冻结 PRD 的范围。

---

## 24. 关键架构不变量

```text
pending proposal ∉ current mainline context
```

```text
approved proposal → exactly one mainline entry
```

```text
one committed mainline change → coreRevision + 1
```

```text
failed transaction → no new entry,
no proposal transition,
no revision change
```

```text
current state = latest entry by memoryKey
```

```text
OfferFlow domain data ≠ NovaWing Core data
```

```text
NovaWing Core does not query OfferFlow tables
```

```text
user approval is the only formalization gate
```

```text
OfferFlow owns StrategyWindow / CapabilityBaseline /
MarketPosition / DecisionGate / jobSearchFocus (formal domain state)
```

```text
NovaWing Core → OfferFlow domain state = write-forbidden
(OfferFlow only submits sourced+evidenced+versioned proposals)
```

```text
all registered nw_ authoritative data + current_core_revision
share one snapshot / recovery boundary
```

```text
sync(current_core_revision) without sync(nw_ entries) = forbidden
```

```text
snapshot inclusion = explicit registry membership
(NOT nw_ prefix auto-inclusion);
unregistered nw_ table = build-time error
```

```text
import dispatch by snapshotVersion:
v2 → V2 path, v3 → V3 path, otherwise → reject
```

---

## 25. Definition of Done

- [ ] NovaWing 领域模块可独立测试；
- [ ] NovaWing 与 OfferFlow 同进程工作；
- [ ] `nw_` 表成功迁移；
- [ ] 正式主线记录不可更新和删除；
- [ ] 当前有效主线投影唯一；
- [ ] 提案支持创建、批准、修改后批准和拒绝；
- [ ] 未批准提案不进入 Context；
- [ ] 同一提案无法批准两次；
- [ ] 批准事务失败不留下半完成状态；
- [ ] 每次批准只增加一次 `coreRevision`；
- [ ] 陈旧目标提案不能覆盖新主线；
- [ ] OfferFlow 不直接访问 `nw_` 表；
- [ ] NovaWing 不读取 OfferFlow 表；
- [ ] “个人主线”页面可查看和审核；
- [ ] OfferFlow 领域正式状态（StrategyWindow / CapabilityBaseline / MarketPosition / DecisionGate / jobSearchFocus）仍由 OfferFlow 独占管理，NovaWing 未复制或覆盖；
- [ ] NovaWing Core 不回写 OfferFlow 领域状态，OfferFlow 只提交带来源 / 证据 / 版本信息的提案；
- [ ] Snapshot V3 维护显式的 NovaWing 权威表注册表，新增 `nw_*` 表必须声明是否纳入快照，不按 `nw_` 前缀自动纳表；
- [ ] 注册表中声明纳入的全部 `nw_` 权威数据与 `current_core_revision` 处于同一快照 / 恢复边界（Snapshot V3）；
- [ ] 导入按 `snapshotVersion` 分流：V2 按 V2 导入、V3 按 V3 导入，未知版本明确拒绝；
- [ ] 不存在只同步 `current_core_revision` 而遗漏 `nw_` 数据的路径；
- [ ] 导入 / 恢复后 `current_core_revision` 与主线记录通过一致性校验；
- [ ] 至少一个 OfferFlow AI 分析入口（岗位分析链路）使用 NovaWing Context；
- [ ] 分析结果记录 usedNovaWingCoreRevision / usedNovaWingMemoryKeys / novaWingContextDigest / novaWingContextUsedAt；
- [ ] 固定样本中批准前后出现可解释判断变化；
- [ ] 断网状态下完整闭环可运行；
- [ ] 所有 P0 测试通过；
- [ ] 未新增浏览器、桌面端、多 Agent 或云同步功能。

---

## 26. 最终系统设计结论

NovaWing v0.1 不是独立平台，而是具有明确领域边界的本地内核。

> **独立的是领域规则，不是运行环境。**

> **共享的是 SQLite 基础设施，不是业务数据模型。**

> **保留的是追加历史和轻量修订号，不是完整版本平台。**

> **OfferFlow 提供真实业务场景，NovaWing 提供受控主线。**

> **只有人工批准的主线，才能影响后续 AI 决策。**

> **OfferFlow 独占其求职领域正式状态；NovaWing 只保存跨场景主线，且单向被读取、从不被回写。**

> **`nw_` 权威数据与修订号共享同一快照与恢复边界，绝不允许修订号与主线记录失步。**

系统设计成功的标准不是表结构多漂亮，而是用户批准一条主线后，OfferFlow 下一次真的作出更符合当前阶段的判断，并且整个变化过程安全、可解释、可追溯。
