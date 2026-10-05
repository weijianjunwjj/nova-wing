# NovaWing Backlog（Owner 维护）

维护：Claude Cowork（Principal Product & Architecture Owner）。进入 backlog ≠ 已授权实现；
每项开工前仍需用户给出本轮任务契约（范围、预算、Git 权限、停止条件）。

## 排序规则

v0.5 hardening（SIMPLIFY_BOUNDARY + Addendum-1 纠偏）优先，backlog 项不得插队、
不得占用其执行轮次、不得修改其任务书范围。

---

## EM-1 Execution Metrics / Model Economics（旁路）

登记：2026-10-04。口径更新：2026-10-04（用户决定，见文末）。
状态：BACKLOG，文档层面已收口（未授权实现，未授权任何模型 / 付费调用）。
实现任务书、实现 review 与验收由 Owner 负责，不再逐字段外部复核。

### 目标

用真实开发任务自动比较 Codex 与 DeepSeek 的执行端经济性：每个实际分配的任务——无论
最终接受、放弃还是接力——花了多少、几次尝试、多少时间、多少次 Cowork 审阅。
为"模型可替换、可控成本完成真实交付"提供第一份非 scripted 的成本证据
（现有 [v0.1/v0.2 benchmark](../benchmark/NovaWing-v0.1-v0.2-Benchmark.md) 的真实成本 KPI 为 UNAVAILABLE）。
Cowork 自身费用不可得，因此本项产出的是**执行端成本**，不得称为完整总成本。

### 版本决定

**进入 v0.6，作为 v0.6 第一个工作项（v0.6-M0），先于任何 v0.6 功能项。**

- 入口条件：v0.5 SIMPLIFY Addendum-1 经 Owner 独立 review ACCEPTED（§6 十条判据，
  含 `npm run check` / `check:desktop` 0 failed）。在此之前不开工、不出任务书。
- 不放进 v0.5：v0.5 brief §7 已把"v0.6 规划 / 顺手重构"列为 non-goal；Addendum-1 正在
  修 harness 隔离缺陷，此时测量会把 harness 噪声算进模型成本；executor 轮次也不应分流。
- 不往后推：v0.6 的功能任务本身就是测量样本。先装仪表，后面每个 v0.6 任务都自动成为数据；
  晚装则 v0.6 整段数据丢失，又只能事后回忆补录（违反"禁止人工录数据"）。

### 架构位置

开发流程旁路工具，不是产品 Runtime 的一部分。

- 代码在 `tools/execution-metrics/`，不进 `packages/`；产品代码不得 import 它，
  它也不 import `packages/development-guardian` 的 executor / Controller / Analytics。
  理由：被测对象不能和测量仪表共用一套 adapter，否则改 adapter 会同时改变"被测"和"读数"。
- 直接包装外部 CLI：Codex 用 `codex exec --json`，DeepSeek 用现有 Claude CLI + DeepSeek
  endpoint 的 `claude -p --output-format json`。
- 数据：`artifacts/execution-metrics/metrics.sqlite` 与 `artifacts/execution-metrics/reviews/`
  （`artifacts/`、`*.sqlite` 已在 `.gitignore`）。不读写 `~/Library/Application Support/NovaWing`，
  与 v0.2.5 `task_run_*` 表无关，Controller / 路由 / gate 不读它。
- 复用仓库已锁定的 SQLite 依赖，不新增依赖。
- 职责边界待核：若将来 cc-auto（模型执行层）承担统一 launcher，本工具迁移过去；
  永久记忆路径当前不可访问，此项跨项目判断标记为待核实。

### 数据来源与写入者

