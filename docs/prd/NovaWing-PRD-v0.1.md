**星翼 NovaWing**

**PRD v0.1**

个人主线记忆内核与 OfferFlow 首发验证闭环

*理解你的上下文，延伸你的行动能力。*

| **文档状态**     | 已冻结                                 |
|------------------|----------------------------------------|
| **冻结日期**     | 2026-07-24                             |
| **目标产品版本** | NovaWing v0.1                          |
| **首发宿主**     | OfferFlow                              |
| **首版形态**     | 独立内核 / 同进程 / 同库分表 / UI 内嵌 |
| **冻结依据**     | Gemini 首轮评审、二次仲裁与差异复核    |

产品负责人：魏建军 · 仓库：nova-wing

> **v0.1 冻结后一致性修订说明（2026-07-24，基于 OfferFlow 只读代码审计）**
> 本次仅做消歧、补充与一致性修订，**不改变任何冻结产品结论、P0 范围或非目标**。修订固化三点：
> ① 领域所有权——OfferFlow 独占管理 StrategyWindow / CapabilityBaseline / MarketPosition / DecisionGate / jobSearchFocus 等求职领域正式状态，Core 只存跨场景主线、不复制不覆盖、不被回写（见 §16.4）；
> ② 持久化与快照——交付 Snapshot V3，维护显式的"NovaWing 权威表注册表"（新增表须声明是否入快照，不按 `nw_` 前缀自动纳表），注册纳入的全部 `nw_` 权威数据与 `current_core_revision` 同处一条快照 / 恢复边界；导入按版本分流（V2 按 V2、V3 按 V3、未知版本拒绝），保持 V2 导入兼容（见 §13.3、§13.4）；
> ③ 首条集成闭环——岗位分析读取已确认 Core 并注入现有 Prompt，结果记录四个上下文使用字段（见 §17.5、§21.3）。

# **文档控制**

| **项目**     | **内容**                                              |
|--------------|-------------------------------------------------------|
| 文档版本     | v0.1                                                |
| 目标产品版本 | NovaWing v0.1                                         |
| 文档状态     | 已冻结                                                |
| 产品名称     | 星翼 NovaWing                                         |
| 仓库名称     | nova-wing                                             |
| 产品标语     | 理解你的上下文，延伸你的行动能力。                    |
| 首发宿主     | OfferFlow                                             |
| 首版架构     | 独立领域内核、同进程运行、同库分表、OfferFlow 内嵌 UI |
| 冻结日期     | 2026-07-24                                            |
| 冻结结论     | 无新增 P0，可直接进入系统设计阶段                     |

# **目录**

1\. 产品摘要

2\. 背景与问题

3\. 产品愿景

4\. v0.1 核心产品假设

5\. v0.1 产品形态裁决

6\. 核心产品原则

7\. 主线与支线的边界

8\. 目标用户与首发场景

9\. 总体架构

10\. v0.1 核心能力

11\. 页面与交互

12\. 状态模型

13\. 数据模型

14\. 主线类别与信息性质

15\. NovaWing Core API

16\. OfferFlow 接入边界

17\. 首条端到端验证场景

18\. P0 范围

19\. P1 与延后范围

20\. 明确非目标

21\. 功能验收标准

22\. 成功指标

23\. 风险与控制措施

24\. 后续版本路径

25\. v0.1 默认裁决

26\. 冻结条件

27\. 最终产品结论

# **1. 产品摘要**

NovaWing 是一个本地优先的个人 AI 副驾驶内核。

它不以保存全部个人数据为目标，而是维护一份由用户人工确认、数量克制、可解释、可修正的“个人主线核心记忆”。

这些主线记忆用于描述：

- 用户当前处于什么阶段；

- 目前最重要的优先级是什么；

- 哪些原则和约束应影响后续决策；

- 哪些长期目标正在被推进；

- 哪些旧结论已经不再适用。

OfferFlow、未来的浏览器扩展、桌面端及其他 Agent
各自保存自己的领域支线记忆。

子端发现某条领域记忆可能具有跨场景或长期价值时，只能向 NovaWing
提交“记忆晋升提案”，不能直接修改主线。用户批准后，NovaWing
才将其转化为正式主线，并递增核心修订号。

NovaWing v0.1 不建设完整的跨端平台。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>v0.1 唯一验证闭环<br />
</strong>OfferFlow 基于真实求职证据提出主线调整建议 →
用户查看、修改或批准 → NovaWing 正式更新主线 → OfferFlow
在下一次求职决策中读取并应用新主线 →
用户能够观察到决策逻辑发生变化。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# **2. 背景与问题**

用户在多个
AI、应用和项目之间工作时，长期目标和阶段策略会被拆散在不同系统中：

- OfferFlow 了解求职岗位、反馈和职业策略；

- 浏览器知道用户正在阅读和关注什么；

- 桌面端知道当前项目和 Agent 任务；

- 不同 AI 对话只拥有局部上下文；

- 用户需要不断重复解释自己的现状和优先级。

传统 AI 助手容易出现以下问题：

1.  顺着眼前问题回答，却忽略用户当前阶段；

2.  将短期兴趣误判为长期方向；

3.  不同会话和 Agent 给出彼此冲突的建议；

4.  已经过期的旧目标继续影响判断；

