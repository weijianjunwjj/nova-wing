# NovaWing v0.5 产品路线收尾复盘

## 原始目标

Customer Mode 试图把客户的自然语言需求转成可审查的开发计划、冻结的验收义务和运行任务。动机来自 Requirement 001：测试及结构校验通过，仍可能遗漏真实客户行为。[Phase 1 产品验收审计](../plan/NovaWing-v0.5-Requirement-001-Product-Acceptance.md)记录了确定性覆盖 PASS、产品语义验收 FAIL 的具体差异。

## 已完成的工程能力

- Customer Planning 建立需求覆盖、确定性校验与独立语义审核；[质量加固记录](../plan/NovaWing-v0.5-Planning-Quality-Hardening.md)保存了后续规划验证结果。
- Plan Freeze 将客户答案、计划版本、内容哈希和不可变快照绑定，并在读取时校验完整性；其阶段性验收见[冻结状态报告](../plan/NovaWing-v0.5-Plan-Freeze-Status.md)。
- Runtime Plan Compiler 将冻结计划映射到任务与验收绑定；Verification Capabilities、分阶段 Admission 和 Verification Blueprint 对验证来源及启动条件实施约束。对应证据见[编译状态](../plan/NovaWing-v0.5-Runtime-Plan-Compiler-Status.md)、[能力状态](../plan/NovaWing-v0.5-Verification-Capabilities-Status.md)及[蓝图审计](NovaWing-v0.5-Phase-6-Verification-Blueprint-Audit.md)。

这些是有价值的工程成果，但各阶段的内部 PASS 只证明相应合约或隔离夹具通过，不等于客户任务已交付。[Requirement 001 编译审计](../plan/NovaWing-v0.5-Requirement-001-Compile-Audit.md)和后续蓝图审计均记录过 Admission 阻断；蓝图审计没有启动客户 Work Session。现有证据也没有充分证明 v0.5 相比原始 Work Session 路径提高了同类真实任务的端到端可接受交付效率；这里不作 v0.4 与 v0.5 的严格优劣判断。

## 决策与教训

产品阶段的退出标准应优先看真实任务能否得到客户可接受、可复核的结果，并记录耗时与人工介入；内部状态一致、结构完整和测试通过只能作为必要的工程证据。NovaWing 停止以 Customer Mode 为中心的主动产品研发。Launchpad 恢复 Work Session 创建为主要入口；Customer Mode 路由、API、Planning 与 Delivery 代码保留作兼容和历史研究。原有执行链路继续保留，本次收尾不启动新一轮产品扩张，也不把本地 Mock 回归视为真实模型端到端验收。
