import type { PlanDraft } from '../../packages/development-guardian/planning/model.js'

export const governanceRequirement = '顾客创建订单后必须能重新读取同一订单的持久化业务状态，并获得可复核的结果。'
export function governanceDraft(): PlanDraft {
  return {
    clauses: [{ id: 'R1', statement: governanceRequirement, type: 'business-rule', priority: 'must',
      source: { excerpt: governanceRequirement, location: 'isolated-fixture:1', origin: 'customer_requirement' },
      ambiguity: { ambiguous: false, note: '' } }],
    analysis: { productGoal: '交付订单流程', summary: '订单流程可观察。',
      userRoles: [{ id: 'U1', name: '顾客', goals: ['查看订单'] }],
      businessFlows: [{ id: 'F1', title: '订单', steps: ['创建订单', '检查结果'], requirementIds: ['R1'] }] },
    productScope: { inScope: ['订单'], outOfScope: ['会员'] },
    architecture: { summary: '持久化订单状态。', components: ['订单'], decisions: [] },
    tasks: [{ id: 'T1', title: '订单持久化', objective: '实现并验证订单', requirementIds: ['R1'],
      outputs: ['订单结果'], dependencyIds: [], acceptanceCriterionIds: ['C1'], complexity: 'small' }],
    acceptancePlan: { strategy: '逐条验证订单行为。', criteria: [{ id: 'C1', requirementIds: ['R1'],
      description: '创建订单并保存。', level: 'integration', expectedEvidence: '同一订单操作和重读记录。', blocking: true,
      assertions: [{ id: 'A1', requirementId: 'R1', observableBehavior: '创建订单并保存。',
        expectedOutcome: '订单状态持久化且同一订单可重新读取。', expectedEvidence: '同一订单操作和重读记录。', blocking: true }] }] },
    risks: [], assumptions: [], customerQuestions: [],
  }
}