5.  将全部聊天记录塞入上下文，造成 token 浪费和记忆污染；

6.  AI 未经用户确认便更新用户画像；

7.  用户无法追溯某条长期结论为什么产生；

8.  用户缺少一个由自己掌控的主线权威源。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>NovaWing 要解决的核心问题<br />
</strong>AI 缺少一份经过用户确认、能够持续约束后续判断的个人主线。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# **3. 产品愿景**

NovaWing 最终应成为跨应用和跨 Agent 的个人主线协调层。

它应帮助不同系统同时理解：

- 用户正在处理什么；

- 用户当前真正优先什么；

- 哪些决定已经确认；

- 哪些结论只是阶段性假设；

- 当前行为是在推进主线、偏离主线，还是说明主线需要调整。

NovaWing 不替用户决定人生，也不将旧主线当成不可改变的命令。

它负责：

- 保持长期上下文连续；

- 暴露当前行动与主线之间的冲突；

- 将主线变化置于人工控制之下；

- 保存必要的来源和理由；

- 让不同应用在未来能够读取同一个权威结论。

# **4. v0.1 核心产品假设**

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>核心假设<br />
</strong>一组由用户人工确认、数量克制、可解释的主线记忆，能否让
OfferFlow
在后续不同求职任务中持续作出更符合用户当前阶段目标的判断，同时避免未经批准的临时建议污染正式决策。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

该假设包含四个部分：

| **维度** | **验证内容**                                                                   |
|----------|--------------------------------------------------------------------------------|
| 一致性   | OfferFlow 在不同任务中能够持续遵循同一组正式主线。                             |
| 决策价值 | 主线记忆能够真实改变岗位分析、策略建议或行动优先级，而不是只作为展示信息存在。 |
| 人工控制 | 未经用户批准的提案绝不能影响后续决策。                                         |
| 可修正性 | 新现实出现后，用户能够替代或废弃旧主线，而不是被旧规则锁死。                   |

v0.1 不验证：

- 多个真实子端之间的同步；

- 浏览器和桌面端产品价值；

- 云端协作；

- 自动化 Agent 调度；

- 完整个人知识库；

- 大规模语义召回。

# **5. v0.1 产品形态裁决**

## **5.1 最终采用方案**

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>方案 C<br />
</strong>独立领域内核，OfferFlow 首发宿主。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

- NovaWing 的领域模型和读写规则独立；

- NovaWing 首版不提供独立客户端；

- NovaWing 与 OfferFlow 运行在同一进程；

- NovaWing 与 OfferFlow 使用同一个 SQLite 数据库文件；

- NovaWing 使用独立的 nw\_ 前缀表；

- OfferFlow 只能通过 NovaWing API 访问其数据；

- OfferFlow 不得直接操作 NovaWing 表；

- NovaWing 的首版 UI 作为 OfferFlow 的正式业务模块存在；

- 浏览器扩展和桌面端不进入 v0.1。

## **5.2 为什么不做完整独立应用**

完整独立应用会产生：

- 独立导航和管理后台；

- 独立进程与生命周期；

- 独立数据库连接；

- 跨应用通信；

- 双重 UI 维护；

- 在没有第二子端时无法验证的基础设施。

这会增加开发成本，却不能更快证明 NovaWing 是否改善真实决策。

## **5.3 为什么不完全写死在 OfferFlow**

如果 NovaWing 直接使用 OfferFlow
的岗位、城市、简历等领域模型，未来将难以服务浏览器和桌面端。

因此必须保持以下边界：

- NovaWing Core 不出现岗位专属字段；

- OfferFlow 领域证据通过摘要和引用传入；

- NovaWing 使用独立表和独立 API；

- NovaWing 不读取 OfferFlow 表并自行推断；

- OfferFlow 负责判断何时提交提案；

- NovaWing 负责审核、正式化和读取主线。

# **6. 核心产品原则**

## **6.1 Core 只保存主线**

NovaWing 不保存全部人生数据，也不复制各子端数据库。Core
只保存能够影响长期或跨场景决策的正式主线。

## **6.2 支线留在子端**

OfferFlow 保存求职领域事实，例如岗位、HR
反馈、简历版本、城市岗位池、面试情况与求职策略证据。这些内容默认不进入
NovaWing。

## **6.3 子端只能提案**

OfferFlow
可以读取正式主线、提交记忆晋升提案、查询提案结果；不能直接新增、修改或废弃正式主线，也不能绕过人工批准影响
Core。

## **6.4 人工最终确认**

正式主线变化必须由用户明确批准，包括直接批准和用户修改内容后批准。拒绝的提案不会影响正式主线。

## **6.5 晋升而非复制**

进入 NovaWing 的不是原始岗位数据或完整分析报告，而是经过提炼的主线结论。

## **6.6 追加式历史**

已经生效的主线记录不原地覆盖。修改通过创建新记录并替代旧记录实现。

## **6.7 轻量修订号**

NovaWing 不保存全量 Core 快照。每次正式主线发生变化时 coreRevision +
1，用于缓存失效、变更标识、提案生效记录与未来最小兼容。

## **6.8 最小相关注入**

OfferFlow 只读取当前任务所需的主线，不加载全部历史和全部提案。

## **6.9 主线必须可修正**

