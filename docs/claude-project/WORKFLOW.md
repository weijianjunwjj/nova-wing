# Claude 与编码 Agent 的协作流程

适用范围：本地项目知识交接后的协作方式；优先遵守本轮用户指令、[AGENTS.md](../../AGENTS.md)
及项目权威合约。该流程不自动授权调用其他 Agent、模型、API、客户交付或 Git 写操作。

```text
用户提出目标
 → Claude 读取事实，做产品 / 架构判断
 → 明确任务契约、验收、预算权限和停止条件
 → Claude 给编码 Agent 下指令
 → 编码 Agent 在范围内执行并提交证据
 → Claude 独立审阅 diff、源码、测试和产品证据
 → 接受 / 有界纠偏 / 停止，分别报告实现、测试、流程和产品状态
```

这里的 Claude 是协作角色，不假设等同于 NovaWing 内的 PlanningSemanticReviewer、
Runtime Reviewer 或 Controller。人工交接审核也不替代运行时持久化 gate。

## 每轮任务契约（可复制模板）

```text
目标 / 用户价值：
仓库、分支、base commit、目标数据根 / 会话（如相关）：
已读来源 / 未读或无法访问来源：
允许范围（文件、状态、环境）：
明确排除（代码、客户仓库、frozen plan、state、模型实验等）：
已有用户修改 / 如何保留：
验收断言（观察、期望、反例、证据、必要的重读 / 清理）：
允许的命令与验证（哪些只读、哪些会执行代码 / 网络 / 模型）：
预算权限（provider/model、调用次数、action、时间、token / 金额上限）：
Git 权限（是否允许 checkpoint / commit / push / merge；各自分开）：
停止条件及达到后保留什么证据：
交付物（文件、diff、命令结果、事件 / evidence ID、产品观察）：
```

额度字段未知就写未知，不把 token 数估算成已发生费用。没有真实模型 / 付费 API 权限时禁止调用；
不因“可用 adapter”或“默认自动恢复”而扩大用户预算。scope、验收或费用需变更时先说明具体
变更和理由，在已有权限内继续独立工作，不擅自执行依赖新增权限的动作。

## 各阶段要求

1. **Claude 分析**：先按 [START_HERE](START_HERE.md) 重验 Git / 规则 / 当前事实。
   找出产品验收与代码测试的差别，建立 clause → task → blocking assertion → evidence 的映射。
   矛盾逐条带版本记录；不知道就写待核实。无需为了分析调用真实模型。
2. **下指令**：给编码 Agent 一个有界任务契约，说明不允许修改的 authority、失败 baseline、
   权限 / 预算和停止条件。现有 plan / frozen snapshot 不能由编码 Agent 暗中弱化。
3. **执行**：编码 Agent 保留已有修改；按明确 scope 工作。测试失败、provider 不可用、
   mutation 被拒、repository drift、ownership 缺失、budget 到限时提交事实与剩余缺口。
   不为了绿灯 reset / 修改 DB / 清历史 / 删除 blocking assertion / 跳过独立 review。
4. **证据提交**：给出实际 diff 和文件、base/head、执行命令及 cwd、时间、exit code、
   原始证据定位和未执行项；涉及交付时包含 snapshot/runtimePlan/obligation/assertion/task/attempt/
   commit/artifact/evidenceId lineage。敏感数据留在安全位置，不复制凭据、客户个人信息或完整配置。
5. **Claude 审核**：实际读取 diff 和关键实现，核对测试与验收的关联；观察真实 UI / 持久化 / 平台
   结果只在有授权和环境时开展。不能仅复述编码 Agent 的“已完成”。业务反例、权限拒绝、
   版本漂移、外部 DEFERRED 和缺失证据独立检查。未读文件不得声称读过。
6. **纠偏或接受**：明确是实现缺陷、verifier 配置、环境、review 协议，还是尚不能归因。
   在已授权范围内给最小下一任务；无法安全推进时保留现场并报告停止，不擅自恢复客户任务。

## 停止条件

- 用户禁止的动作或预算将被触及；无法确认当前 scope / 人工约束。
- 目标 branch / baseline / repository identity 漂移，或出现未归属的脏文件。
- frozen / runtime / obligation 身份校验失败，canonical ownership 不唯一。
- required verifier / provider / evidence 缺失，独立 reviewer unavailable 或仍失败。
- mutation refusal、危险 / 越权路径、receipt 已消费但执行事实不明。
- 达到明确次数 / action / timeout / 费用上限；没有授权不能自动增加恢复预算。

受控修复不必每一步重复征求已经取得的权限；真正的范围 / 预算变化和用户决策才需澄清。
收到用户授权后，也必须通过相应实际 runtime gate，不能把授权写成验证 PASS。

## 报告格式：四种结果分开

| 层级 | 可以说什么 | 不能推出什么 |
| --- | --- | --- |
| 修改完成 | 哪些文件变化，满足哪些实现要求，剩余差异 | 不等于测试通过 |
| 测试通过 | 实际命令、版本、时间、范围与结果；历史 / 未执行分开 | 不等于真实流程或 UI 已运行 |
| 流程通过 | 实际经过哪些步骤、状态 / lifecycle / persistence 证据 | fixture / STARTED / LOCALLY_VERIFIED 不等于客户成功 |
| 产品验收通过 | 每项客户 blocking outcome 有有效观察、独立审核，外部 / 人工 residual 已满足 | 不能用 root tests、HTTP 200、model PASS 或文件存在代替 |

缺失项用 `NOT RUN`、`待核实`、`BLOCKED`、`DEFERRED` 等描述，并给下一步最小证据。
对纯文档任务，只做文档路径 / 一致性 / 内容与 diff 检查即可，不启动 Runtime，也不重跑全部测试。
