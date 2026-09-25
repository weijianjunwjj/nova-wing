import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDecisionBenchmarkReport,
  createDecisionBenchmarkCases,
  runDecisionBenchmark,
} from '../packages/development-guardian/decision-shadow/benchmark.js'
import { TASK_ACTIONS, type DecisionChoice } from '../packages/development-guardian/decision-shadow/contract.js'
import type { DecisionClient } from '../packages/development-guardian/decision-shadow/client.js'
import type { TaskAction } from '../packages/development-guardian/work-session/task-controller.js'

function client(actions: readonly TaskAction[]): DecisionClient {
  let index = 0
  return {
    async decide() {
      const action = actions[index]
      assert.ok(action)
      index++
      const probabilities = Object.fromEntries(TASK_ACTIONS.map((candidate) => [candidate, candidate === action ? 1 : 0]))
      const decision: DecisionChoice = {
        model: 'fixture',
        action,
        confidence: 0.5,
        probabilities,
        inputTokens: 1,
        outputTokens: 1,
      }
      return { status: 'ok', latencyMs: index * 10, decision }
    },
  }
}

test('benchmark cases derive all reference actions from deterministic TaskController states and retain the sanitized projection', () => {
  const cases = createDecisionBenchmarkCases()
  assert.equal(cases.length, 12)
  assert.equal(new Set(cases.map(({ caseId }) => caseId)).size, cases.length)
  assert.deepEqual(new Set(cases.map(({ referenceAction }) => referenceAction)), new Set(TASK_ACTIONS))
  for (const item of cases) {
    assert.deepEqual(Object.keys(item.projection).sort(), [
      'acceptanceCriteriaCount', 'approval', 'blockerCount', 'evidence', 'reconciliationRequired', 'review', 'risk',
      'runtimeOnlyAcceptance', 'taskStatus', 'unmappedAcceptanceCriteriaCount', 'verification', 'verifyOnly',
    ])
    const serialized = JSON.stringify(item.projection)
    for (const forbidden of ['caseId', 'referenceAction', 'reasonCode', 'goal', 'changedFiles']) {
      assert.equal(serialized.includes(forbidden), false, `${item.caseId}: ${forbidden}`)
    }
  }
})

test('benchmark reports accuracy, per-action confusion, latency, and a sufficiently supported winner without using confidence', async () => {
  const inputs = createDecisionBenchmarkCases()
  const references = inputs.map(({ referenceAction }) => referenceAction)
  const cases = await runDecisionBenchmark(inputs, {
    english: client(references),
    'typed-decisions': client(references.map(() => 'SUSPEND')),
  })
  const report = buildDecisionBenchmarkReport(cases)
  assert.equal(report.samples, 12)
  assert.deepEqual(report.action_coverage, TASK_ACTIONS)
  assert.equal(report.english.exact_match_rate, 1)
  assert.equal(report.typed_decisions.exact_match_rate, 2 / 12)
  assert.equal(report.english.latency_p50, 60)
  assert.equal(report.english.latency_p95, 120)
  assert.equal(report.typed_decisions.confusion_matrix.EXECUTE.SUSPEND, 3)
  assert.equal(report.better_checkpoint, 'english')
})

test('benchmark remains inconclusive when sample or action coverage is insufficient', async () => {
  const inputs = createDecisionBenchmarkCases().slice(0, 4)
  const references = inputs.map(({ referenceAction }) => referenceAction)
  const cases = await runDecisionBenchmark(inputs, {
    english: client(references),
    'typed-decisions': client(references.map(() => 'SUSPEND')),
  })
  assert.equal(buildDecisionBenchmarkReport(cases).better_checkpoint, 'inconclusive')
})