正式主线可以被新记录替代或废弃。NovaWing
不阻止用户改变方向，只确保改变有来源、有理由、有人工确认。

| coreRevision: 12 → 13 |
|-----------------------|

# **7. 主线与支线的边界**

## **7.1 适合进入主线的内容**

- 会影响多个不同求职任务；

- 会显著改变行动优先级；

- 代表用户明确作出的阶段性或长期决定；

- 是多个领域未来都可能需要遵守的原则；

- 修正了当前主线中的过期结论；

- 定义了当前阶段的核心约束；

- 说明在什么条件下应重新评估现有方向。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>合格示例<br />
</strong>当前阶段优先恢复稳定现金流，不能仅因岗位缺少 AI
标签就拒绝其他条件可接受的自研高级前端岗位。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## **7.2 应留在 OfferFlow 的内容**

- 拒绝单休岗位；

- 期望薪资范围；

- Vue 或 React 偏好；

- 某家公司的黑名单；

- 某次面试反馈；

- 某个岗位匹配分；

- 某个城市当天的岗位数量；

- 某份简历适合哪个岗位。

这些信息可能很重要，但不天然属于个人主线。

## **7.3 边界判定规则**

9.  这条信息是否会影响多个未来任务？

10. 它是否改变阶段目标或行动顺序？

11. 它是否由用户明确确认，或有持续证据支持？

12. 它为什么不能只留在 OfferFlow？

13. 如果写入主线，未来哪些判断会被改变？

**不能回答以上问题的内容，不应提交晋升提案。**

# **8. 目标用户与首发场景**

## **8.1 目标用户**

v0.1 为单用户、本地使用设计。

不考虑：

- 多账户；

- 团队协作；

- 组织权限；

- 外部成员；

- 多设备同步。

## **8.2 首发场景**

14. OfferFlow 基于近期求职情况生成策略分析；

15. 分析发现当前正式主线可能需要新增或修正；

16. OfferFlow 提供“申请更新个人主线”操作；

17. 用户查看建议、理由和证据摘要；

18. 用户批准、修改后批准或拒绝；

19. 批准后 NovaWing 更新正式主线；

20. 下一次岗位或策略分析读取最新主线；

21. 分析结果明确体现新的决策优先级。

# **9. 总体架构**

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>OfferFlow<br />
├─ 求职领域数据：岗位 / 反馈 / 简历 / 城市 / 策略证据<br />
├─ NovaWing UI：当前主线 / 待审核提案<br />
└─ OfferFlow Adapter：读取主线 / 提交提案<br />
↓ 本地方法调用<br />
NovaWing Core<br />
├─ 主线读取<br />
├─ 提案审核与生效<br />
├─ 追加式主线记录<br />
└─ coreRevision 管理<br />
↓<br />
同一 SQLite 数据库：OfferFlow 表 / nw_ 独立表</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## **9.1 代码边界**

NovaWing 应作为独立 TypeScript 模块或 package 存在。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>nova-wing/<br />
├─ packages/core/<br />
│ ├─ domain<br />
│ ├─ services<br />
│ └─ contracts<br />
└─ packages/sqlite/<br />
├─ schema<br />
├─ migrations<br />
└─ repositories</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

OfferFlow 中只保留 adapter、context-assembler 与 UI。

## **9.2 运行边界**

- 不独立部署；

- 不启动独立服务；

- 不使用 HTTP 调用；

- 不建立 IPC；

- 不建立微前端；

- 不使用 iframe；

- 通过本地 TypeScript API 调用。

## **9.3 数据边界**

- NovaWing 表统一使用 nw\_ 前缀；

- OfferFlow 不直接写入或查询 NovaWing 表；

- NovaWing 不与 OfferFlow 表做跨领域 JOIN；

- 领域证据由 OfferFlow 转换为摘要和引用后提交；

- 未来抽离数据库时，不应依赖 OfferFlow 表结构。

# **10. v0.1 核心能力**

## **10.1 查看当前主线**

- 当前 coreRevision；

- 当前阶段；

- 当前优先级；

- 当前原则和约束；

- 每条主线的理由；

- 每条主线的来源提案；

- 被替代或废弃的历史关系。

## **10.2 手动初始化主线**

- 用户首次使用时，可以手动创建初始主线提案。

- 手动录入也必须经过预览和确认，不能直接静默写入。

## **10.3 OfferFlow 提交提案**

- 新增主线；

- 替代现有主线；

- 废弃现有主线。

- 提案必须包含建议内容、晋升理由、证据摘要、来源引用、建议类别、建议适用范围和
  baseCoreRevision。

## **10.4 人工审核**

- 批准；

- 修改后批准；

- 拒绝。

- 不支持暂缓、退回补证、多人会签、批量批准和自动批准。

## **10.5 正式生效**

- 确认提案仍为 pending；

- 检查提案是否尚未执行；

- 检查当前 coreRevision；

- 必要时提示提案基于旧修订；

- 创建新的主线记录；

- 记录替代关系；

- coreRevision + 1；

- 将提案标记为已批准；

- 记录最终批准文本和生效修订号；

- 提交事务。

## **10.6 拒绝**

- 正式主线不发生变化；

- coreRevision 不变化；

- 保存拒绝时间和可选原因；

- 同一提案不能再次批准。

## **10.7 读取相关主线**

