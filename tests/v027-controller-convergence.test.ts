import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVerificationResult } from '../packages/development-guardian/verification-evidence.js'
import {
  V2ControllerTaskRunner,
  createTaskStateV2,
  detectCyclicNoProgress,
  type AgentCapabilityProfile,
} from '../packages/development-guardian/work-session/index.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'

const agent: AgentCapabilityProfile = { id: 'codex', identity: { agent: 'codex', provider: 'codex', runtimeIdentity: 'codex-test' }, available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }
const task = { id: 'REAL-002-regression', goal: 'ticket filters', acceptanceCriteria: ['targeted tests pass'], acceptanceEvidenceBindings: [{ criterion: 'targeted tests pass', requiredEvidence: ['npm test'] }] }

function failed(output: string, metadata?: Parameters<typeof buildVerificationResult>[0]['metadata']) {
  return buildVerificationResult({ command: 'npm test', result: { exitCode: 1, signal: null, stdout: '', stderr: output }, durationMs: 10, ...(metadata === undefined ? {} : { metadata }) })
}

test('verification classifier is structured, fail-safe, and does not equate exit code with code failure', () => {
  assert.equal(failed('connect ECONNREFUSED 127.0.0.1:5432 PostgreSQL database socket').classification, 'ENVIRONMENT_FAILURE')
  assert.equal(failed('npm ERR! Missing script: "test:ticket"').classification, 'VERIFIER_CONFIGURATION_FAILURE')
  assert.equal(failed('1 failed', { relationToTask: 'UNRELATED', baselineStatus: 'FAILING', failingTestIdentity: 'Overview existing test' }).classification, 'UNRELATED_TEST_FAILURE')
  assert.equal(failed('process exited with code 1').classification, 'UNKNOWN')
  assert.equal(failed('AssertionError: expected filtered tickets').classification, 'CODE_FAILURE')
})

test('REAL-002 environment verifier regression dispatches implementation Executor once, then routes to environment recovery', async () => {
  let fingerprint = 'w0'
  let executeCount = 0
  let verifyCount = 0
  const log = new TaskEventLogV2()
  const runner = new V2ControllerTaskRunner({ sessionId: 's-real-002', branch: 'main', agents: [agent], dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: fingerprint === 'w0' ? [] : ['apps/web/tickets.ts'], worktreeFingerprint: fingerprint }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') { executeCount++; fingerprint = 'w1'; return { status: 'SUCCESS', changedFiles: ['apps/web/tickets.ts'] } }
      verifyCount++
      return { status: 'FAILED', verificationResults: [failed('psycopg.OperationalError: connection to server at 127.0.0.1 port 5432 failed: Connection refused')] }
    },
  } })
  const result = await runner.run(task, undefined, undefined, { taskEventLog: log })
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'ENVIRONMENT_REQUIRED')
  assert.equal(executeCount, 1)
  assert.equal(verifyCount, 1)
  assert.equal(log.last('VERIFICATION_CLASSIFIED')?.metadata?.classification, 'ENVIRONMENT_FAILURE')
  assert.equal(log.events.filter((event) => event.type === 'AGENT_DISPATCHED').length, 2)
})

test('verifier configuration and audited unrelated failures never dispatch implementation work', async () => {
  for (const classification of ['VERIFIER_CONFIGURATION_FAILURE', 'UNRELATED_TEST_FAILURE'] as const) {
    let dispatches = 0
    const initial = createTaskStateV2({ id: `s-${classification}`, branch: 'main' }, task)
    const state = { ...initial, status: 'ACTIVE' as const, gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: ['apps/web/tickets.ts'], worktreeFingerprint: 'w' }, verificationState: { results: [{ name: 'npm test', status: 'failed' as const, classification }] } }
    const runner = new V2ControllerTaskRunner({ sessionId: `s-${classification}`, branch: 'main', agents: [agent], dispatcher: {
      inspectRepository: async () => state.gitState,
      dispatch: async () => { dispatches++; return { status: 'SUCCESS' } },
    } })
    const result = await runner.run(task, undefined, undefined, { taskStateV2: state })
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(dispatches, 0)
    assert.equal(result.humanRequired?.category, classification === 'VERIFIER_CONFIGURATION_FAILURE' ? 'CONFIGURATION_REQUIRED' : 'DECISION_REQUIRED')
  }
})

