import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  loadProjectLearningPolicy,
  PROJECT_LEARNING_POLICY_RELATIVE_PATH,
} from '../packages/development-guardian/work-session/project-learning-policy.js'
import type { AgentCapabilityProfile } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'

const codex: AgentCapabilityProfile = {
  id: 'codex', available: true, quotaExhausted: false, degraded: false,
  capabilities: { coding: true, reasoning: true, verification: true },
}

const ordinaryTask = {
  id: 'ordinary',
  goal: 'Implement one tiny neutral slice',
  acceptanceCriteria: ['test passes'],
  acceptanceEvidenceBindings: [{ criterion: 'test passes', requiredEvidence: ['test'] }],
}

const strictTask = {
  ...ordinaryTask,
  id: 'strict',
  constraints: [
    'LEARNING_MODE: STRICT',
    'LEARNING_OBJECTIVE: Understand the transport to service boundary before accepting AI code',
    'LEARNING_PREDICTION: The transport layer delegates the actual lookup behavior to a separate service',
    'LEARNING_PREDICTION: Deterministic verification must run again after the human-owned code edit',
    'LEARNING_UNKNOWN: How provider injection is resolved at runtime',
    'LEARNING_MANUAL_PATH: src/runs/runs.controller.ts',
    'LEARNING_MANUAL_CHALLENGE: Manually add one lookup route without asking an executor to edit this file',
    'LEARNING_MAX_FILES: 4',
  ],
}

test('repository policy loader is absent by default, accepts exact strict policy, and rejects malformed policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-learning-policy-'))
  try {
    assert.equal(await loadProjectLearningPolicy(root), undefined)
    const policyDir = join(root, '.novawing')
    await mkdir(policyDir)
    await writeFile(join(root, PROJECT_LEARNING_POLICY_RELATIVE_PATH), '{"mode":"strict"}\n', 'utf8')
    assert.deepEqual(await loadProjectLearningPolicy(root), { mode: 'strict' })
    await writeFile(join(root, PROJECT_LEARNING_POLICY_RELATIVE_PATH), '{"mode":"strict","bypass":true}\n', 'utf8')
    await assert.rejects(loadProjectLearningPolicy(root), /must contain exactly/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('strict repository policy blocks a Task without a strict learning contract before any agent dispatch', async () => {
  let dispatches = 0
  const runner = new V2ControllerTaskRunner({
    sessionId: 'policy-required', branch: 'main', agents: [codex], strictLearningRequired: true,
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h1', changedFiles: [], worktreeFingerprint: 'clean' }),
      dispatch: async () => { dispatches++; return { status: 'SUCCESS' } },
    },
  })
  const result = await runner.run(ordinaryTask)
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'CONFIGURATION_REQUIRED')
  assert.match(result.humanRequired?.reason ?? '', /repository policy requires strict learning/u)
  assert.equal(dispatches, 0)
})

test('strict repository policy file is protected from Executor mutation during the session', async () => {
  let changedFiles: readonly string[] = []
  let fingerprint = 'clean'
  const actions: string[] = []
  const runner = new V2ControllerTaskRunner({
    sessionId: 'policy-protected', branch: 'main', agents: [codex], strictLearningRequired: true,
    dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h1', changedFiles, worktreeFingerprint: fingerprint }),
      dispatch: async ({ action }) => {
        actions.push(action)
        if (action === 'EXECUTE') {
          changedFiles = ['src/runs/runs.service.ts', PROJECT_LEARNING_POLICY_RELATIVE_PATH]
          fingerprint = 'executor-mutated-policy'
          return { status: 'SUCCESS', changedFiles }
        }
        return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
      },
    },
  })
  const result = await runner.run(strictTask)
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.humanRequired?.category, 'LEARNING_POLICY_MUTATION_FORBIDDEN')
  assert.deepEqual(actions, ['EXECUTE'])
})