- OfferFlow 调用 NovaWing 时提交当前任务范围；

- v0.1 仅支持 global 与 career；

- 只返回当前有效、范围匹配的主线及当前 coreRevision；

- 不使用向量数据库、LLM 语义检索、自动相似度判断和复杂召回排序。

# **11. 页面与交互**

NovaWing v0.1 的 UI 作为 OfferFlow
的正式模块存在，不放在“高级设置”深处。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>模块名称<br />
</strong>个人主线</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## **11.1 当前主线**

展示：

- 当前 coreRevision；

- 当前有效主线列表；

- 类别；

- 适用范围；

- 正式内容；

- 成立理由；

- 来源；

- 生效时间；

- 被替代关系。

支持创建手动提案、申请替代、申请废弃、查看来源；不支持原地编辑正式记录。

## **11.2 待审核提案**

- 原始建议；

- 来源类型；

- 晋升理由；

- 证据摘要；

- 来源引用；

- 建议类别和范围；

- 提交时的 baseCoreRevision；

- 当前 coreRevision；

- 是否基于旧修订。

支持直接批准、编辑最终文本后批准、拒绝和填写可选审核备注。

v0.1
不建设独立提案管理后台、多条件高级筛选、子端管理页、权限配置页、全局版本历史页和一键回滚页。

# **12. 状态模型**

## **12.1 提案状态**

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>pending<br />
├─→ approved<br />
└─→ rejected</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

- 新提案默认为 pending；

- approved 和 rejected 均为终态；

- 已批准提案不得再次执行；

- 已拒绝提案不得再次批准；

- 修改后批准仍记为 approved，通过 finalStatement 区分。

## **12.2 主线记录**

主线记录不保存可变的 active / superseded / deprecated
状态。主线使用追加式事件表达：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>set<br />
deprecate</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

当前有效内容通过 memoryKey 的最新记录计算：最新操作为 set
时有效；最新操作为 deprecate
时无效。这样避免状态字段与历史版本形成两个真相源。

# **13. 数据模型**

v0.1 使用两张业务表和一个元数据项。

## **13.1 nw_mainline_entries**

| **字段**            | **类型** | **说明**               |
|---------------------|----------|------------------------|
| id                  | UUID     | 主线记录 ID            |
| memory_key          | string   | 稳定语义标识           |
| operation           | enum     | set / deprecate        |
| category            | enum     | 主线类别               |
| statement           | text     | 正式主线内容           |
| rationale           | text     | 成立或废弃理由         |
| assertion_type      | enum     | 信息性质               |
| scope               | enum     | global / career        |
| supersedes_entry_id | UUID?    | 被当前记录替代的旧记录 |
| source_proposal_id  | UUID?    | 来源提案               |
| core_revision       | integer  | 生效时的核心修订号     |
| created_at          | datetime | 创建时间               |

约束：

- 已写入记录不可原地修改；

- core_revision 必须唯一对应一次正式主线变更；

- supersedes_entry_id 必须指向同一 memory_key；

- deprecate 操作必须指定已有 memory_key；

- 当前有效记录由每个 memory_key 的最大 core_revision 决定。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th>global.current_phase<br />
global.product_priority<br />
career.job_selection_priority<br />
career.city_strategy</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

v0.1 不允许任意无命名空间字符串。

## **13.2 nw_proposals**

| **字段**              | **类型**  | **说明**                      |
|-----------------------|-----------|-------------------------------|
| id                    | UUID      | 提案 ID                       |
| action                | enum      | set / deprecate               |
| target_memory_key     | string?   | 被替代或废弃的主线            |
| category              | enum      | 建议类别                      |
| assertion_type        | enum      | 信息性质                      |
| scope                 | enum      | global / career               |
| proposed_statement    | text      | 子端原始建议                  |
| final_statement       | text?     | 用户最终批准文本              |
| rationale             | text      | 晋升理由                      |
| evidence_summary      | text      | 最小必要证据摘要              |
| source_type           | enum      | offerflow / manual            |
| source_ref            | string?   | OfferFlow 领域引用            |
| base_core_revision    | integer   | 提交时依据的修订号            |
| status                | enum      | pending / approved / rejected |
| review_note           | text?     | 用户审核备注                  |
| applied_entry_id      | UUID?     | 生效后对应主线记录            |
| applied_core_revision | integer?  | 生效修订号                    |
| created_at            | datetime  | 提交时间                      |
| reviewed_at           | datetime? | 审核时间                      |

约束：

- 只有 pending 提案可以审核；

- approved 提案必须同时存在 applied_entry_id 和 applied_core_revision；

- rejected 提案不得存在生效记录；

- 同一提案最多生效一次；

- final_statement 为空时，批准内容使用 proposed_statement；

- 提案状态更新和主线正式写入必须处于同一事务。

## **13.3 current_core_revision**

| current_core_revision = 0 |
|---------------------------|

每次正式主线变化时递增。v0.1 不建立独立 CoreVersion 表，也不保存全量主线快照。

**存储位置（一致性修订）**：`current_core_revision` 保存在 NovaWing 自有的 `nw_` 元数据项中（系统设计中的 `nw_meta`），**不写入 OfferFlow 的通用应用元数据表**。原因是 OfferFlow 通用元数据会随其快照 / 同步机制单独进出，而 `nw_` 主线数据默认不在其中；若把修订号放在通用元数据表，会出现"修订号被同步、对应 `nw_` 主线却丢失"的失步。将修订号与主线记录同置于 `nw_` 边界，是 §13.4 快照边界成立的前提。

