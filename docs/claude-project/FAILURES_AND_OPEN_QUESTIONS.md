# 失败、未知与待决事项

核查日：2026-10-02；基线 `ad26456`。这是证据索引，详细 ID / 时间 / 数据路径见
[CURRENT_STATE](CURRENT_STATE.md)。不预先把失败责任归给模型、Codex 或 NovaWing。

## 已知失败与原因分级

| 问题 / 适用阶段 | 已确认的观察或原因 | 候选原因 / 未知 | 下一步证据 |
| --- | --- | --- | --- |
| 9/26 规划 gate 绿灯、产品 FAIL | [Product Acceptance Audit](../plan/NovaWing-v0.5-Requirement-001-Product-Acceptance.md) 记录 100% ID 覆盖但 6 个 criterion 弱证明 | 报告定位业务语义 / acceptance 缺口；不能推为所有模型的总体能力结论 | 用来源 → blocking assertion → 场景 / 反例逐项复审；不删除失败 baseline |
| 规划多次 repair / timeout | [Planning Quality Hardening](../plan/NovaWing-v0.5-Planning-Quality-Hardening.md) 保留 provisional green 被人工否定及 timeout；[Real Customer Decisions](../plan/NovaWing-v0.5-Requirement-001-Real-Customer-Decisions.md) 记录修复超时后重跑 | 每轮输入 / prompt / 服务版本不同，不能把最后五次 PASS 作为所有失败已消失 | 按 manifest / prompt / commit 区分轮次；真实再实验另需预算 |
| Phase 6 exact verifier 启动死锁 | phase6.0 [audit](../audit/NovaWing-v0.5-Phase-6-Verification-Blueprint-Audit.md) 确认 78 binding 未解析，已有 endpoint / tests 不够精确 | phase6.1 已改变 admission；不能继续用 78 作为今天必然阻塞数 | 当前 obligation、canonical owner、admission model / policy 核验；READY 与 completion 分开 |
| Requirement 001 首次启动失败 | 本地 failure archive 保存 TIMEOUT / INTERRUPTED_STARTING | 中断发生在哪个进程边界、首次是否有未登记执行，本轮未重建 | 归档 event 与 session lifecycle 对照；不把后续 STARTED 覆盖首次失败 |
| Requirement 001 generation 3 暂停 | 本轮 DB：T1 SUSPENDED / RECONCILE、reason `repository changed during action`；HEAD 从 B 到 C，未保存 owned checkpoint | [checkpoint 文档](../runtime/owned-implementation-checkpoint.md) 支持历史 handoff 缺失；离线内容 fingerprint MATCH 不是原始 status/index 或 ownership 证明 | 保留 C 和 receipt/event；不 reset C、不从模型 JSON 认领、不编辑 DB。历史恢复路径待核实 |
| Requirement 002 contributor verifier 暂停 | 本轮 DB：T1 SUSPENDED，reason `No safe task-local contributor verifier is available.`；完成数 0 | 最新 package runner / scoped test 修复是否覆盖该实际任务，provider 当时具体错误与部署版本，仍未知 | 只读 task contract、event、target test layout；先证明 scope/coverage，再决定是否补 verifier 和恢复 |
| Requirement 002 保存 BLOCKED plan，但 session STARTED | 两条记录的时间与阶段不同，均实际读到 | 是否后来 readiness 重算、使用哪一 deployed commit，本轮未重建 | 对照 delivery events、start request / deployed artifact；不声称绕过，也不声称现在 READY |
| Windows ENOTEMPTY | [D01 investigation](../dogfood/D01-enotempty-investigation.md) 说明 10 次未复现 | Windows filesystem / junction 是 best-supported hypothesis，非已证明根因 | 当前 Windows 环境若复现，捕获 teardown / junction 实证；不能从候选原因升级确定性原因 |
| macOS 签名 / native notification / 更新安装 | [v0.4 closure](../audit/NovaWing-v0.4-Closure.md) 为 NEEDS_SIGNED_VALIDATION / DEFERRED / NOT_APPLICABLE_YET | 今天证书、签名包和安装状态未核实 | 明确产品需求后做真实签名环境验收；本轮不安装、不签名 |

## 证据缺口与规则冲突

- **永久记忆不可访问**：AGENTS.md 要求的 Windows 路径在本机缺失，未读其协议，未建立等价路径。
  不能声称长期跨项目决策已核实；本轮未更新任何永久记忆。
- **总产品规格未统一**：冻结 v0.1 PRD / 设计与当前 Harness + Desktop 的整体范围不同。
  本轮只记录适用版本，不改 PRD，不制造“新版 PRD 已获批准”的结论。
- **历史阶段状态不同**：早期报告“未冻结 / 未 Start”与后来持久化 frozen / STARTED 可共存；
  但旧 workspace 文档“REVIEW 暂停”不能替代本轮 DB 的 RECONCILE。必须带日期和会话 ID。
- **最新代码与保存 incident 不同版本**：9/29–10/01 的修复存在；9/28–9/30 的 DB 暂停记录仍存在。
  修复实现、修复测试、修复在真实客户任务奏效分别待证明。
- **测试运行缺口**：当前 HEAD 本轮 NOT RUN。历史 check 报告已引用版本 / 时间；没有核验远程 CI。
- **数据覆盖缺口**：只核查默认本机根目录中的两份 delivery DB，没有核查所有 overrides、其他主机、
  运行中 UI / Runtime、全部 planning store 或 customer acceptance 产物。
- **Laya / Jev 等历史线索**：历史总结提示曾有相关实验，但本轮当前仓库未定位到相应 benchmark
  报告 / 实现路径；未确认其版本、GO/STOP 或可接入状态。不要继承历史总结中的实验结论。
- **成本 / 交付 KPI 缺口**：scripted benchmark 明确无 live LLM 成本；真实任务完成率、费用硬限、
  失败轮次和产品验收数据不足。本轮没有证明“已实现低成本真实交付”。

## 需要用户决定的事项（不是本轮阻塞审批）

1. 下一轮优先范围：正常新路径验收、Requirement 001 历史事件处置，或 Requirement 002 verifier 适配。
   [checkpoint 文档](../runtime/owned-implementation-checkpoint.md) 倾向正常路径验证后显式 successor；
   这不自动授权创建 successor，也没有计划 historical checkpoint-claim API。
2. 若涉及跨项目架构，需要永久记忆的可访问位置与适用协议；不要求复制整个 Vault。
3. 真实实验的 provider / model、次数、action / time / money 上限、可修改的客户范围与停止条件。
   默认配置或遗留 receipt 不提供这些权限。
4. 是否有 macOS 签名、通知、更新安装的实际产品需求，以及谁核验外部 browser / platform / human
   证据。没有必要时保持历史 DEFERRED，不能冒充通过。
5. 是否另立经批准的 Harness 总规格；本交接对当前定位有说明，但不替用户改变冻结产品裁决。

这些决定可由下一轮用户任务解决；本轮文档交接无需为其启动实验或等待审批。