| 事实 | 写入者 | 来源 | 是否由 executor 自报 |
| --- | --- | --- | --- |
| task（id、目标、baseline commit、taskClass、测试命令、cohort、指派 executor 及原因 / 随机种子） | launcher `task create` | 创建时冻结 | 否 |
| attempt（executor、model、开始/结束、wall time、exit） | launcher `attempt run` | launcher 自己的单调时钟与子进程状态 | 否 |
| usage（input / cached / output / reasoning tokens） | launcher | CLI 事件流中 provider 计量字段：Codex `turn.completed.usage`；Claude CLI JSON 的 usage 字段（DeepSeek 下字段是否齐全**待核实**） | 否（provider 计量，不读模型自述） |
| cost（三栏，见下） | `report` 计算 | 渠道价格 / 价目表 × usage；**不采信** Claude CLI `total_cost_usd`（按 Anthropic 价目计，对 DeepSeek 不成立） | 否 |
| git diff | launcher，进程退出后 | `base..worktree`（含未跟踪文件）的 numstat + sha256 | 否（内容是 executor 产出，统计由 launcher 计算） |
| tests | launcher，进程退出后 | 执行 task 创建时冻结的测试命令，隔离 HOME / DATA；记录 exit、计数、log sha256 | 否 |
| verdict / disposition | Cowork review artifact | 见下节 | 否 |

executor 的自述 summary 只作文本留存，不参与任何指标。

"不是自报"不等于"executor 影响不到"。测试由 launcher 执行，但 executor 可以修改被执行的
测试文件；冻结的是测试命令，不是测试内容。这一风险沿用 Cowork 验收检查（审 diff 中的
测试改动与断言是否被弱化），不为 EM-1 另造防篡改机制。diff numstat 会把测试文件改动单列给审阅者。

### Cowork review artifact

每次验收由 Cowork 自动写一份 `reviews/<attemptId>.<round>.review.json`（不可覆盖，复审写新 round）：
`schemaVersion, taskId, attemptId, diffSha256, verdict(ACCEPTED|REJECTED),
next(RETRY|RELAY|ABANDON，仅 REJECTED 时必填), round, findings[{severity, category}],
regressionOf[taskId], reviewedAt`。放弃与接力由此记录，不由人工录入，也不由 executor 声明。

`ingest` 拒收：schema 不符；attemptId / diffSha256 与 launcher 记录不一致；
`reviewedAt` 早于 attempt 结束；文件位于该 attempt 的 worktree 内。
诚实边界：同 UID 进程直接写 `reviews/` 不防（与 v0.5 F3-C 同类 KNOWN_RESIDUAL）。

### 成本口径（三栏分列，互不相加、互不替代）

- **实际新增支出**：provider 计量 usage × 该渠道实际价格（带生效日期与来源）。DeepSeek 按量计费即此栏；
  Codex 走订阅时记为 `SUBSCRIPTION_NOT_ALLOCATED`，不按任务摊月费，也不记为 0。
  按费率算出、未与账单对账的金额一律标 `RATE_COMPUTED_UNRECONCILED`，不冒充账单确认；
  本项不实现账单对账，因此 EM-1 产出中不会出现"账单已确认"状态。
- **资源用量**：tokens（分 input / cached / output / reasoning）与 wall time，各路线原样报告。
- **价目表估算**：按公开价目表折算的参考值，明确标为估算，仅用于跨渠道参照，不冒充实际支出。

未知不当零：任一 attempt 缺 usage 或缺价格 → 该 attempt 与所属 task 的成本为 `UNKNOWN`。
汇总报告已知部分之和、`UNKNOWN` attempt 数与成本覆盖率；比率只在成本完整的任务上计算并注明 n。

### 指派与样本

- Owner 先筛选双方都适合的同类、低中风险任务，`task create --eligible` 由 launcher 随机决定
  首发路线并记录种子（cohort=`RANDOMIZED`）。关键任务由 Owner 单独指派并记录原因
  （cohort=`DIRECT`），不进入路线对比，成本仍计入执行端总支出。
- 首批：每条路线 10 个随机实际分配任务。每个任务只计一次、只按首次分配归属；
  不为凑样本重复执行同一任务。
- 样本阈值按**实际分配数**计，不只数 ACCEPTED；报告同时列出 ACCEPTED / ABANDONED / OPEN 分布。
  某路线 < 10 → `INSUFFICIENT_SAMPLE`。达到 10 → `FIRST_BATCH_COMPLETE`，report 仍不输出优劣结论；
  结论由 Owner 结合任务构成另行分析。

### 指标（SQLite 视图，RANDOMIZED cohort 按首发路线分组，同时按 taskClass 分层）

失败、放弃和接力的成本一律计入首发路线的任务，不得漏掉。

