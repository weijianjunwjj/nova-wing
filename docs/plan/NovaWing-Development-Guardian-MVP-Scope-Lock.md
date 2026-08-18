# NovaWing Development Guardian MVP Scope Lock

> 状态：Active
> 日期：2026-08-18
> 目标：验证 NovaWing 能否在不调用 GPT API 的前提下，自动协调 ChatGPT Web 与 Claude Code，消除人工复制粘贴。

## 1. Goal

MVP 只解决一个真实问题：

> 用户不再充当 ChatGPT Web 与 Claude Code 之间的人工消息搬运工。

成功形态：用户给出一次开发目标后，可以离开电脑；NovaWing 自动推进 GPT Review ↔ Claude Code Execution 循环，仅在真正需要人工决策时暂停并通知。

## 2. Hard Constraints

- Brain 必须是 ChatGPT Web，禁止替换为 GPT API。
- Executor 必须是 Claude Code。
- Windows Native + Git Bash-only 保持不变。
- cc-auto 保持冻结，不复活、不依赖。
- 第三方 ChatGPT Web bridge 只能作为可替换 Adapter，实现不能反向定义 NovaWing 核心数据结构。
- 不修改 NovaWing 已冻结 v0.1 Mainline / Memory / Proposal 治理语义。

## 3. MVP Flow

```text
User Goal
  ↓
ChatGPT Web (plan / review)
  ↓
Delegation Packet
  ↓
Claude Code (execute)
  ↓
Execution Report + deterministic evidence
  ↓
ChatGPT Web (review)
  ├─ REVISE → Claude Code
  ├─ DONE → Completed
  └─ BLOCKED → Human Required
```

## 4. Minimal Contracts

### Delegation Packet

至少表达：

- goal
- instructions
- constraints
- verification
- do_not_do
- verdict: `proceed | revise | blocked | done`

### Execution Report

至少表达：

- summary
- changed_files
- commands_run
- verification_results
- blockers
- raw_output_ref（可选）

## 5. Minimal Task States

只实现：

- READY
- EXECUTING
- REVIEWING
- COMPLETED
- HUMAN_REQUIRED
- FAILED

允许内部出现 VERIFYING，但不为状态完整性提前建设通用 Runtime。

## 6. Verification Rule

Claude Code 声称“完成”不等于完成。

MVP 优先采信确定性证据：

- test
- typecheck
- build
- lint（按目标仓库实际可用命令）
- scope / changed-files check

语义 Review 由 ChatGPT Web 补充，但不能覆盖失败的 deterministic verification。

## 7. Human-on-Exception

满足以下任一条件必须暂停，不允许自主赌：

- 需求 / 架构存在真实歧义；
- 需要突破明确禁止范围；
- 高风险 mutation；
- 连续执行无有效进展；
- Bridge 状态未知或页面协议失效；
- 达到最大循环次数；
- deterministic verification 持续失败且无法形成明确修复方案。

Human Required 摘要必须包含：

- 为什么停；
- 已经尝试什么；
- 当前证据；
- 可选方案；
- NovaWing 推荐；
- 不处理的影响。

## 8. MVP DoD

以下全部满足才算 MVP Done：

1. 至少一个真实开发任务中，用户 0 次人工复制 GPT ↔ Claude Code 内容。
2. Brain 始终是 ChatGPT Web。
3. 至少成功经历一次 `Claude Code → GPT Review → REVISE → Claude Code` 自动循环。
4. deterministic verification 失败时不能宣布完成。
5. BLOCKED / 高风险场景能安全进入 HUMAN_REQUIRED。
6. 循环有硬上限，不允许无限自动运行。

## 9. Explicit Non-Goals

本次不做：

- Spec-Kit 工作流；
- 可视化 Workflow Editor；
- NovaWing Desktop；
- 通用 Agent IDE；
- Multi-Agent Team；
- 智能模型路由；
- GPT API；
- 复杂 Memory / Vector Search；
- 自动 Skill 学习；
- 独立 Shared AI Runtime 工程；
- 云 Workspace；
- Plugin Marketplace；
- AI 自动修改 NovaWing Mainline。

## 10. Third-party Strategy

首选顺序：

1. `10x-chat`：优先验证 long-lived ChatGPT Web delegate。
2. `ask-bridge`：若首选 bridge 在 2 小时 PoC 窗口内无法稳定运行，立即切换。
3. 自研 Playwright bridge：只有两者均无法满足最小闭环时才考虑。

禁止为了适配 bridge 大规模重构 NovaWing。

## 11. Change Control

任何不在本 Scope Lock 中的功能，不允许“顺手实现”。

如果实现中发现必须扩范围：

1. 暂停；
2. 说明新增需求；
3. 说明为什么 MVP 无法绕开；
4. 评估复杂度与风险；
5. 用户明确同意后再修改 Scope Lock。

## 12. Development Style

本 MVP 不采用 Spec-Kit。

采用：

```text
Scope Lock
→ 最小 Adapter
→ 单链路 PoC
→ 实际任务验证
→ 小步修复
→ MVP DoD
```

原则：证明闭环优先于架构完整；能小实现，不建平台。
