import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TaskController,
  createTaskStateV2,
  loadTaskStateV2,
  reconcileTaskState,
  type TaskStateV2,
} from '../packages/development-guardian/work-session/index.js'

const session = { id: 'session-v2', branch: 'main' }
const task = {
  id: 'task-v2', goal: 'ship V2', acceptanceCriteria: ['tests pass'],
  allowedPaths: ['src/**'], forbiddenPaths: ['.env'],
}

function state(overrides: Partial<TaskStateV2> = {}): TaskStateV2 {
  return { ...createTaskStateV2(session, task), ...overrides }
}

test('Task State V2 preserves task constraints, permissions, and can be loaded after persistence', () => {
  const value = state({ providerHistory: ['codex'] })
  const restored = loadTaskStateV2(JSON.parse(JSON.stringify(value)))
  assert.deepEqual(restored.acceptanceCriteria, ['tests pass'])
  assert.deepEqual(restored.permissions, { allowedPaths: ['src/**'], forbiddenPaths: ['.env'] })
  assert.deepEqual(restored.providerHistory, ['codex'])
})

test('controller decides actions from state and never treats a report-like state as completion', () => {
  const controller = new TaskController()
  assert.equal(controller.decide(state({ acceptanceCriteria: [] })).action, 'ANALYZE')
  assert.equal(controller.decide(state()).action, 'EXECUTE')
  assert.equal(controller.decide(state({ verificationState: { results: [{ name: 'test', status: 'failed' }] } })).action, 'EXECUTE')
  assert.equal(controller.decide(state({ status: 'SUSPENDED' })).action, 'REQUEST_APPROVAL')
  assert.equal(controller.decide(state({ status: 'ACTIVE', verificationState: { results: [{ name: 'test', status: 'passed' }] } })).action, 'VERIFY')
  assert.equal(controller.decide(state({ blockers: ['needs approval'], verificationState: { results: [{ name: 'test', status: 'passed' }] } })).action, 'SUSPEND')
})

test('reconciliation suspends on repository drift and invalidates old verification evidence', () => {
  const prior = state({
    gitState: { branch: 'main', headSha: 'old', changedFiles: ['src/a.ts'], worktreeFingerprint: 'old-fingerprint' },
    verificationState: { results: [{ name: 'test', status: 'passed' }], evidenceHeadSha: 'old', evidenceWorktreeFingerprint: 'old-fingerprint' },
  })
  const result = reconcileTaskState(prior, {
    branch: 'other', headSha: 'new', changedFiles: ['src/b.ts'], worktreeFingerprint: 'new-fingerprint',
  })
  assert.equal(result.reconciled, false)
  assert.equal(result.state.status, 'SUSPENDED')
  assert.equal(new TaskController().decide(result.state, { reconciliationRequired: true }).action, 'RECONCILE')
  assert.match(result.reasons.join(' '), /branch mismatch/)
  assert.match(result.reasons.join(' '), /older commit/)
})
