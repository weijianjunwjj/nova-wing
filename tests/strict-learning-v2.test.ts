import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentCapabilityProfile } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { strictLearningStage } from '../packages/development-guardian/work-session/learning-gate.js'

const codex: AgentCapabilityProfile = {
  id: 'codex', available: true, quotaExhausted: false, degraded: false,
  capabilities: { coding: true, reasoning: true, verification: true },
}

const manualPath = 'apps/api/src/runs/runs.controller.ts'
const aiPath = 'apps/api/src/runs/runs.service.ts'
const task = {
  id: 'learning-v2',
  goal: 'Implement the smallest visible Runs API slice',
  constraints: [
    'LEARNING_MODE: STRICT',
    'LEARNING_OBJECTIVE: Understand how a Nest Controller delegates request behavior into a Service',
    'LEARNING_PREDICTION: The Controller owns the HTTP boundary and forwards validated intent to the Service',
    'LEARNING_PREDICTION: The Service owns the run lookup behavior and should not depend on HTTP response objects',
    'LEARNING_UNKNOWN: How Nest resolves the Service provider when constructing the Controller',
    `LEARNING_MANUAL_PATH: ${manualPath}`,
    'LEARNING_MANUAL_CHALLENGE: Manually add a taskId lookup path and explain which layer owns the behavior',
    'LEARNING_MAX_FILES: 4',
  ],
  acceptanceCriteria: ['runs API slice passes deterministic tests'],
  acceptanceEvidenceBindings: [{ criterion: 'runs API slice passes deterministic tests', requiredEvidence: ['npm test'] }],
  allowedPaths: ['apps/api/src/**'],
}

const explanation = [
  'DATA_FLOW: The request enters RunsController, the transport input is interpreted there, and the Controller delegates the actual lookup to RunsService.',
  'WHY: Separating the HTTP boundary from run lookup behavior keeps transport concerns out of the Service and makes the business behavior independently testable.',
  'FAILURE: If RunsService cannot find the requested task or throws, the Controller path must surface a deliberate error instead of returning an invented successful run.',
  'CHANGE: To add a taskId lookup I would add the route input at the Controller boundary and implement lookup behavior in the Service without touching unrelated modules.',
].join('\n')

test('strict learning freezes AI completion, requires explanation and a real manual edit before completion', async () => {
  let changedFiles: readonly string[] = []
  let fingerprint = 'clean'
  const actions: string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's', branch: 'feat/learning', agents: [codex],
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'feat/learning', headSha: 'h1', changedFiles, worktreeFingerprint: fingerprint }),
      dispatch: async ({ action }) => {
        actions.push(action)
        if (action === 'EXECUTE') {
          changedFiles = [aiPath]
          fingerprint = 'ai-fingerprint'
          return { status: 'SUCCESS', changedFiles }
        }
        if (action === 'VERIFY') {
          return { status: 'SUCCESS', verificationResults: [{ name: 'npm test', status: 'passed' }] }
        }
        return { status: 'SUCCESS' }
      },
    },
  })

  const first = await runner.run(task)
  assert.equal(first.status, 'HUMAN_REQUIRED')
  assert.equal(first.humanRequired?.category, 'LEARNING_EXPLANATION_REQUIRED')
  assert.equal(strictLearningStage(first.taskStateV2!), 'EXPLANATION_REQUIRED')
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])

  const weak = await runner.run(task, { decision: 'I understand it' }, undefined, { taskStateV2: first.taskStateV2! })
  assert.equal(weak.humanRequired?.category, 'LEARNING_EXPLANATION_REQUIRED')
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])

  const explained = await runner.run(task, { decision: explanation }, undefined, { taskStateV2: first.taskStateV2! })
  assert.equal(explained.status, 'HUMAN_REQUIRED')
  assert.equal(explained.humanRequired?.category, 'LEARNING_MANUAL_CHANGE_REQUIRED')
  assert.equal(strictLearningStage(explained.taskStateV2!), 'MANUAL_CHANGE_REQUIRED')
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])

  const noManualChange = await runner.run(task, {}, undefined, { taskStateV2: explained.taskStateV2! })
  assert.equal(noManualChange.humanRequired?.category, 'LEARNING_MANUAL_CHANGE_REQUIRED')
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])

  // Simulate an edit made outside NovaWing while Executor access is blocked.
  changedFiles = [aiPath, manualPath]
  fingerprint = 'human-fingerprint'
  const completed = await runner.run(task, {}, undefined, { taskStateV2: explained.taskStateV2! })
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(strictLearningStage(completed.taskStateV2!), 'COMPLETE')
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY', 'VERIFY'])
})

