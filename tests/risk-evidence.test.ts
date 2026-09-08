import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskController, assessRisk, createTaskStateV2, type EvidenceV2 } from '../packages/development-guardian/work-session/index.js'

function task(files: string[] = []) { return { ...createTaskStateV2({ id: 's', branch: 'main' }, { id: 't', goal: 'x', acceptanceCriteria: ['done'] }), status: 'ACTIVE' as const, gitState: { changedFiles: files, headSha: 'h', worktreeFingerprint: 'w' }, verificationState: { results: [{ name: 'test', status: 'passed' as const }] }, completion: { evidence, bindings } } }
const evidence: EvidenceV2[] = [{ type: 'test', status: 'PASSED', source: 'deterministic', workspaceIdentity: 'w', timestamp: 'now' }]
const bindings = [{ criterion: 'done', requiredEvidence: ['test'] }]

test('LOW risk completes without a reviewer when mapped evidence passes', () => {
  const state = task()
  assert.equal(assessRisk(state).level, 'LOW')
  assert.equal(new TaskController().decide(state).action, 'COMPLETE')
})
test('HIGH risk requires structured independent review and CRITICAL requires approval', () => {
  const high = task(['src/public-api.ts'])
  const controller = new TaskController()
  assert.equal(controller.decide(high).action, 'REVIEW')
  assert.equal(controller.decide({ ...high, completion: { ...high.completion, review: { passed: true, findings: [], severity: 'HIGH', blockingFindings: [], reviewerIdentity: 'reviewer', implementerIdentity: 'codex', reviewerRuntimeIdentity: 'r', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: [], timestamp: 'now' } } }).action, 'COMPLETE')
  const critical = task(['auth/security.ts', 'database/migration.ts'])
  assert.equal(controller.decide(critical).action, 'REQUEST_APPROVAL')
})
test('stale, unmapped, or identity-less evidence cannot satisfy completion', () => {
  const state = task()
  assert.equal(new TaskController().decide({ ...state, completion: { evidence: [{ type: 'test', status: 'PASSED', source: 'deterministic', workspaceIdentity: 'old', timestamp: 'now' }], bindings } }).action, 'VERIFY')
  assert.equal(new TaskController().decide({ ...state, completion: { evidence: [{ type: 'test', status: 'PASSED', source: 'deterministic', timestamp: 'now' }], bindings } }).action, 'VERIFY')
  assert.equal(new TaskController().decide({ ...state, completion: { evidence, bindings: [] } }).action, 'VERIFY')
})
