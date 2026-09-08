import assert from 'node:assert/strict'
import test from 'node:test'
import {
  V2ControllerTaskRunner,
  createTaskStateV2,
  type AgentCapabilityProfile,
} from '../packages/development-guardian/work-session/index.js'
import {
  ProviderHealthRegistry,
  TaskEventLogV2,
  type TaskEventV2,
} from '../packages/development-guardian/work-session/task-observability.js'

const codex: AgentCapabilityProfile = { id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
const deepseek: AgentCapabilityProfile = { id: 'deepseek', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
const task = { id: 'v2obs', goal: 'fix it', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['test'] }] }

function typesOf(events: readonly TaskEventV2[]): string[] {
  return events.map((event) => event.type)
}

function withTelemetry(context: { taskEventLog?: TaskEventLogV2; providerHealth?: ProviderHealthRegistry }): Record<string, unknown> {
  return {
    ...(context.taskEventLog === undefined ? {} : { taskEventLog: context.taskEventLog }),
    ...(context.providerHealth === undefined ? {} : { providerHealth: context.providerHealth }),
  }
}

test('V2 happy path records the full decision history without a provider switch', async () => {
  const eventLog = new TaskEventLogV2()
  const providerHealth = new ProviderHealthRegistry()
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex, deepseek], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') changedFiles = ['src/a.ts']
      return action === 'VERIFY'
        ? { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
        : { status: 'SUCCESS', changedFiles: [] }
    },
  } })
  const result = await runner.run(task, undefined, undefined, withTelemetry({ taskEventLog: eventLog, providerHealth }) as never)
  assert.equal(result.status, 'COMPLETED')
  const types = typesOf(eventLog.events)
  assert.deepEqual(types.filter((type) => ['TASK_CREATED', 'CONTROLLER_DECIDED', 'AGENT_DISPATCHED', 'AGENT_COMPLETED', 'VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'TASK_COMPLETED'].includes(type)),
    ['TASK_CREATED', 'CONTROLLER_DECIDED', 'AGENT_DISPATCHED', 'AGENT_COMPLETED', 'CONTROLLER_DECIDED', 'AGENT_DISPATCHED', 'VERIFICATION_STARTED', 'VERIFICATION_PASSED', 'AGENT_COMPLETED', 'CONTROLLER_DECIDED', 'TASK_COMPLETED'])
  assert.equal(types.includes('PROVIDER_SWITCHED'), false, 'healthy continuity must not fabricate a provider switch')
  assert.equal(types.includes('AGENT_FAILED'), false)
  // Continuity reason on the second dispatch (VERIFY) while Codex remains healthy.
  const verifyDispatch = eventLog.events.find((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'VERIFY')
  assert.equal(verifyDispatch?.explanation?.reasonCode, 'CONTINUE_CURRENT_AGENT')
  assert.equal(verifyDispatch?.reasonCode, 'CONTINUE_CURRENT_AGENT')
  const agentDispatches = eventLog.events.filter((event) => event.type === 'AGENT_DISPATCHED').map((event) => event.agent)
  assert.ok(agentDispatches.every((agent) => agent === 'codex'))
  assert.equal(providerHealth.get('codex')?.status, 'AVAILABLE')
})

test('Codex quota exhaustion selects DeepSeek and explains PROVIDER_QUOTA_EXHAUSTED deterministically', async () => {
  const eventLog = new TaskEventLogV2()
  const providerHealth = new ProviderHealthRegistry()
  const exhaustedCodex = { ...codex, quotaExhausted: true }
  const initial = { ...createTaskStateV2({ id: 's', branch: 'main' }, task), currentAgent: 'codex', providerHistory: ['codex'], status: 'PENDING' as const }
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [exhaustedCodex, deepseek], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') changedFiles = ['src/a.ts']
      return action === 'VERIFY'
        ? { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
        : { status: 'SUCCESS', changedFiles: [] }
    },
  } })
  const result = await runner.run(task, undefined, undefined, { taskStateV2: initial, ...withTelemetry({ taskEventLog: eventLog, providerHealth }) } as never)
  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.taskStateV2?.currentAgent, 'deepseek')
  assert.deepEqual(result.taskStateV2?.providerHistory, ['codex', 'deepseek'])

  const dispatch = eventLog.events.find((event) => event.type === 'AGENT_DISPATCHED' && event.agent === 'deepseek')
  assert.equal(dispatch?.explanation?.reasonCode, 'PROVIDER_QUOTA_EXHAUSTED')
  assert.ok((dispatch?.explanation?.factors ?? []).length > 0)
  assert.match(dispatch?.explanation?.message ?? '', /quota/u)

  const switchEvent = eventLog.events.find((event) => event.type === 'PROVIDER_SWITCHED')
  assert.ok(switchEvent, 'quota failover must record a provider switch')
  assert.equal(switchEvent?.previousProvider, 'codex')
  assert.equal(switchEvent?.provider, 'deepseek')
  assert.equal(switchEvent?.reasonCode, 'PROVIDER_QUOTA_EXHAUSTED')
})

