import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskController, assessRisk, createTaskStateV2, completionSatisfied, type EvidenceV2 } from '../packages/development-guardian/work-session/index.js'

function task(files: string[] = []) { return { ...createTaskStateV2({ id: 's', branch: 'main' }, { id: 't', goal: 'x', acceptanceCriteria: ['done'] }), status: 'ACTIVE' as const, gitState: { changedFiles: files, worktreeFingerprint: 'w' }, verificationState: { results: [{ name: 'test', status: 'passed' as const }] } } }
const evidence: EvidenceV2[] = [{ type: 'test', status: 'PASSED', source: 'deterministic', workspaceIdentity: 'w', timestamp: 'now' }]
const bindings = [{ criterion: 'done', requiredEvidence: ['test'] }]

test('LOW risk completes without a reviewer when mapped evidence passes', () => {
  const state = task()
  assert.equal(assessRisk(state).level, 'LOW')
  assert.equal(new TaskController().decideWithEvidence(state, { evidence, bindings }).action, 'COMPLETE')
})
test('HIGH risk requires structured independent review and CRITICAL requires approval', () => {
  const high = task(['src/public-api.ts'])
  const controller = new TaskController()
  assert.equal(controller.decideWithEvidence(high, { evidence, bindings }).action, 'REVIEW')
  assert.equal(controller.decideWithEvidence(high, { evidence, bindings, review: { passed: true, findings: [], severity: 'HIGH', blockingFindings: [], reviewedWorkspace: 'w', reviewedFiles: [], timestamp: 'now' } }).action, 'COMPLETE')
  const critical = task(['auth/security.ts', 'database/migration.ts'])
  assert.equal(controller.decideWithEvidence(critical, { evidence, bindings }).action, 'REQUEST_APPROVAL')
})
test('stale or unmapped evidence cannot satisfy completion', () => {
  const state = task()
  assert.equal(completionSatisfied({ task: state, evidence: [{ type: 'test', status: 'PASSED', source: 'deterministic', workspaceIdentity: 'old', timestamp: 'now' }], bindings, risk: assessRisk(state) }), false)
  assert.equal(completionSatisfied({ task: state, evidence, bindings: [], risk: assessRisk(state) }), false)
})