## **13.4 持久化与快照边界（Snapshot V3）**

代码审计发现：OfferFlow 的跨设备 / 损坏恢复 / 全新克隆持久化依赖其快照机制，而该机制基于一份表允许列表且限定于旧库版本；`nw_` 表默认不在其中，会在这些场景被静默丢弃。为保证用户已确认的主线不会丢失，v0.1 固化以下要求：

- 交付 **Snapshot V3**，并维护一份**显式的"NovaWing 权威表注册表"**：快照 / 恢复只处理注册表中声明"纳入"的表，**不按 `nw_` 前缀自动纳表**。v0.1 注册表登记主线记录、提案、含 `current_core_revision` 的元数据三张权威表；**未来新增任何 `nw_*` 表都必须显式声明是否进入快照**——声明纳入者走 V3 校验与恢复，声明不纳入者写明理由，未登记的表既不得静默纳入也不得静默丢弃（开发期即视为错误）；
- 注册表中声明纳入的全部 `nw_` 权威数据与 OfferFlow 处于**同一条快照 / 恢复边界**；
- **导入按快照版本分流**：导出一律标记 `snapshotVersion: 3`；导入端先读 `snapshotVersion` 再分流——**V2 按 V2 导入**（旧快照无 NovaWing 段，视为主线尚未初始化、不触发 NovaWing 完整性校验），**V3 按 V3 导入**（按注册表读入全部已注册表并执行修订号与完整性校验），**未知版本（缺失、低于 2、高于 3 或非法值）明确拒绝**、不降级猜测、不产生半完成状态；
- **禁止只同步 `current_core_revision` 而遗漏对应 `nw_` 数据**；修订号与主线记录必须整体进出。

**与非目标的关系**：此处的"快照"指**数据持久化 / 备份 / 恢复能力**，与 §20 中作为非目标的"全量 Core 快照 / 版本树 / 一键回滚"不同——Snapshot V3 不保存每个修订的全量镜像，也不引入分支、合并或回滚，只确保既有追加式 `nw_` 数据随宿主一起存活。

# **14. 主线类别与信息性质**

## **14.1 主线类别**

| **类别**   | **说明**             |
|------------|----------------------|
| phase      | 当前所处阶段         |
| priority   | 当前行动优先级       |
| principle  | 长期或阶段性原则     |
| constraint | 决策约束             |
| decision   | 用户已确认的重要决定 |

暂不支持任意自定义类别、复杂标签体系、自动分类和 Schema 在线扩展。

## **14.2 信息性质**

| **类型**           | **说明**                             |
|--------------------|--------------------------------------|
| user_decision      | 用户明确作出的决定                   |
| confirmed_fact     | 有可靠证据支持的事实                 |
| working_hypothesis | 用户允许暂时采用、仍需现实验证的判断 |

**系统不得把 working_hypothesis 展示为确定事实。**

# **15. NovaWing Core API**

v0.1 提供本地 TypeScript API，不提供 HTTP 服务。

| **API**             | **职责**                                                     |
|---------------------|--------------------------------------------------------------|
| getContext          | 按 global / career 范围读取当前有效主线，返回 coreRevision。 |
| listCurrentMainline | 查询当前全部有效主线。                                       |
| createProposal      | 创建手动或 OfferFlow 提案。                                  |
| approveProposal     | 批准或修改后批准，原子写入正式主线。                         |
| rejectProposal      | 拒绝待审核提案。                                             |
| listProposals       | 按状态查询提案列表。                                         |

API 必须保证：

- OfferFlow 不需要了解底层表结构；

- 正式写入只能通过批准方法发生；

- 批准过程具备事务原子性；

- 返回值包含当前 coreRevision。

# **16. OfferFlow 接入边界**

| **OfferFlow 负责**         | **NovaWing 负责**  |
|----------------------------|--------------------|
| 保存求职领域支线记忆       | 保存正式主线       |
| 生成领域分析               | 保存提案及审核结果 |
| 判断是否值得建议更新主线   | 强制人工批准       |
| 提供最小证据摘要           | 执行追加式主线更新 |
| 提交晋升提案               | 管理 coreRevision  |
| 在求职决策前读取相关主线   | 返回当前有效主线   |
| 将主线装配到求职分析上下文 | 保持必要可追溯性   |

## **16.3 禁止耦合**

- NovaWing 查询岗位表判断主线；

- OfferFlow 直接操作 nw\_ 表；

- NovaWing 数据模型出现岗位、简历、城市公司等专属实体；

- OfferFlow 将全部分析结果复制进 NovaWing；

- NovaWing Core 保存原始聊天记录；

- NovaWing 替代 OfferFlow 的领域策略模型。

## **16.4 领域所有权（一致性修订）**

代码审计确认，OfferFlow 已内建并独占管理下述求职领域正式状态。它们**继续由 OfferFlow 拥有与计算，NovaWing 不复制、不覆盖、不接管**：

