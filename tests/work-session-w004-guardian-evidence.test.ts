/**
 * W004-A Completion Evidence Contract
 *
 * 证明 GuardianWorkSessionTaskRunner 在 Guardian 真 COMPLETED 时，
 * 把最小结构化 TaskCompletionEvidence 返回给 WorkSession，
 * 且不泄漏完整 Guardian 内部对象（Task / ExecutionReport / packet 全量字段）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GuardianWorkSessionTaskRunner,
  type GuardianBrain,
  type GuardianExecutor,
  type ExecutionReport,
} from 'nova-wing/development-guardian'

await test('W004 evidence: COMPLETED runner returns minimal completion evidence', async () => {
  let reviewCalls = 0
  const brain: GuardianBrain = {
    async review({ report }) {
      reviewCalls += 1
      if (report === undefined) {
        return {
          verdict: 'proceed',
          goal: '实现 feature',
          instructions: ['实现 src/a.ts'],
          constraints: [],
          verification: ['git diff --check'],
          doNotDo: [],
        }
      }
      return {
        verdict: 'done',
        goal: '实现 feature',
        instructions: [],
        constraints: [],
        verification: ['git diff --check'],
        doNotDo: [],
      }
    },
  }

  const executor: GuardianExecutor = {
    async execute(): Promise<ExecutionReport> {
      return {
        summary: 'feature implemented',
        changedFiles: ['src/a.ts', 'src/b.ts'],
        commandsRun: ['claude -p ...'],
        verificationResults: [{ name: 'git diff --check', status: 'passed' }],
        blockers: [],
      }
    },
  }

  const runner = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
  })

  const result = await runner.run({ id: 'T1', goal: '实现 feature' })

  assert.equal(result.status, 'COMPLETED', 'task must complete')
  assert.equal(reviewCalls, 2, 'proceed then done')

  const evidence = result.completionEvidence
  assert.ok(evidence !== undefined, 'completion evidence must be present on COMPLETED')

  // 最小契约：只包含 Git finalization 必要字段，不含 Guardian 内部全量对象
  assert.deepEqual(evidence?.changedFiles, ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(evidence?.verificationResults, [{ name: 'git diff --check', status: 'passed' }])
  assert.deepEqual(evidence?.blockers, [])
  assert.equal(evidence?.finalReviewerVerdict, 'done')
  assert.deepEqual(evidence?.requiredVerification, ['git diff --check'])
  assert.equal(evidence?.incompleteReason, undefined, 'no incompleteReason on normal completion')

  assert.deepEqual(
    Object.keys(evidence as object).sort(),
    ['blockers', 'changedFiles', 'finalReviewerVerdict', 'requiredVerification', 'verificationResults'],
    'evidence must be the minimal contract (no Guardian internals leaked)',
  )
})

await test('W004 evidence: HUMAN_REQUIRED result has NO completion evidence', async () => {
  let reviewCalls = 0
  const brain: GuardianBrain = {
    async review() {
      reviewCalls += 1
      return {
        verdict: 'blocked',
        goal: '实现 feature',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
        rationale: '需要人工授权',
      }
    },
  }

  const runner = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => ({
      async execute(): Promise<ExecutionReport> {
        return { summary: '', changedFiles: [], commandsRun: [], verificationResults: [], blockers: [] }
      },
    }),
  })

  const result = await runner.run({ id: 'T1', goal: '实现 feature' })

  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.equal(result.completionEvidence, undefined, 'HUMAN_REQUIRED must not carry completion evidence')
})
