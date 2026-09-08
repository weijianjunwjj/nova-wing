import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskController, assessRisk, createTaskStateV2, type EvidenceV2 } from '../packages/development-guardian/work-session/index.js'

function task(files: string[] = []) { return { ...createTaskStateV2({ id: 's', branch: 'main' }, { id: 't', goal: 'x', acceptanceCriteria: ['done'], acceptanceEvidenceBindings: bindings }), status: 'ACTIVE' as const, gitState: { repositoryIdentity: 'repo', branch: 'main', changedFiles: files, headSha: 'h', worktreeFingerprint: 'w' }, verificationState: { results: [{ name: 'test', status: 'passed' as const }] }, completion: { evidence, bindings } } }
const evidence: EvidenceV2[] = [{ type: 'test', status: 'PASSED', source: 'deterministic', repositoryIdentity: 'repo', branch: 'main', headSha: 'h', workspaceIdentity: 'w', timestamp: 'now' }]
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
  const implemented = { ...high, implementer: { agent: 'codex', provider: 'codex', runtimeIdentity: 'runtime-implementer' } }
  assert.equal(controller.decide({ ...implemented, completion: { ...implemented.completion, review: { passed: true, findings: [], severity: 'HIGH', blockingFindings: [], reviewer: { agent: 'reviewer', provider: 'deepseek', runtimeIdentity: 'runtime-reviewer' }, implementer: implemented.implementer, reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: ['src/public-api.ts'], timestamp: 'now' } } }).action, 'COMPLETE')
  const critical = task(['auth/security.ts', 'database/migration.ts'])
  assert.equal(controller.decide(critical).action, 'REQUEST_APPROVAL')
})
test('HIGH review rejects a relabeled reviewer running in the implementer runtime', () => {
  const high = { ...task(['src/public-api.ts']), implementer: { agent: 'codex', provider: 'codex', runtimeIdentity: 'shared-runtime' } }
  const disguised = {
    passed: true, findings: [], severity: 'HIGH' as const, blockingFindings: [],
    implementer: high.implementer,
    reviewer: { agent: 'independent-reviewer', provider: 'deepseek', runtimeIdentity: 'shared-runtime' },
    reviewedRepository: 'repo', reviewedBranch: 'main', reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: ['src/public-api.ts'], timestamp: 'now',
  }
  assert.equal(new TaskController().decide({ ...high, completion: { ...high.completion, review: disguised } }).action, 'REVIEW')
})
test('stale, unmapped, or identity-less evidence cannot satisfy completion', () => {
  const state = task()
  assert.equal(new TaskController().decide({ ...state, completion: { evidence: [{ type: 'test', status: 'PASSED', source: 'deterministic', repositoryIdentity: 'repo', branch: 'main', headSha: 'h', workspaceIdentity: 'old', timestamp: 'now' }], bindings } }).action, 'VERIFY')
  assert.equal(new TaskController().decide({ ...state, completion: { evidence: [{ type: 'test', status: 'PASSED', source: 'deterministic', timestamp: 'now' }], bindings } }).action, 'VERIFY')
  assert.equal(new TaskController().decide({ ...state, completion: { evidence, bindings: [] } }).action, 'VERIFY')
  assert.equal(new TaskController().decide({ ...state, completion: { evidence, bindings: [{ criterion: 'done', requiredEvidence: ['typecheck'] }] } }).action, 'VERIFY')
})

test('acceptance binding identity, duplicate criteria and explicit approval fail closed', () => {
  const base = task()
  const controller = new TaskController()
  assert.equal(controller.decide({ ...base, completion: { evidence, bindings: [{ criterion: 'other', requiredEvidence: ['test'] }] } }).action, 'VERIFY')
  assert.equal(controller.decide({ ...base, acceptanceCriteria: ['A', 'B'], completion: { evidence, bindings: [
    { criterion: 'A', requiredEvidence: ['test'] }, { criterion: 'A', requiredEvidence: ['test'] },
  ] } }).action, 'VERIFY')
  assert.equal(controller.decide({ ...base, acceptanceCriteria: ['A', 'B'], completion: { evidence, bindings: [
    { criterion: 'A', requiredEvidence: ['test'] }, { criterion: 'B', requiredEvidence: ['typecheck'] },
  ] } }).action, 'VERIFY')
  assert.equal(controller.decide({ ...base, completion: { evidence, bindings: [{ ...bindings[0]!, requiresApproval: true }] } }).action, 'REQUEST_APPROVAL')
})

test('review must cover the observed files and the complete implementer identity', () => {
  const base = { ...task(['src/public-api.ts']), implementer: { agent: 'coder', provider: 'codex', runtimeIdentity: 'R1' } }
  const review = { passed: true, findings: [], severity: 'HIGH' as const, blockingFindings: [], implementer: base.implementer,
    reviewer: { agent: 'reviewer', provider: 'codex', runtimeIdentity: 'R2' }, reviewedRepository: 'repo', reviewedBranch: 'main',
    reviewedCommit: 'h', reviewedWorkspace: 'w', reviewedFiles: ['src/public-api.ts'], timestamp: 'now' }
  const controller = new TaskController()
  assert.equal(controller.decide({ ...base, completion: { ...base.completion, review } }).action, 'COMPLETE')
  for (const invalid of [{ ...review, reviewedFiles: [] }, { ...review, implementer: { ...review.implementer, provider: 'fake' } },
    { ...review, reviewer: { ...review.reviewer, runtimeIdentity: '' } }]) {
    assert.equal(controller.decide({ ...base, completion: { ...base.completion, review: invalid } }).action, 'REVIEW')
  }
})