- StrategyWindow（策略窗口，由证据等级确定性推导）；
- CapabilityBaseline（能力基线）；
- MarketPosition（市场定位）；
- DecisionGate（决策门，确定性状态）；
- jobSearchFocus（求职焦点，用户在 OfferFlow 内设置）。

据此明确三条边界：

1. **OfferFlow 独占领域正式状态**：上述状态的权威来源始终是 OfferFlow，NovaWing 不建立与之并行的第二真相源。
2. **Core 只存跨场景主线**：NovaWing Core 只保存跨场景的"个人主线核心记忆"（阶段、优先级、原则、约束、决定的**提炼结论**），不得把 OfferFlow 的领域字段（枚举、门状态、匹配分等）原样搬入或镜像。即便 `career.job_selection_priority`、`global.current_phase` 等 memoryKey 名称与 OfferFlow 概念相近，保存的也是用户确认的跨场景原则，而非 OfferFlow 的确定性 / 用户设置字段。
3. **单向提案、不可回写**：OfferFlow 只能向 Core 提交**带来源、证据摘要和版本信息（baseCoreRevision）**的记忆晋升 / 合并提案；不能直接修改 Core，Core 也不回写 OfferFlow 领域状态。主线用于**约束** OfferFlow 判断，而非改写其领域数据。

# **17. 首条端到端验证场景**

## **17.1 初始状态**

当前主线尚未明确规定“生存优先级高于转型纯度”。OfferFlow
分析一个稳定、自研、待遇可接受，但没有明确 AI 业务标签的高级前端岗位。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>初始判断示例<br />
</strong>岗位与 AI
应用工程化转型方向不完全一致，因此推荐优先级一般。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## **17.2 提交提案**

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>拟晋升主线<br />
</strong>当前处于“先生存，再发展”阶段。第一优先级是恢复稳定现金流，不能仅因岗位缺少
AI 标签就拒绝其他条件可接受的自研高级前端岗位。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

提案包含当前求职阶段、现金流优先级、用户此前确认的策略，以及该原则会影响哪些后续岗位判断。

## **17.3 未批准验证**

- 正式主线不变化；

- coreRevision 不变化；

- OfferFlow 后续分析不得应用该提案；

- AI 上下文中不得出现该提案作为正式规则。

## **17.4 批准验证**

- 创建正式主线记录；

- 递增 coreRevision；

- 保存来源提案；

- 将提案标记为 approved。

## **17.5 输出干预验证**

- OfferFlow 岗位分析读取已确认的 Core，并注入现有岗位分析 Prompt；

- 读取新主线；

- 明确引用“先生存，再发展”的阶段策略；

- 将稳定现金流放在转型纯度之前；

- 对岗位给出与批准前可观察不同的判断；

- 不把该主线错误扩展为“所有工作都应接受”；

- 分析结果记录以下四个上下文使用字段（属 OfferFlow 分析元数据，不回写 Core）：`usedNovaWingCoreRevision`、`usedNovaWingMemoryKeys`、`novaWingContextDigest`、`novaWingContextUsedAt`。

**范围限定**：该链路仅用于验证 NovaWing 上下文是否改善岗位判断，**不扩展**浏览器扩展、桌面端、多 Agent 或其他 AI 入口。

# **18. P0 范围**

22. NovaWing 独立领域模块；

23. 与 OfferFlow 同进程运行；

24. 同 SQLite 数据库、nw\_ 独立表；

25. 当前主线列表；

26. 手动创建主线提案；

27. OfferFlow 创建晋升提案；

28. 提案待审核列表；

29. 查看理由和证据摘要；

30. 直接批准；

31. 修改后批准；

32. 拒绝；

33. 追加式 set 主线；

34. 追加式 deprecate 主线；

35. 主线替代关系；

36. 轻量 coreRevision；

37. 批准事务原子性；

38. 同一提案最多执行一次；

39. 按 global / career 读取相关主线；

40. OfferFlow 在至少一个真实决策链路中注入主线；

41. 批准前后决策结果可观察变化；

42. 主线可追溯到来源提案和理由；

43. 断网状态下完整运行。

# **19. P1 与延后范围**

## **19.1 延后到产品假设验证后**

- AI 自动提炼提案；

- 语义相似检测；

- 主线冲突检测；

- 复核提醒；

- 过期提醒；

- 更多 Scope；

- 更多主线类别；

- 版本差异页；

- 独立审计事件表；

- 批量提案处理；

- 提案暂缓和补证；

- 复杂缓存策略。

## **19.2 等第二子端出现后再设计**

- 子端注册；

- 子端身份；

- RBAC；

- 多子端权限；

- 跨进程通信；

- 独立数据库；

- 数据同步协议；

- 浏览器扩展适配；

- 桌面端适配；

- 多端版本协调。

## **19.3 暂不承诺版本**

- 云端账户；

- 多用户；

- 团队主线；

- 手机端；

- 自动操作电脑；

- 多 Agent 自动调度；

- 全量聊天导入；

- 通用个人知识库；

- 情绪监控；

- 自动批准主线；

- AI 自动修改用户长期方向。

# **20. 明确非目标**

- 独立客户端；

- 独立服务；

- 独立进程；

- 独立数据库文件；

- 微前端；

- iframe；

- HTTP API；

- 完整 Event Sourcing 框架；

- 全量 Core 快照；

- 一键回滚；

- 导入和恢复中心；