test('no-change EXECUTE preserves the original code failure and stops as NO_IMPLEMENTATION_PROGRESS', async () => {
  const initial = createTaskStateV2({ id: 's-no-change', branch: 'main' }, task)
  const failure = { name: 'npm test', status: 'failed' as const, classification: 'CODE_FAILURE' as const, details: 'targeted assertion failed' }
  const state = { ...initial, status: 'ACTIVE' as const, gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: ['apps/web/tickets.ts'], worktreeFingerprint: 'w' }, verificationState: { results: [failure] } }
  const log = new TaskEventLogV2()
  let dispatches = 0
  const runner = new V2ControllerTaskRunner({ sessionId: 's-no-change', branch: 'main', agents: [agent], dispatcher: {
    inspectRepository: async () => state.gitState,
    dispatch: async () => { dispatches++; return { status: 'SUCCESS', changedFiles: [] } },
  } })
  const result = await runner.run(task, undefined, undefined, { taskStateV2: state, taskEventLog: log })
  assert.equal(result.humanRequired?.category, 'STALLED_NO_PROGRESS')
  assert.equal(dispatches, 1)
  assert.deepEqual(result.taskStateV2?.verificationState.results, [failure])
  assert.equal(log.last('NO_IMPLEMENTATION_PROGRESS')?.metadata?.repoChanged, false)
})

test('cycle detector recognizes A-B and A-B-C cycles only under unchanged repository/evidence reality', () => {
  const entry = (decisionKey: string, realityKey = 'same') => ({ decisionKey, realityKey })
  assert.deepEqual(detectCyclicNoProgress(['A', 'B', 'A', 'B'].map((key) => entry(key))), { pattern: ['A', 'B'], cycles: 2 })
  assert.deepEqual(detectCyclicNoProgress(['A', 'B', 'C', 'A', 'B', 'C'].map((key) => entry(key))), { pattern: ['A', 'B', 'C'], cycles: 2 })
  assert.equal(detectCyclicNoProgress([entry('A', 'w1'), entry('B', 'w1'), entry('A', 'w2'), entry('B', 'w2')]), undefined)
})

test('action budget grants one recovery budget of four and refuses a second grant', async () => {
  let fingerprint = 'w0'
  let phase: 'fail' | 'recover' = 'fail'
  const log = new TaskEventLogV2()
  const runner = new V2ControllerTaskRunner({ sessionId: 's-budget', branch: 'main', agents: [agent], maxActions: 2, dispatcher: {
    inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: fingerprint === 'w0' ? [] : ['src/a.ts'], worktreeFingerprint: fingerprint }),
    dispatch: async ({ action }) => {
      if (action === 'EXECUTE') { fingerprint = phase === 'fail' ? 'w1' : 'w2'; return { status: 'SUCCESS' } }
      return phase === 'fail'
        ? { status: 'FAILED', verificationResults: [{ name: 'npm test', status: 'failed', classification: 'CODE_FAILURE' }] }
        : { status: 'SUCCESS', verificationResults: [{ name: 'npm test', status: 'passed' }] }
    },
  } })
  const exhausted = await runner.run(task, undefined, undefined, { taskEventLog: log })
  assert.equal(exhausted.humanRequired?.category, 'ACTION_BUDGET_EXHAUSTED')
  assert.equal(exhausted.taskStateV2?.actionBudget?.originalExhausted, true)
  phase = 'recover'
  const recovered = await runner.run(task, { decision: 'retry after inspecting the failure' }, undefined, { taskStateV2: exhausted.taskStateV2!, taskEventLog: log })
  assert.equal(recovered.status, 'COMPLETED')
  assert.equal(recovered.taskStateV2?.actionBudget?.recoveryGranted, true)
  assert.equal(log.last('RECOVERY_BUDGET_GRANTED')?.metadata?.recoveryBudget, 4)

  const terminalState = { ...exhausted.taskStateV2!, actionBudget: { ...exhausted.taskStateV2!.actionBudget!, recoveryGranted: true, recoveryConsumed: 4, recoveryExhausted: true } }
  const rejected = await runner.run(task, { decision: 'grant again' }, undefined, { taskStateV2: terminalState, taskEventLog: log })
  assert.equal(rejected.status, 'HUMAN_REQUIRED')
  assert.equal(rejected.taskStateV2?.actionBudget?.recoveryExhausted, true)
  assert.equal(log.events.filter((event) => event.type === 'RECOVERY_BUDGET_GRANTED').length, 1)
})
