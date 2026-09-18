import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeAcceptanceEvidence, verifierEvidenceFromBindings } from '../packages/development-guardian/work-session/completion-criteria.js'
import { TaskController } from '../packages/development-guardian/work-session/task-controller.js'
import { createTaskStateV2, loadTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { bindingsFromVerificationPlan, planVerification, verificationPlanFingerprintValid } from '../packages/development-guardian/work-session/verification-planner.js'
import { completionEvidence } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { finalizeCompletedTask } from '../packages/development-guardian/work-session/git-checkpoint.js'

const checkpoint = '成功生成 Git checkpoint。'

test('runtime completion grammar recognizes complete checkpoint assertions, never incidental mentions', () => {
  assert.equal(runtimeAcceptanceEvidence(checkpoint), 'CHECKPOINT_COMMITTED')
  assert.equal(runtimeAcceptanceEvidence('Git checkpoint must be committed.'), 'CHECKPOINT_COMMITTED')
  for (const criterion of ['代码实际完成。', '不存在 unresolved blocker。', '更新 Git checkpoint 展示文案。', '不要生成 Git checkpoint。', 'git diff --check 通过。']) {
    assert.equal(runtimeAcceptanceEvidence(criterion), undefined, criterion)
  }
})

test('planner retains checkpoint text and binds only finalization evidence with no checkpoint verifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-v031-checkpoint-plan-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
    const plan = await planVerification({ repositoryRoot: root, task: {
      id: 'T1', goal: 'Complete the code and checkpoint', acceptanceCriteria: ['代码实际完成。', 'npm run typecheck 必须通过。', checkpoint],
      acceptanceEvidenceBindings: [
        { criterion: '代码实际完成。', requiredEvidence: ['git diff --check'] },
        { criterion: 'npm run typecheck 必须通过。', requiredEvidence: ['npm run typecheck'] },
      ],
    } })
    assert.equal(plan.confidence, 'HIGH')
    assert.equal(verificationPlanFingerprintValid(plan), true)
    assert.deepEqual(plan.mappings.at(-1), { criterion: checkpoint, evidence: ['CHECKPOINT_COMMITTED'], scope: 'REPOSITORY',
      reason: 'Runtime-owned checkpoint evidence is required during FINALIZING; no shell verifier proves this assertion.' })
    assert.deepEqual(plan.steps.map((step) => step.command), ['git diff --check', 'npm run typecheck'])
    assert.ok(plan.steps.every((step) => !step.expectedCoverage.includes(checkpoint)))
    assert.deepEqual(verifierEvidenceFromBindings(bindingsFromVerificationPlan(plan)), ['git diff --check', 'npm run typecheck'])
    assert.deepEqual(bindingsFromVerificationPlan(plan, { identity: 'step' }).at(-1)?.requiredEvidence, ['CHECKPOINT_COMMITTED'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Controller authorizes finalization without fabricating checkpoint verifier evidence', () => {
  const controller = new TaskController()
  const initial = createTaskStateV2({ id: 'S1', branch: 'feat/test' }, { id: 'T1', goal: 'Implement task',
    acceptanceCriteria: ['tested', checkpoint], acceptanceEvidenceBindings: [{ criterion: 'tested', requiredEvidence: ['test'] }] })
  assert.deepEqual(initial.completion.bindings.at(-1), { criterion: checkpoint, requiredEvidence: ['CHECKPOINT_COMMITTED'] })
  const active = { ...initial, status: 'ACTIVE' as const, gitState: { repositoryIdentity: 'repo', branch: 'feat/test', headSha: 'head', worktreeFingerprint: 'tree', changedFiles: [] } }
  const verified = controller.applyResult(active, 'VERIFY', { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] })
  assert.equal(controller.decide(loadTaskStateV2(verified)).action, 'COMPLETE')
  assert.equal(verified.completion.evidence.some((item) => item.type === 'CHECKPOINT_COMMITTED'), false)
  assert.deepEqual(completionEvidence(verified, verified.verificationState.results).requiredVerification, ['test'])
  assert.equal(controller.decide({ ...verified, blockers: ['unresolved'] }).action, 'SUSPEND')
  const forged = { ...verified, acceptanceCriteria: ['tested', '代码实际完成。'], completion: { ...verified.completion,
    bindings: [{ criterion: 'tested', requiredEvidence: ['test'] }, { criterion: '代码实际完成。', requiredEvidence: ['CHECKPOINT_COMMITTED'] }] } }
  assert.equal(controller.decide(forged).action, 'VERIFY')
})

test('checkpoint-only planning needs no shell verifier or evidence-selection confirmation', async () => {
  const plan = await planVerification({ repositoryRoot: process.cwd(), task: { id: 'T1', goal: 'Create a checkpoint', acceptanceCriteria: [checkpoint] } })
  assert.equal(plan.confidence, 'HIGH')
  assert.equal(plan.approvalRequired, false)
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.mappings.map((mapping) => mapping.evidence), [['CHECKPOINT_COMMITTED']])
})