**同集合规则**：每个比例的分子必须是分母集合的子集，且来自同一次 report 快照的同一过滤条件
（cohort、路线、taskClass、终态、成本完整性）。报告对每个比例输出分母集合定义与 n；
成本类比例先按"成本完整"过滤，再同时计算分子和分母，不允许分子用已知部分、分母用全部任务。

- First Pass Rate＝首次 attempt 在 round 1 即 ACCEPTED 的任务 / 已到终态（ACCEPTED 或 ABANDONED）的任务；OPEN 单列。
- Accepted Task Cost＝已接受任务全部 attempt（含被拒、接力到另一路线的 attempt）的执行端成本之和 / 已接受任务数；分子分母均限于成本完整的已接受任务。
- Strategy Cost per Success（策略单位成功成本）＝该路线已到终态任务（ACCEPTED + ABANDONED）的全部执行端成本 / 其中 ACCEPTED 数；分子分母均限于成本完整的终态任务。这是"选这条路线首发"的真实单位成本，含放弃成本；ACCEPTED 数为 0 时输出 `NO_SUCCESS`，不输出无穷或 0。
- Non-accepted Cost＝ABANDONED 与 OPEN 任务的执行端成本，单列，同样遵守 UNKNOWN 规则。
- Attempts＝每个任务的 attempt 数（中位数与均值），按 ACCEPTED / ABANDONED 分开。
- Relay Decision Rate＝出现过 `next=RELAY` review 的任务 / 已到终态的任务。
- Actual Relay Rate（即 Escalation Rate）＝launcher 记录到 executor ≠ 首发 executor 的 attempt 的任务 / 已到终态的任务。
  两者分开报告：有接力决定但未发生实际接力的任务单列（例如随后被放弃）；没有 RELAY 决定却出现跨路线 attempt 的任务标为异常，不静默计入。
- Median Time＝task 创建到 ACCEPTED review 的 wall time 中位数。
- Cowork Review Load＝每个任务的 review round 数及 findings 数（Cowork token / 费用不可得，不记）。
- Regression Rate＝已接受任务在其后 14 天内被任一 review 的 `regressionOf` 指向的比例。

### 最小实现边界

- 三条命令：`task create`、`attempt run`、`report`（ingest 在 report 前自动执行）。
  report 只输出 Markdown 表 + JSON，**不做 dashboard、不做 UI、不接 Launchpad**；
  标题与字段使用"执行端成本"，不出现"总成本"。
- 非测试代码约 ≤ 500 行；超出即停并报告。
- 测试：fixture 化的两种 CLI 输出（含缺失 usage）、伪造 / 错配 / 早于 attempt 的 review 被拒、
  指标 SQL 在构造数据上的期望值（含 ABANDONED / RELAY / OPEN）、缺 usage 或价格时为 UNKNOWN 而非 0、
  订阅渠道不产生按任务摊销的数字、样本阈值按分配数计算；
  接力决定与实际接力不一致的两种情形、Strategy Cost per Success 含放弃成本及 `NO_SUCCESS`、
  混入成本未知任务时各比例的分子分母仍为同一集合、费率计算金额带 `RATE_COMPUTED_UNRECONCILED` 标注。

### 明确不做

dashboard / 图表 / 前端；人工录入或补录任何指标；executor 自评或自写 verdict；
改动 NovaWing 产品 executor、Controller、Analytics、v0.5 gate；签名 / 防篡改加固；
测试内容防篡改系统；单独的付费探针；历史任务回填（没有 launcher 记录的任务不进入统计）。

### 已定口径（用户决定，2026-10-04）

1. 不单独安排付费探针。先用样例输出验证解析器；首个已授权真实任务顺带核实 usage 字段，
   字段缺失时该 attempt 记 `UNKNOWN` 并修解析器，不为此追加调用。
2. 成本按上文三栏分列；Codex 订阅不按任务摊月费。
3. 指派与样本按上文"指派与样本"执行。
4. review artifact 保留 `next`；实现区分接力决定与实际接力、补 Strategy Cost per Success、
   比例同集合、未对账费率金额显式标注。均不新增模块、不追加调用。

开工条件与授权不变：v0.5 ACCEPTED 之前不实现、不调用模型或付费 API。