- 哈希防篡改体系；

- 子端管理页；

- 权限配置页；

- 企业级审批流；

- 自动化主线判断；

- 任意领域记忆中心。

> 说明：此处"全量 Core 快照""一键回滚""导入和恢复中心"指 NovaWing 自建的版本树 / 回滚 / 独立恢复后台。§13.4 的 Snapshot V3 是把 `nw_` 数据纳入 OfferFlow **既有**快照 / 恢复机制的数据持久化能力，不构建上述独立功能，二者不冲突。

# **21. 功能验收标准**

## **21.1 输入控制**

- OfferFlow 能创建一条主线晋升提案；

- 提案包含建议、理由和证据摘要；

- 提案处于 pending 时不影响正式主线；

- 提案处于 pending 时不影响 OfferFlow 后续分析；

- 只有用户批准才能正式生效。

## **21.2 输出干预**

- 批准后 coreRevision 必须递增一次；

- 批准后生成一条正式主线记录；

- 下一次 OfferFlow 决策读取最新主线；

- 分析结果明确引用或体现新主线；

- 批准前后的判断存在可解释差异。

## **21.3 可追溯性**

- 正式主线可以查看来源提案；

- 可以查看原始建议；

- 可以查看用户最终批准文本；

- 可以查看晋升理由和证据摘要；

- 可以查看生效修订号和时间；

- OfferFlow 岗位分析结果记录 `usedNovaWingCoreRevision`、`usedNovaWingMemoryKeys`、`novaWingContextDigest`、`novaWingContextUsedAt`，可据此判定某次分析使用了哪一版主线上下文。

## **21.4 替代与废弃**

- 用户可以通过新提案替代旧主线；

- 旧记录不被原地修改；

- 当前读取只返回最新有效记录；

- 废弃后该 memoryKey 不再进入当前上下文。

## **21.5 数据完整性**

- 批准过程为单事务；

- 任一步骤失败时不产生半完成结果；

- 一个提案不能生效两次；

- coreRevision 不得重复或跳过未提交事务；

- OfferFlow 不得直接操作 NovaWing 表；

- 注册表中声明纳入的全部 `nw_` 权威数据与 `current_core_revision` 处于同一快照 / 恢复边界，不存在只同步修订号却遗漏主线数据的路径；导入按快照版本分流（V2 按 V2、V3 按 V3、未知版本拒绝），导入 / 恢复后修订号与主线记录须通过一致性校验。

## **21.6 本地运行**

- 断网时可以查看主线；

- 断网时可以创建、批准和拒绝提案；

- 断网时 OfferFlow 可以读取正式主线。

# **22. 成功指标**

## **22.1 必须达成**

44. 100% 的正式主线变化均经过用户批准；

45. 0 次未批准提案影响 OfferFlow 正式判断；

46. 0 次 OfferFlow 直接写入 NovaWing 表；

47. 100% 的正式主线可追溯到手动提案或 OfferFlow 提案；

48. 每次批准只递增一次 coreRevision；

49. 至少完成一条真实的“批准前后判断改变”闭环；

50. 正式主线不包含完整岗位、简历或面试数据；

51. 用户能够在一个页面内完成查看主线和审核提案。

## **22.2 北极星验证指标**

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>北极星指标<br />
</strong>用户批准一条主线后，OfferFlow
在后续不同求职任务中能够持续、准确地应用该主线，并产生用户认可的决策改善。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

## **22.3 v0.1 不能证明**

- 多端共享一定有价值；

- 浏览器扩展一定需要 NovaWing；

- 桌面端一定需要 NovaWing；

- 主线检索机制适合所有领域；

- NovaWing 已经是独立商业产品；

- 应立即建设多 Agent 平台。

# **23. 风险与控制措施**

## **23.1 NovaWing 退化为 OfferFlow 偏好设置**

**风险：大量求职偏好被晋升后，NovaWing 变成岗位筛选配置表。**

控制：

- 提案必须说明为什么不能只留在 OfferFlow；

- 领域偏好默认留在 OfferFlow；

- v0.1 重点验证阶段、优先级、原则和约束；

- 评审时展示跨任务影响，而不是单岗位影响。

## **23.2 Core 膨胀**

**风险：主线数量不断增长，最终失去聚焦能力。**

控制：

- 主线类别保持克制；

- Scope 只开放 global / career；

- 同一语义使用稳定 memoryKey；

- 更新优先替代旧记录，而不是不断新增相近记录。

## **23.3 旧主线僵化**

**风险：OfferFlow 机械执行已经过期的阶段规则。**

控制：

- 用户可以提交替代和废弃提案；

- 主线必须展示理由；

- working_hypothesis 不得包装为永久事实；

- v0.2 再根据真实使用决定是否增加复核提醒。

## **23.4 提案审核疲劳**

**风险：OfferFlow 频繁提交低价值建议。**

控制：

- v0.1 不自动高频提交；

- 提案由明确用户操作或重要策略节点触发；

- 不支持后台静默批量生成；

- 同类低价值提案留在领域支线。

## **23.5 逻辑独立但开发割裂**

**风险：独立包导致跨仓库修改和调试成本增加。**

控制：

- v0.1 不独立运行；

- API 保持极小；

- 使用本地包依赖完成联调；

- 不建立网络协议；

