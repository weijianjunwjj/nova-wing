# ADR-0001：提案草稿状态

- 状态：已接受
- 日期：2026-08-05
- 适用版本：NovaWing v0.1 独立内核

## 背景

冻结 PRD 的正式审批状态为 `pending → approved | rejected`。独立内核实现还需要支持用户在正式提交审批前分步填写和修正手动提案，因此增加了 `draft`。本 ADR 只解释该差异，不修改冻结 PRD，也不增加其他状态。

## 决策

- `draft` 是尚未正式提交的用户编辑缓冲；它没有 `baseCoreRevision`，不能批准或拒绝，也绝不进入当前主线 Context。
- `pending` 是已提交给用户审批的正式提案；提交时捕获 `baseCoreRevision` 和 `baseTargetEntryId`，之后只能编辑候选 statement，原始建议和证据保持可追溯。
- 手动/用户工作流可以通过 `createProposal` 创建 draft，通过 `updateDraft` 编辑，并通过 `submitProposal` 提交。
- 宿主适配器不得把 draft 当作宿主队列。宿主提交必须调用 `createPendingProposal`，在一个 NovaWing 事务中直接创建 pending；`FakeOfferFlowHost` 是该合约的测试样例。
- `draft` 属于 Core 公共类型和 Facade API，但只服务手动编辑工作流。未来 UI/API 必须明确区分“保存草稿”和“提交审批”，不得把保存草稿显示成已提交。
- Snapshot 权威数据包含 draft，因为它是用户尚未完成的本地输入；恢复后仍保持 draft，不自动提交。

## 兼容要求

- 调用方必须对 `ProposalStatus` 做穷尽处理，并允许列表中出现 draft。
- 宿主接入测试必须断言宿主提交结果直接为 pending，且不会遗留中间 draft。
- `approved` 和 `rejected` 仍是唯一终态；本 ADR 不引入暂缓、补证或自动审批状态。

## 未来移除策略

若未来 UI 改为完全在客户端保存未提交表单，应先停止创建新 draft，并将现有 draft 以只读方式展示给用户。用户可选择提交为 pending，或明确丢弃/迁移到客户端草稿。只有数据库中不再存在 draft 后，才能通过新 migration 收紧状态 CHECK；不得把现有 draft 自动晋升为 pending，也不得在无用户选择时静默删除。

