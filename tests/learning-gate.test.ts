import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptLearningExplanation,
  inspectManualChange,
  markManualFixRequired,
  markStrictLearningComplete,
  parseStrictLearningContract,
  strictLearningStage,
  suspendForLearningExplanation,
} from '../packages/development-guardian/work-session/learning-gate.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'

const strictTask = {
  id: 'learn-1',
  goal: 'Implement one narrow API slice',
  constraints: [
    'LEARNING_MODE: STRICT',
    'LEARNING_OBJECTIVE: Understand the Controller to Service request boundary',
    'LEARNING_PREDICTION: The Controller receives HTTP input and delegates business behavior',
    'LEARNING_PREDICTION: The Service owns the in-memory run state for this slice',
    'LEARNING_UNKNOWN: How Nest dependency injection resolves the Service instance',
    'LEARNING_MANUAL_PATH: apps/api/src/runs/runs.controller.ts',
    'LEARNING_MANUAL_CHALLENGE: Manually add a taskId filter without asking an executor to edit code',
    'LEARNING_MAX_FILES: 4',
  ],
}

function completedState() {
  const initial = createTaskStateV2({ id: 's', branch: 'feat/learn' }, strictTask)
  return {
    ...initial,
    status: 'ACTIVE' as const,
    gitState: {
      repositoryIdentity: 'repo', branch: 'feat/learn', headSha: 'h1',
      changedFiles: ['apps/api/src/runs/runs.controller.ts'], worktreeFingerprint: 'ai-fingerprint',
    },
    verificationState: { results: [{ name: 'npm test', status: 'passed' as const }] },
  }
}

test('strict contract fails closed when the human pre-work is incomplete', () => {
  const parsed = parseStrictLearningContract({ constraints: ['LEARNING_MODE: STRICT'] })
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.ok, false)
  if (!parsed.enabled || parsed.ok) return
  assert.deepEqual(new Set(parsed.issues.map((issue) => issue.code)), new Set([
    'OBJECTIVE_REQUIRED', 'PREDICTION_REQUIRED', 'UNKNOWN_REQUIRED', 'MANUAL_PATH_REQUIRED',
    'MANUAL_CHALLENGE_REQUIRED', 'MAX_FILES_REQUIRED',
  ]))
})

test('strict contract accepts a bounded learning slice', () => {
  const parsed = parseStrictLearningContract(strictTask)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.ok, true)
  if (!parsed.enabled || !parsed.ok) return
  assert.equal(parsed.contract.maxFiles, 4)
  assert.equal(parsed.contract.predictions.length, 2)
})

test('AI completion freezes at explanation gate instead of becoming complete', () => {
  const gated = suspendForLearningExplanation(completedState())
  assert.equal(gated.status, 'SUSPENDED')
  assert.equal(strictLearningStage(gated), 'EXPLANATION_REQUIRED')
  assert.deepEqual(gated.blockers, ['LEARNING_EXPLANATION_REQUIRED'])
})

test('weak explanation is rejected and a structured explanation advances only to manual change', () => {
  const gated = suspendForLearningExplanation(completedState())
  assert.equal(acceptLearningExplanation(gated, 'looks good'), undefined)

  const accepted = acceptLearningExplanation(gated, [
    'DATA_FLOW: The HTTP request enters RunsController, is validated, and then delegates to RunsService for the actual run lookup.',
    'WHY: Keeping transport handling in the Controller and state behavior in the Service makes the boundary explicit and independently testable.',
    'FAILURE: If the Service throws or the API is unavailable, the Controller path must return a deliberate error instead of pretending the run exists.',
    'CHANGE: To add filtering later I would change the request input at the Controller boundary and the query behavior in RunsService, not unrelated modules.',
  ].join('\n'))
  assert.ok(accepted)
  assert.equal(strictLearningStage(accepted!), 'MANUAL_CHANGE_REQUIRED')
  assert.deepEqual(accepted!.blockers, ['LEARNING_MANUAL_CHANGE_REQUIRED'])
})

test('manual gate requires real workspace drift on the declared path and invalidates AI-era evidence', () => {
  const parsed = parseStrictLearningContract(strictTask)
  assert.equal(parsed.enabled && parsed.ok, true)
  if (!parsed.enabled || !parsed.ok) return
  const explanation = acceptLearningExplanation(suspendForLearningExplanation(completedState()), [
    'DATA_FLOW: The HTTP request enters RunsController, is validated, and then delegates to RunsService for the actual run lookup.',
    'WHY: Keeping transport handling in the Controller and state behavior in the Service makes the boundary explicit and independently testable.',
    'FAILURE: If the Service throws or the API is unavailable, the Controller path must return a deliberate error instead of pretending the run exists.',
    'CHANGE: To add filtering later I would change the request input at the Controller boundary and the query behavior in RunsService, not unrelated modules.',
  ].join('\n'))!

  const unchanged = inspectManualChange({
    task: explanation,
    contract: parsed.contract,
    reality: {
      repositoryIdentity: 'repo', branch: 'feat/learn', headSha: 'h1',
      changedFiles: ['apps/api/src/runs/runs.controller.ts'], worktreeFingerprint: 'ai-fingerprint',
    },
  })
  assert.equal(unchanged.ok, false)

  const changed = inspectManualChange({
    task: explanation,
    contract: parsed.contract,
    reality: {
      repositoryIdentity: 'repo', branch: 'feat/learn', headSha: 'h1',
      changedFiles: ['apps/api/src/runs/runs.controller.ts'], worktreeFingerprint: 'human-fingerprint',
    },
  })
  assert.equal(changed.ok, true)
  if (!changed.ok) return
  assert.equal(strictLearningStage(changed.task), 'MANUAL_VERIFY')
  assert.deepEqual(changed.task.verificationState.results, [])
  assert.deepEqual(changed.task.completion.evidence, [])
  assert.equal(changed.task.completion.review, undefined)
})

test('failed manual verification remains human-owned until it passes', () => {
  const blocked = markManualFixRequired(completedState())
  assert.equal(blocked.status, 'SUSPENDED')
  assert.equal(strictLearningStage(blocked), 'MANUAL_FIX_REQUIRED')
  assert.deepEqual(blocked.blockers, ['LEARNING_MANUAL_FIX_REQUIRED'])
  const done = markStrictLearningComplete({ ...blocked, blockers: [], status: 'ACTIVE' })
  assert.equal(strictLearningStage(done), 'COMPLETE')
})
