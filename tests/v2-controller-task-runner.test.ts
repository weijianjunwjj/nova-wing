import assert from 'node:assert/strict'
import test from 'node:test'
import {
  V2ControllerTaskRunner,
  createTaskStateV2,
  type AgentCapabilityProfile,
} from '../packages/development-guardian/work-session/index.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'

const codex: AgentCapabilityProfile = { id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
const deepseek: AgentCapabilityProfile = { id: 'deepseek', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, reasoning: true, verification: true } }
const task = { id: 'v2', goal: 'fix it', acceptanceCriteria: ['tests pass'], acceptanceEvidenceBindings: [{ criterion: 'tests pass', requiredEvidence: ['test'] }] }

test('missing criterion evidence binding fails closed before executor dispatch or action-budget burn', async () => {
  let dispatches = 0
  const eventLog = new TaskEventLogV2()
  const unbound = { id: 'unbound', goal: 'fix it', acceptanceCriteria: ['criterion without evidence'] }
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
    dispatch: async () => { dispatches++; return { status: 'SUCCESS' } },
  } })
  const result = await runner.run(unbound, undefined, undefined, { taskEventLog: eventLog })
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'CONFIGURATION_REQUIRED')
  assert.match(result.humanRequired?.reason ?? '', /Acceptance criterion criterion without evidence has no evidence binding/u)
  assert.equal(dispatches, 0)
  assert.equal(eventLog.count('CONTROLLER_DECIDED'), 1)
  assert.equal(eventLog.last('CONTROLLER_DECIDED')?.reasonCode, 'ACCEPTANCE_EVIDENCE_BINDING_MISSING')
})

test('same controller decision and unchanged facts stall early without exhausting the global action budget', async () => {
  let dispatches = 0
  const eventLog = new TaskEventLogV2()
  const stuckTask = { id: 'stuck', goal: 'fix it', acceptanceCriteria: ['proof'], acceptanceEvidenceBindings: [{ criterion: 'proof', requiredEvidence: ['required-proof'] }] }
  const initial = createTaskStateV2({ id: 's', branch: 'main' }, stuckTask)
  const taskStateV2 = {
    ...initial,
    status: 'ACTIVE' as const,
    gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' },
    verificationState: { results: [{ name: 'irrelevant-proof', status: 'passed' as const }] },
    completion: { ...initial.completion, evidence: [{ type: 'irrelevant-proof', status: 'PASSED' as const, source: 'deterministic', repositoryIdentity: 'repo', branch: 'main', headSha: 'h', workspaceIdentity: 'w', timestamp: 'before' }] },
  }
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], maxActions: 20, dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
    dispatch: async () => { dispatches++; return { status: 'SUCCESS', verificationResults: [{ name: 'irrelevant-proof', status: 'passed' }] } },
  } })
  const result = await runner.run(stuckTask, undefined, undefined, { taskStateV2, taskEventLog: eventLog })
  assert.equal(result.humanRequired?.category, 'CYCLIC_NO_PROGRESS')
  assert.equal(dispatches, 2)
  assert.equal(eventLog.count('CONTROLLER_DECIDED'), 2)
  assert.equal(eventLog.last('NO_PROGRESS_DETECTED')?.reasonCode, 'CYCLIC_NO_PROGRESS')
  assert.doesNotMatch(result.humanRequired?.reason ?? '', /quota|action budget exhausted/iu)
})