- UI 和业务验证仍在 OfferFlow 内完成。

## **23.6 轻量模型缺少未来扩展性**

**风险：第二子端出现后需要调整 Schema。**

控制：

- 领域模型不包含 OfferFlow 专属字段；

- 保留 source_type、source_ref、scope 和 coreRevision；

- 第二子端出现后再基于真实需求升级协议；

- 不为尚不存在的客户端提前建设平台。

## **23.7 nw_ 数据被宿主快照静默遗漏**

**风险：`nw_` 表默认不在 OfferFlow 快照 / 同步范围内，损坏恢复、跨设备导入或全新克隆时用户已确认的主线被静默丢失，或只剩修订号而无主线记录。**

控制：

- 交付 Snapshot V3，以显式的"NovaWing 权威表注册表"纳表（新增 `nw_*` 表须声明是否入快照，不按前缀自动纳表），把注册纳入的全部 `nw_` 权威数据与 `current_core_revision` 纳入同一快照 / 恢复边界；

- 修订号存于 `nw_` 边界而非宿主通用元数据表，杜绝失步（见 §13.3）；

- 导入 / 恢复按快照版本分流（V2 按 V2、V3 按 V3、未知版本拒绝），并增加修订号与完整性校验，保持对旧 V2 快照的兼容；

- 以专门测试覆盖注册表纳表、版本分流、快照往返与失步防护。

# **24. 后续版本路径**

每个版本必须对应一个新的待验证假设，而不是平均堆功能。

## **v0.1：验证主线能否改善 OfferFlow 决策**

- 人工确认的主线是否真正改变后续判断；

- 用户是否愿意维护少量正式主线；

- 提案与人工批准是否比直接改配置更有价值。

## **v0.2：验证主线治理是否需要智能辅助**

只有在主线或提案数量明显增加、用户经常遇到重复冲突或过期内容、人工整理成为实际负担后启动。

- 相似提案提醒；

- 冲突提示；

- 主线复核建议；

- AI 辅助压缩提案；

- 简单修订差异。

## **v0.3：验证第二子端能否共享同一主线**

只有浏览器扩展或桌面端形成真实使用场景后启动。

- 第二子端适配器；

- 子端身份；

- Scope 扩展；

- 跨进程读取方式；

- 最小同步协议；

- 子端来源区分。

## **后续版本**

- 独立 NovaWing 客户端；

- 独立数据库；

- 多设备同步；

- 加密备份；

- 多 Agent 协调；

- 跨应用行动建议；

- 更完整的个人 AI 副驾驶体验。

# **25. v0.1 默认裁决**

52. 单用户；

53. 单设备；

54. OfferFlow 为唯一真实宿主；

55. NovaWing 逻辑独立；

56. NovaWing 与 OfferFlow 同进程；

57. NovaWing 与 OfferFlow 同 SQLite 数据库文件；

58. NovaWing 使用独立 nw\_ 表；

59. OfferFlow 只能通过 NovaWing API 访问；

60. UI 位于 OfferFlow 的“个人主线”正式模块；

61. 不做独立客户端；

62. 不做完整 Core 快照；

63. 保留轻量 coreRevision；

64. 不做 RBAC 和子端注册；

65. 不做通用审计表；

66. 必要追溯字段直接保留在业务实体；

67. 不做复杂提案状态机；

68. 提案只支持批准、修改后批准和拒绝；

69. 提案批准必须原子且最多执行一次；

70. 正式主线采用追加式记录；

71. 主线与求职领域偏好严格区分；

72. v0.1 只验证一个真实业务闭环；

73. 浏览器和桌面端不进入首版范围。

# **26. 冻结条件**

**以下冻结条件已经全部满足：**

☑ Gemini 差异复核确认原有 P0 过度设计已实质删除；

☑ 轻量 coreRevision 未重新演变成全量版本系统；

☑ 两张业务表不存在新的双重真相；

☑ 提案批准事务具备单次执行约束；

☑ 主线和 OfferFlow 领域偏好边界清楚；

☑ P0 未重新加入多端平台能力；

☑ 首个验收场景能够真实改变 OfferFlow 判断；

☑ 所有 P0 均服务于同一个产品假设。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>冻结裁决<br />
</strong>Gemini 差异复核未发现新增 P0，PRD v0.1
可直接冻结并进入系统设计阶段。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# **27. 最终产品结论**

NovaWing v0.1 的目标不是搭建一个完整的个人 AI 平台。

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>v0.1 必须证明<br />
</strong>用户人工确认的一条个人主线，能够被安全地写入、被 OfferFlow
持续读取，并真实改变后续求职决策。</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

**Core 只存主线，不复制 OfferFlow 的领域数据。**

**OfferFlow 保存支线，只能申请晋升，不能直接修改主线。**

**未批准提案绝不能影响正式判断。**

**正式修改采用追加式记录，并保留轻量修订号与必要来源。**

**业务入口先融入 OfferFlow，核心领域边界保持独立。**

如果这条闭环不能产生真实决策价值，就不应继续建设浏览器扩展、桌面端或多
Agent 平台。

如果它能够产生稳定价值，NovaWing 才获得从 OfferFlow 走向跨应用个人 AI
副驾驶的资格。

**— 需求冻结结束 · 进入系统设计 —**
