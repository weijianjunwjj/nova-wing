import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveRuntimeRepairReasonCode,
  isRuntimeRepairable,
  discoverIndependentReviewer,
  validateRuntimeRepairProposal,
  createRuntimeRepairEngine,
  parseLlmRuntimeRepairDraft,
  type RuntimeRepairContext,
} from '../packages/development-guardian/work-session/index.js'
import type { AgentCapabilityProfile } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'

const implementer: AgentCapabilityProfile = {
  id: 'codex', identity: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' },
  available: true, quotaExhausted: false, degraded: false,
  capabilities: { coding: true, reasoning: true, verification: true },
}
const reviewer: AgentCapabilityProfile = {
  id: 'deepseek-reviewer', identity: { agent: 'deepseek-reviewer', provider: 'deepseek', runtimeIdentity: 'R2' },
  available: true, quotaExhausted: false, degraded: false,
  capabilities: { reasoning: true, review: true },
}

function context(overrides: Partial<RuntimeRepairContext> = {}): RuntimeRepairContext {
  const task: TaskStateV2 = {
    version: 2, identity: { taskId: 'T1', sessionId: 's' }, goal: 'enable guard',
    constraints: [], acceptanceCriteria: ['guard enabled'],
    permissions: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    progress: { completedWork: [], pendingWork: [] }, decisions: [], assumptions: [], openQuestions: [], artifacts: [],
    gitState: { branch: 'main', changedFiles: ['src/auth/guard.ts'] }, verificationState: { results: [] },
    completion: { evidence: [], bindings: [] }, providerHistory: [], risk: 'NORMAL', status: 'SUSPENDED', blockers: [], updatedAt: new Date().toISOString(),
  }
  return {
    sessionId: 's', taskId: 'T1', task,
    reasonCode: 'NO_AVAILABLE_AGENT_FOR_REVIEW',
    humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: 'no available agent for REVIEW' },
    implementer: implementer.identity!,
    requiredReviewerConstraints: { requireIndependentReviewer: true, excludeRuntimeIdentities: ['R1'], excludeProviders: ['codex'] },
    agents: [implementer, reviewer],
    providerHealth: [],
    evidence: [], blockers: [], recentEvents: [],
    ...overrides,
  }
}

test('deriveRuntimeRepairReasonCode recognizes the runtime-repairable reasons', () => {
  assert.equal(deriveRuntimeRepairReasonCode({ category: 'ENVIRONMENT_REQUIRED', reason: 'no available agent for REVIEW' }), 'NO_AVAILABLE_AGENT_FOR_REVIEW')
  assert.equal(deriveRuntimeRepairReasonCode({ category: 'ENVIRONMENT_REQUIRED', reason: 'no available agent for VERIFY' }), 'DETERMINISTIC_VERIFIER_RUNTIME_UNAVAILABLE')
  assert.equal(deriveRuntimeRepairReasonCode({ category: 'DECISION_REQUIRED', reason: 'approval required' }), undefined)
  assert.equal(isRuntimeRepairable({ category: 'ENVIRONMENT_REQUIRED', reason: 'no available agent for REVIEW' }), true)
  assert.equal(isRuntimeRepairable({ category: 'DECISION_REQUIRED', reason: 'no available agent for REVIEW' }), false)
})

test('discoverIndependentReviewer excludes self-review, unavailable, and capability-insufficient agents', () => {
  const found = discoverIndependentReviewer(context())
  assert.equal(found.reviewer?.id, 'deepseek-reviewer')

  // Same runtime identity as the implementer must be excluded even if review-capable.
  const selfReview: AgentCapabilityProfile = { id: 'codex-as-reviewer', identity: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' }, available: true, quotaExhausted: false, degraded: false, capabilities: { review: true } }
  const excluded = discoverIndependentReviewer(context({ agents: [selfReview] }))
  assert.equal(excluded.reviewer, undefined)
  assert.ok(excluded.exclusions.some((reason) => /self-review/iu.test(reason)))

  // Offline / quota-exhausted reviewers are excluded.
  const offline = discoverIndependentReviewer(context({ agents: [implementer, { ...reviewer, available: false }] }))
  assert.equal(offline.reviewer, undefined)
})

test('validateRuntimeRepairProposal rejects self-review and non-review reviewer selection', () => {
  const selfReview = validateRuntimeRepairProposal(context(), {
    reasonCode: 'NO_AVAILABLE_AGENT_FOR_REVIEW', mechanism: 'SELECT_INDEPENDENT_REVIEWER',
    chosenReviewer: implementer.identity!, refreshedProviderHealth: [], repairs: ['self'],
  })
  assert.equal(selfReview.ok, false)

  const ok = validateRuntimeRepairProposal(context(), {
    reasonCode: 'NO_AVAILABLE_AGENT_FOR_REVIEW', mechanism: 'SELECT_INDEPENDENT_REVIEWER',
    chosenReviewer: reviewer.identity!, refreshedProviderHealth: [], repairs: ['selected DeepSeek'],
  })
  assert.equal(ok.ok, true)
})

test('runtime repair engine deterministically discovers an alternate reviewer via refresh', async () => {
  const engine = createRuntimeRepairEngine()
  const outcome = await engine.repair(context({ agents: [implementer, { ...reviewer, available: false }], refreshProviderHealth: async () => ({ providerHealth: [], agents: [implementer, reviewer] }) }))
  assert.equal(outcome.classification, 'REPAIRED')
  assert.equal(outcome.proposal?.chosenReviewer?.provider, 'deepseek')
  assert.equal(outcome.executorReran, false)
})

test('runtime repair engine refuses when no independent reviewer can be restored', async () => {
  const engine = createRuntimeRepairEngine()
  const outcome = await engine.repair(context({ agents: [implementer], refreshProviderHealth: async () => ({ providerHealth: [], agents: [implementer] }) }))
  assert.equal(outcome.classification, 'RUNTIME_REPAIR_REQUIRES_HUMAN')
  assert.equal(outcome.executorReran, false)
})

test('parseLlmRuntimeRepairDraft fails closed on malformed or elevated-trust output', () => {
  assert.equal(parseLlmRuntimeRepairDraft('').ok, false)
  assert.equal(parseLlmRuntimeRepairDraft('not json').ok, false)
  assert.equal(parseLlmRuntimeRepairDraft('{"mechanism":"BYPASS_REVIEW"}').ok, false)
  assert.equal(parseLlmRuntimeRepairDraft('{"mechanism":"SELECT_INDEPENDENT_REVIEWER","chosenReviewerId":"x","repairs":[],"risk":"LOW"}').ok, false)
  const ok = parseLlmRuntimeRepairDraft('{"mechanism":"SELECT_INDEPENDENT_REVIEWER","chosenReviewerId":"deepseek-reviewer","repairs":["selected"]}')
  assert.equal(ok.ok, true)
})