test('HIGH risk selects an independent reviewer distinct from the implementer with a structured explanation', async () => {
  const eventLog = new TaskEventLogV2()
  const implementer: AgentCapabilityProfile = { id: 'codex', identity: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
  const reviewer: AgentCapabilityProfile = { id: 'reviewer', identity: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'R2' }, available: true, quotaExhausted: false, degraded: false, capabilities: { reasoning: true, verification: true, review: true } }
  const highRiskTask = { id: 'v2-review-obs', goal: 'ship', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['test'] }] }
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [implementer, reviewer], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') { changedFiles = ['src/public-api.ts']; return { status: 'SUCCESS', changedFiles } }
      if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
      if (action === 'REVIEW') {
        return { status: 'SUCCESS', review: {
          passed: true, findings: [], severity: 'HIGH' as const, blockingFindings: [],
          reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'R2' },
          implementer: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' },
          reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: ['src/public-api.ts'], timestamp: 'now',
        } }
      }
      return { status: 'SUCCESS' }
    },
  } })
  const result = await runner.run(highRiskTask, undefined, undefined, withTelemetry({ taskEventLog: eventLog }) as never)
  assert.equal(result.status, 'COMPLETED')
  assert.ok(eventLog.has('REVIEW_REQUIRED'))
  const reviewRequired = eventLog.last('REVIEW_REQUIRED')
  assert.equal(reviewRequired?.reasonCode, 'RISK_REQUIRES_REVIEW')
  const reviewDispatch = eventLog.events.find((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'REVIEW')
  assert.equal(reviewDispatch?.agent, 'reviewer')
  assert.equal(reviewDispatch?.reasonCode, 'INDEPENDENT_REVIEW_REQUIRED')
  assert.equal(reviewDispatch?.runtimeIdentity, 'R2')
  assert.equal(reviewDispatch?.provider, 'deepseek')
  assert.ok(eventLog.has('REVIEW_PASSED'))
  const reviewAgentIds = eventLog.events.filter((event) => event.action === 'REVIEW' && event.type === 'AGENT_DISPATCHED').map((event) => event.agent)
  assert.ok(reviewAgentIds.every((agent) => agent === 'reviewer'))
  assert.equal(result.taskStateV2?.completion.review?.reviewer.runtimeIdentity, 'R2')
  assert.equal(result.taskStateV2?.implementer?.runtimeIdentity, 'R1')
})

test('CRITICAL risk emits APPROVAL_REQUIRED then APPROVAL_GRANTED after a human resume', async () => {
  const eventLog = new TaskEventLogV2()
  let files: readonly string[] = []
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: files, worktreeFingerprint: 'w' }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') { files = ['auth/security.ts', 'database/schema.ts']; return { status: 'SUCCESS' } }
      return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
    },
  } })
  const request = await runner.run(task, undefined, undefined, withTelemetry({ taskEventLog: eventLog }) as never)
  assert.equal(request.status, 'HUMAN_REQUIRED')
  assert.equal(request.taskStateV2?.currentAction, 'REQUEST_APPROVAL')
  const approvalRequired = eventLog.last('APPROVAL_REQUIRED')
  assert.ok(approvalRequired, 'CRITICAL approval must be recorded as APPROVAL_REQUIRED')
  assert.equal(approvalRequired?.reasonCode, 'RISK_REQUIRES_APPROVAL')
  assert.equal(typesOf(eventLog.events).includes('TASK_COMPLETED'), false)

  const resumed = await runner.run(task, { approval: true }, undefined, { taskStateV2: request.taskStateV2!, ...withTelemetry({ taskEventLog: eventLog }) } as never)
  assert.equal(resumed.status, 'COMPLETED')
  assert.ok(eventLog.last('APPROVAL_GRANTED'), 'human approval must be recorded as APPROVAL_GRANTED')
  assert.equal(eventLog.last('TASK_COMPLETED')?.type, 'TASK_COMPLETED')
})

test('repository drift emits RECONCILIATION_REQUIRED before any dispatch', async () => {
  const eventLog = new TaskEventLogV2()
  const stale = { ...createTaskStateV2({ id: 's', branch: 'main' }, task), gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'old', changedFiles: [], worktreeFingerprint: 'old' } }
  let dispatched = false
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'new', changedFiles: [], worktreeFingerprint: 'new' }),
    dispatch: async () => { dispatched = true; return { status: 'SUCCESS' } },
  } })
  const result = await runner.run(task, undefined, undefined, { taskStateV2: stale, ...withTelemetry({ taskEventLog: eventLog }) } as never)
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(dispatched, false)
  const reconcile = eventLog.last('RECONCILIATION_REQUIRED')
  assert.ok(reconcile)
  assert.equal(reconcile?.headSha, 'new', 'event reflects the observed repository reality')
  assert.equal(reconcile?.metadata?.persistedHeadSha, 'old')
  const driftReasons = reconcile?.metadata?.['reasons'] as string[] | undefined
  assert.ok((driftReasons ?? []).includes('HEAD mismatch'))
  assert.equal(reconcile?.reasonCode, 'REPOSITORY_RECONCILIATION_REQUIRED')
})

test('Event Log history is not semantic authority: a stale COMPLETED event cannot complete a blocked Task', async () => {
  const staleEventLog = new TaskEventLogV2()
  staleEventLog.append({ taskId: 'T1', sessionId: 's', type: 'TASK_COMPLETED', timestamp: 'past' })
  const blocked = { ...createTaskStateV2({ id: 's', branch: 'main' }, task), status: 'SUSPENDED' as const, blockers: ['repository blocker'], currentAction: 'SUSPEND' as const }
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
    dispatch: async () => ({ status: 'SUCCESS' }),
  } })
  const result = await runner.run(task, undefined, undefined, { taskStateV2: blocked, ...withTelemetry({ taskEventLog: staleEventLog }) } as never)
  assert.notEqual(result.status, 'COMPLETED')
  assert.notEqual(result.taskStateV2?.status, 'COMPLETED')
  assert.equal(result.taskStateV2?.currentAction, 'SUSPEND')
  const completedCountAfter = staleEventLog.count('TASK_COMPLETED')
  assert.equal(completedCountAfter, 1, 'the stale event must not be replayed into a new completion')
  assert.ok(staleEventLog.has('CONTROLLER_DECIDED'), 'the fresh controller decision is still recorded as history')
})