test('checkpoint-only Controller executes then finalizes without requesting a nonexistent verifier', () => {
  const controller = new TaskController()
  const initial = createTaskStateV2({ id: 'S1', branch: 'feat/test' }, { id: 'T1', goal: 'Create checkpoint', acceptanceCriteria: [checkpoint] })
  assert.equal(controller.decide(initial).action, 'EXECUTE')
  const implemented = controller.applyResult(initial, 'EXECUTE', { status: 'SUCCESS', repositoryChanged: true })
  assert.deepEqual(implemented.verificationState.results, [])
  assert.equal(controller.decide(implemented).action, 'COMPLETE')
  assert.deepEqual(completionEvidence(implemented, []).requiredVerification, [])
})

test('runtime checkpoint mapping preserves explicitly required approval', async () => {
  const task = { id: 'T1', goal: 'Create checkpoint', acceptanceCriteria: [checkpoint],
    acceptanceEvidenceBindings: [{ criterion: checkpoint, requiredEvidence: ['CHECKPOINT_COMMITTED'], requiresApproval: true }] }
  const plan = await planVerification({ repositoryRoot: process.cwd(), task })
  assert.equal(plan.approvalRequired, true)
  assert.equal(plan.mappings[0]?.requiresApproval, true)
  const bindings = bindingsFromVerificationPlan(plan)
  assert.equal(bindings[0]?.requiresApproval, true)
  const state = createTaskStateV2({ id: 'S1', branch: 'feat/test' }, { ...task, acceptanceEvidenceBindings: bindings })
  assert.equal(new TaskController().decide({ ...state, status: 'ACTIVE' }).action, 'REQUEST_APPROVAL')
})

test('explicit verifier authority remains intact for a runtime-state criterion', () => {
  const explicit = { criterion: checkpoint, requiredEvidence: ['git diff --check'] }
  const state = createTaskStateV2({ id: 'S1', branch: 'feat/test' }, { id: 'T1', goal: 'Implement task',
    acceptanceCriteria: [checkpoint], acceptanceEvidenceBindings: [explicit] })
  assert.deepEqual(state.completion.bindings, [explicit])
  assert.deepEqual(verifierEvidenceFromBindings(state.completion.bindings), ['git diff --check'])
})

test('checkpoint finalizer retains required verifier protection for an explicit shell binding', async () => {
  await assert.rejects(finalizeCompletedTask({ repoPath: process.cwd(), expectedBranch: 'feat/test',
    task: { id: 'T1', goal: 'Create checkpoint', acceptanceCriteria: [checkpoint],
      acceptanceEvidenceBindings: [{ criterion: checkpoint, requiredEvidence: ['git diff --check'] }] },
    completionEvidence: { changedFiles: [], verificationResults: [], blockers: [], finalReviewerVerdict: 'done', requiredVerification: [] },
    policy: { autoCommit: true, autoPush: false }, commandRunner: async () => { throw new Error('must reject before Git operations') },
  }), /no deterministic verification results/u)
})