test('failed verification of the manual edit cannot fall through to AI EXECUTE repair', async () => {
  let changedFiles: readonly string[] = []
  let fingerprint = 'clean'
  let manualVerificationShouldFail = true
  const actions: string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's2', branch: 'feat/learning', agents: [codex],
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'feat/learning', headSha: 'h1', changedFiles, worktreeFingerprint: fingerprint }),
      dispatch: async ({ action }) => {
        actions.push(action)
        if (action === 'EXECUTE') {
          changedFiles = [aiPath]
          fingerprint = 'ai-fingerprint'
          return { status: 'SUCCESS', changedFiles }
        }
        if (action === 'VERIFY') {
          const isManualPhase = fingerprint.startsWith('human-')
          return {
            status: isManualPhase && manualVerificationShouldFail ? 'FAILED' : 'SUCCESS',
            verificationResults: [{ name: 'npm test', status: isManualPhase && manualVerificationShouldFail ? 'failed' : 'passed' }],
          }
        }
        return { status: 'SUCCESS' }
      },
    },
  })

  const first = await runner.run(task)
  const explained = await runner.run(task, { decision: explanation }, undefined, { taskStateV2: first.taskStateV2! })
  changedFiles = [aiPath, manualPath]
  fingerprint = 'human-broken'
  const failedManual = await runner.run(task, {}, undefined, { taskStateV2: explained.taskStateV2! })
  assert.equal(failedManual.status, 'HUMAN_REQUIRED')
  assert.equal(failedManual.humanRequired?.category, 'LEARNING_MANUAL_FIX_REQUIRED')
  assert.equal(strictLearningStage(failedManual.taskStateV2!), 'MANUAL_FIX_REQUIRED')
  // Only the first AI implementation and the two verifier calls happened. No second EXECUTE is allowed.
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY', 'VERIFY'])

  manualVerificationShouldFail = false
  fingerprint = 'human-fixed'
  const fixed = await runner.run(task, {}, undefined, { taskStateV2: failedManual.taskStateV2! })
  assert.equal(fixed.status, 'COMPLETED')
  assert.equal(strictLearningStage(fixed.taskStateV2!), 'COMPLETE')
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY', 'VERIFY', 'VERIFY'])
})

test('AI touching the reserved manual path fails closed instead of pretending a later edit is human-owned', async () => {
  let changedFiles: readonly string[] = []
  let fingerprint = 'clean'
  const actions: string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 's3', branch: 'feat/learning', agents: [codex],
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'feat/learning', headSha: 'h1', changedFiles, worktreeFingerprint: fingerprint }),
      dispatch: async ({ action }) => {
        actions.push(action)
        if (action === 'EXECUTE') {
          changedFiles = [manualPath]
          fingerprint = 'ai-contaminated'
          return { status: 'SUCCESS', changedFiles }
        }
        if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: [{ name: 'npm test', status: 'passed' }] }
        return { status: 'SUCCESS' }
      },
    },
  })
  const result = await runner.run(task)
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'LEARNING_MANUAL_PATH_CONTAMINATED')
  assert.equal(strictLearningStage(result.taskStateV2!), undefined)
  assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])
})
