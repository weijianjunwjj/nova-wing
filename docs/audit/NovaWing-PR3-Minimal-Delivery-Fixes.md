# PR #3 原最小交付闭环修正

日期：2026-10-03；源码基线 `1b3b0a73dbcf2f22a0472e70de44789cfbbc84bf`，macOS arm64 / Node 24.21.0。
本轮真实模型请求 0，没有重新生成或更改原隔离方案、40 个阻断断言、固定测试及客户状态。
PR 保持草稿、不合并。本机当前 commit、完整命令日志及历史证据见验收主机
`artifacts/pr3-local-acceptance-20261002/acceptance.md`。

## 消除的生产阻塞

1. 新增同版本独立复审 HTTP / PlanningService 入口，复用既有审查与收据签发逻辑。
   plan ID、version、规范业务内容 hash 均匹配才接受；结束时重读，内容变更丢弃结果。
   复审不调用 planner，不生成新版，不批准、不冻结。原规划 provider 来源缺失则阻断。
2. 测试先复现原方案 AS1 被误判 HTTP；窄范围修正模块/函数/测试契约分类，原 40 项现均
   采用真实 assertion-scoped command/test 证据。保留 API、UI、平台边界和精确验证标准。
   候选谓词现在包含原断言的输入、输出及证据要求，避免遗漏输入数值而无法绑定；未放宽校验器。
3. 同一 owner/commit 的待绑定蓝图一次审查，各项独立返回 assertionId/evidenceHash/verdict/issues。
   缺项、重复、未知 ID、错配哈希、拒绝或证据漂移使整组失败。返回之后重新检查仓库与材料，
   再分别产生候选哈希与审查绑定；删除绑定或把别项结果移过来也失败。
   实际验证仍按断言执行，未将一次模型通过复用于其他断言。

## 验证

- 新增针对性回归覆盖原真实方案分类、复审 HTTP 鉴权/重启/版本/哈希/并发/内容漂移/自审阻断、
  批量结果反例、40 项单次审查及独立绑定。
- 生产 VERIFY 装配测试执行两个真实 node:test 验证器；模型审查使用测试替身。缺一项结果时
  两项绑定均不落盘；成功时逐项绑定并执行。不能把测试替身当作真实模型语义验收。
- 既有规划、交付、冻结、权限及完成门禁相关测试一并复验；最终源码 `npm run check` exit 0，
  Node 1,415 项 / Desktop 193 项通过，包含 typecheck、unused、migration、exports、boundary、platform 和 governance 检查。不声称 Windows/macOS 双平台通过。
- 619 行 JSON fixture 是原隔离纯模块方案的完整 draft 副本，保留全部 40 项，测试未依赖主机绝对路径。
  原实际方案仍 planning_failed，不使用测试收据替换真实审查。

## 下一轮预算：已核定部分与剩余缺口

已发生请求的累计保守上界为 ¥1.873920（包含原历史 ¥1.726464 及上次 DeepSeek 请求），实际累计扣费 UNKNOWN。
本轮真实模型调用 0。沿用已确认路由/模型/人民币单价（每百万 token）：DeepSeek input 2/output 8；
Claude input 4、cache creation 5、cache read 0.2、output 20，输入保守取 5；Claude 沿用 7890 出口。

生产模型调用数量：PlanningService 同版复审 1 次；原方案 T2 的 40 项蓝图准备成功后，Claude batch 1 次，
无自动修订或逐项 fallback；两个 Runtime Review 任务各调用 Reviewer，但**不等于各一次外发 HTTP**。
`reviewer-adapters.ts` 的 `REVIEW_DEFAULT_MAX_TURNS=40`，允许只读工具；`review-dispatcher.ts` 对
PASS 漏 assertion verdict 还会重调一次（本轮用户没有授权此自动补调）。CLI turn 也不能作为传输重试的金额硬限制。
因此先前把 Runtime Review 两个任务直接计作两个付费请求，不能证明完整生产路径费用。

可供下一轮预检的严格限额方案如下，**尚未作为真实 Runtime 外发门禁验收，不能标 PASS**：

| 角色 | 外发模型 POST 上限 | 完整输入/输出 token 上限 | 费用上界 |
| --- | --- | --- | --- |
| DeepSeek 独立复审 deepseek-flash | 1 | 65,536 / 8,192 | ¥0.196608 |
| Claude 完整蓝图集合 claude-opus-5-5 | 1 | 262,144 / 8,192 | ¥1.474560 |
| DeepSeek Runtime Review（两任务合计，含工具续轮） | 4 | 每次 131,072 / 8,192 | ¥1.310720 |
| 加历史 | 新增最多 6 次付费 POST，失败也计次 | 超限即停止 | **¥4.855808 ≤ ¥5** |

这里 Runtime Review 的工具续轮属于正常审查流程，不是授权错误重试；错误、拒绝、遗漏协议结果和输出续写
均需按用户停止要求阻断，不能仅靠总次数限制放行自动修订。4 次是否足以完成两个真实任务尚未验证。
按 40 turn × 2 个任务、每 turn 假设恰一次请求做情景计算，Runtime 部分已达 ¥26.214400；这只是说明默认
配置不能沿用少次数预算，既不是实际扣费，也不是已验证的 HTTP 请求上限。

未来必须逐次捕获完整请求，检查 body≤32,768 / 131,072 / 65,536 bytes（复审/Claude batch/Runtime），
按两倍 body bytes 预留输入及协议开销，并检查实际模型、max_tokens、次数和已消耗总额。40 项真实蓝图的
材料要等实现后才存在；不能为了套进表格改断言、假设缓存命中或删除证据。单次 body 过大或 Runtime 超过
4 次外发就停止，不能声称在预算内完成。若给 Claude 196,608-byte 输入门禁，其他条件相同则累计上界
为 ¥5.511168，超过 ¥5，故该更大输入预留不能与 4 次 Runtime 请求同时采用。

Codex 沿用 ChatGPT 包含额度：本轮不重新规划，未来 workspace preflight 最多 1 turn，T1/T2 各最多
1 次 Executor 任务启动；允许既有传输行为，不切 API 计费、不购买 credits、不重启失败任务。
额度不足停止，不能把免费包含额度当作无限调用许可。

**结论：批量审查消除了已知的 40 次蓝图费用障碍；目前仍不能保证完整闭环累计≤¥5。**
有 ¥4.855808 的条件式限额方案，但实际 batch 输入和 Runtime 多轮外发边界尚未验收。生产源码未新增计费系统。

## 剩余闭环

下一次必要模型调用是原方案的同版本 DeepSeek 独立复审，通过才能获得生产收据，再单独进行
隔离测试批准/冻结、Launchpad、真实 Codex 实现、批量 Claude 蓝图审查、验证与 Runtime Review，
最终以生产完成门禁判定交付。真实拒绝须原样保留，不能凭本轮单元测试补收据或改状态。
