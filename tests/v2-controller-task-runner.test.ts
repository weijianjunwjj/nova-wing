import assert from 'node:assert/strict'
import test from 'node:test'
import {
  V2ControllerTaskRunner,
  createTaskStateV2,
  type AgentCapabilityProfile,
} from '../packages/development-guardian/work-session/index.js'

const codex: AgentCapabilityProfile = { id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
const deepseek: AgentCapabilityProfile = { id: 'deepseek', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
const task = { id: 'v2', goal: 'fix it', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['test'] }] }

test('V2 runner owns execute/verify/fix/complete loop and preserves agent continuity', async () => {
  const calls: Array<{ action: string; agent: string }> = []
  let verificationAttempt = 0
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'main', agents: [codex, deepseek],
    dispatcher: { inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }), dispatch: async ({ action, agent }) => {
      calls.push({ action, agent: agent.id })
      if (action === 'VERIFY') {
        verificationAttempt++
        return verificationAttempt === 1
          ? { status: 'FAILED', verificationResults: [{ name: 'test', status: 'failed' }] }
          : { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
      }
      if (action === 'EXECUTE') changedFiles = ['src/a.ts']
      return { status: 'SUCCESS', changedFiles: action === 'EXECUTE' ? changedFiles : [] }
    } },
  })
  const result = await runner.run(task)
  assert.equal(result.status, 'COMPLETED')
  assert.deepEqual(calls.map((call) => call.action), ['EXECUTE', 'VERIFY', 'EXECUTE', 'VERIFY'])
  assert.deepEqual(new Set(calls.map((call) => call.agent)), new Set(['codex']))
  assert.equal(result.taskStateV2?.status, 'COMPLETED')
})

test('quota fallback passes structured state to DeepSeek without changing task identity', async () => {
  const exhaustedCodex = { ...codex, quotaExhausted: true }
  let handoffSeen = false
  let changedFiles: readonly string[] = []
  const initial = { ...createTaskStateV2({ id: 's', branch: 'main' }, task), currentAgent: 'codex', providerHistory: ['codex'] }
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'main', agents: [exhaustedCodex, deepseek],
    dispatcher: { inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }), dispatch: async ({ action, task: state, handoff }) => {
      if (handoff !== undefined) {
        handoffSeen = handoff.task.identity.taskId === 'v2' && handoff.task === state && handoff.task.providerHistory.includes('codex')
      }
      if (action === 'EXECUTE') changedFiles = ['src/a.ts']
      return action === 'VERIFY'
        ? { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
        : { status: 'SUCCESS', changedFiles: ['src/a.ts'] }
    } },
  })
  const result = await runner.run(task, undefined, undefined, { taskStateV2: initial })
  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.taskStateV2?.identity.taskId, 'v2')
  assert.equal(result.taskStateV2?.currentAgent, 'deepseek')
  assert.equal(handoffSeen, true)
})

test('V2 restart reconciles repository reality before dispatching an action', async () => {
  const stale = {
    ...createTaskStateV2({ id: 's', branch: 'main' }, task),
    gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'old', changedFiles: [], worktreeFingerprint: 'old' },
  }
  let dispatched = false
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'main', agents: [codex],
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'new', changedFiles: [], worktreeFingerprint: 'new' }),
      dispatch: async () => { dispatched = true; return { status: 'SUCCESS' } },
    },
  })
  const result = await runner.run(task, undefined, undefined, { taskStateV2: stale })
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(dispatched, false)
})

const implementer: AgentCapabilityProfile = {
  id: 'codex', identity: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' },
  available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true },
}
const reviewer: AgentCapabilityProfile = {
  id: 'reviewer', identity: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'R2' },
  available: true, quotaExhausted: false, degraded: false, capabilities: { reasoning: true, verification: true, review: true },
}
const highRiskTask = { id: 'v2-review', goal: 'ship', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['test'] }] }

test('REVIEW rejects a dispatcher that self-asserts a different reviewer runtime identity', async () => {
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'main', agents: [implementer, reviewer], maxActions: 6,
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => {
        if (action === 'EXECUTE') { changedFiles = ['src/public-api.ts']; return { status: 'SUCCESS', changedFiles } }
        if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
        if (action === 'REVIEW') {
          return { status: 'SUCCESS', review: {
            passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
            reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'R3' },
            implementer: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' },
            reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: [], timestamp: 'now',
          } }
        }
        return { status: 'SUCCESS' }
      },
    },
  })
  const result = await runner.run(highRiskTask)
  assert.notEqual(result.status, 'COMPLETED')
  assert.equal(result.taskStateV2?.completion?.review, undefined)
})

test('REVIEW accepts a reviewer whose identity matches the selected agent', async () => {
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'main', agents: [implementer, reviewer],
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => {
        if (action === 'EXECUTE') { changedFiles = ['src/public-api.ts']; return { status: 'SUCCESS', changedFiles } }
        if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
        if (action === 'REVIEW') {
          return { status: 'SUCCESS', review: {
            passed: true, findings: [], severity: 'HIGH', blockingFindings: [],
            reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'R2' },
            implementer: { agent: 'codex', provider: 'codex', runtimeIdentity: 'R1' },
            reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: [], timestamp: 'now',
          } }
        }
        return { status: 'SUCCESS' }
      },
    },
  })
  const result = await runner.run(highRiskTask)
  assert.equal(result.status, 'COMPLETED')
  assert.equal(result.taskStateV2?.completion?.review?.reviewer.runtimeIdentity, 'R2')
})