test('V2 runner owns execute/verify/fix/complete loop and preserves agent continuity', async () => {
  const calls: Array<{ action: string; agent: string }> = []
  let verificationAttempt = 0
  let executeAttempt = 0
  let changedFiles: readonly string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'main', agents: [codex, deepseek],
    dispatcher: { inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles, worktreeFingerprint: `w-${executeAttempt}` }), dispatch: async ({ action, agent }) => {
      calls.push({ action, agent: agent.id })
      if (action === 'VERIFY') {
        verificationAttempt++
        return verificationAttempt === 1
          ? { status: 'FAILED', verificationResults: [{ name: 'test', status: 'failed', classification: 'CODE_FAILURE' }] }
          : { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
      }
      if (action === 'EXECUTE') { executeAttempt++; changedFiles = ['src/a.ts'] }
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
            reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: ['src/public-api.ts'], timestamp: 'now',
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
            reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: ['src/public-api.ts'], timestamp: 'now',
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

test('V2 rejects dispatcher approval, then accepts a human approval only for the persisted request', async () => {
  let files: readonly string[] = []
  let fingerprint = 'w'
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [implementer], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: files, worktreeFingerprint: fingerprint }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') { files = ['auth/security.ts', 'database/schema.ts']; return { status: 'SUCCESS' } }
      return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }], approval: {
        approved: true, repositoryIdentity: 'repo', branch: 'main', reviewedCommit: 'h', workspaceIdentity: 'w', risk: 'CRITICAL', timestamp: 'now',
      } }
    },
  } })
  const request = await runner.run(task)
  assert.equal(request.status, 'HUMAN_REQUIRED')
  assert.equal(request.taskStateV2?.currentAction, 'REQUEST_APPROVAL')
  assert.equal(request.taskStateV2?.completion.approval, undefined)
  assert.equal((await runner.run(task, { approval: true }, undefined, { taskStateV2: request.taskStateV2! })).status, 'COMPLETED')
  fingerprint = 'changed'
  assert.equal((await runner.run(task, { approval: true }, undefined, { taskStateV2: request.taskStateV2! })).humanRequired?.category, 'REPO_DRIFT')
})

test('V2 persists action boundaries and rejects verification performed across repository drift', async () => {
  const saved: import('../packages/development-guardian/work-session/task-state-v2.js').TaskStateV2[] = []
  let fingerprint = 'before'
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: fingerprint }),
    dispatch: async ({ action }) => {
      if (action === 'VERIFY') { fingerprint = 'after'; return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] } }
      return { status: 'SUCCESS' }
    },
  } })
  const result = await runner.run(task, undefined, undefined, { persistTaskStateV2: async (state) => { saved.push(structuredClone(state)) } })
  assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
  assert.equal(saved[0]?.currentAction, 'EXECUTE')
  assert.ok(saved.some((state) => state.status === 'ACTIVE' && state.currentAction === 'EXECUTE'))
  assert.equal(result.taskStateV2?.completion.evidence.length, 0)
})

test('V2 enforces observed file permissions even when the dispatcher reports no changes', async () => {
  let files: readonly string[] = []
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: files, worktreeFingerprint: 'w' }),
    dispatch: async () => { files = ['.env']; return { status: 'SUCCESS', changedFiles: [], verificationResults: [{ name: 'test', status: 'passed' }] } },
  } })
  const result = await runner.run({ ...task, forbiddenPaths: ['.env'] })
  assert.notEqual(result.status, 'COMPLETED')
  assert.match(result.taskStateV2!.blockers.join(' '), /forbidden scope/)
})

test('V2 pause resumes without converting a transport pause into a semantic blocker', async () => {
  let dispatched = 0
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [codex], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
    dispatch: async () => { dispatched++; return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] } },
  } })
  const paused = await runner.run(task, undefined, undefined, { shouldPauseAutonomousWork: () => true })
  assert.equal(paused.status, 'PAUSED')
  assert.equal(dispatched, 0)
  assert.equal((await runner.run(task, undefined, undefined, { taskStateV2: paused.taskStateV2! })).status, 'COMPLETED')
})

test('dispatcher cannot mutate canonical policy or selected runtime identity through its input objects', async () => {
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [implementer], maxActions: 4, dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
    dispatch: async ({ task: input, agent }) => {
      input.completion.bindings = [{ criterion: 'tests pass', requiredEvidence: ['fake'] }]
      agent.identity!.runtimeIdentity = 'forged'
      return { status: 'SUCCESS', verificationResults: [{ name: 'fake', status: 'passed' }] }
    },
  } })
  const result = await runner.run(task)
  assert.notEqual(result.status, 'COMPLETED')
  assert.deepEqual(result.taskStateV2!.completion.bindings, task.acceptanceEvidenceBindings)
  assert.equal(result.taskStateV2!.implementer!.runtimeIdentity, 'R1')
})
