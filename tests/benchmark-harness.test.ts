import assert from 'node:assert/strict'
import test from 'node:test'
import { architectureBenchmarkTasks, executedTasks, loadCatalog, runArchitectureBenchmark, runTask } from './benchmark/harness.js'
import type { BenchmarkTaskSpec } from './benchmark/harness.js'

function taskById(catalogTasks: BenchmarkTaskSpec[], id: string): BenchmarkTaskSpec {
  const task = catalogTasks.find((entry) => entry.id === id)
  assert.ok(task, `catalog must contain ${id}`)
  return task!
}

test('benchmark catalog is frozen with complete required fields and an executed subset', () => {
  const catalog = loadCatalog('benchmark/tasks.json')
  assert.ok(catalog.tasks.length >= 12, 'catalog must hold at least 12 tasks')
  const executed = executedTasks(catalog)
  assert.ok(executed.length >= 8, 'at least 8 tasks must be deterministic-executable')
  for (const task of catalog.tasks) {
    assert.ok(task.id && task.goal && task.category && task.risk, `${task.id} missing core fields`)
    assert.ok(task.acceptanceCriteria.length > 0, `${task.id} must define acceptance criteria`)
    assert.ok(Array.isArray(task.allowedPaths) && Array.isArray(task.forbiddenPaths), `${task.id} must define paths`)
    assert.ok(Number.isInteger(task.expectedDifficulty), `${task.id} expectedDifficulty must be an integer`)
    if (task.deterministic) {
      assert.ok(task.work !== undefined, `${task.id} deterministic task needs a work plan`)
      assert.ok(task.requiredEvidence.length > 0, `${task.id} needs requiredEvidence to verify`)
      assert.ok(task.work!.attempts.length >= 1, `${task.id} needs at least one attempt`)
    }
  }
})

test('T06 repair: v0.1 and v0.2 both repair a failed verification and complete', async () => {
  const catalog = loadCatalog('benchmark/tasks.json')
  const task = taskById(catalog.tasks, 'T06')
  const v1 = await runTask(task, 'v1')
  const v2 = await runTask(task, 'v2')
  assert.equal(v1.outcome.completed, true, 'v0.1 must complete the repair task')
  assert.equal(v2.outcome.completed, true, 'v0.2 must complete the repair task')
  assert.ok(v1.metrics.verificationFailureCount >= 1)
  assert.ok(v2.metrics.verificationFailureCount >= 1)
  assert.ok(v1.metrics.retryCount >= 1)
  assert.ok(v2.metrics.retryCount >= 1)
  assert.ok(v2.metrics.agentDispatchCount >= 2, 'v0.2 must dispatch EXECUTE twice')
})

test('T08 forbidden path: both v0.1 and v0.2 refuse to complete', async () => {
  const catalog = loadCatalog('benchmark/tasks.json')
  const task = taskById(catalog.tasks, 'T08')
  const v1 = await runTask(task, 'v1')
  const v2 = await runTask(task, 'v2')
  assert.equal(v1.outcome.completed, false, 'v0.1 must not complete a forbidden edit')
  assert.equal(v1.outcome.humanRequired, true)
  assert.equal(v2.outcome.completed, false, 'v0.2 must not complete a forbidden edit')
  assert.equal(v2.outcome.humanRequired, true)
})

test('T01 normal: v0.2 emits a full decision event history on completion', async () => {
  const catalog = loadCatalog('benchmark/tasks.json')
  const task = taskById(catalog.tasks, 'T01')
  const v2 = await runTask(task, 'v2')
  assert.equal(v2.outcome.completed, true)
  assert.ok(v2.metrics.taskEventCount >= 6, 'v0.2 should log TASK_CREATED/CONTROLLER_DECIDED/AGENT_DISPATCHED/VERIFY/TASK_COMPLETED')
  assert.ok(v2.metrics.controllerDecisionCount >= 3)
  assert.equal(v2.metrics.providerSwitchCount, 0, 'no provider switch on a healthy single-provider run')
  const v1 = await runTask(task, 'v1')
  assert.equal(v1.outcome.completed, true)
})

test('v0.2.8 architecture A/B covers A-H and removes Controller tax on simple Direct tasks', async () => {
  assert.deepEqual(architectureBenchmarkTasks.map((task) => task.category), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
  for (const spec of architectureBenchmarkTasks.filter((task) => ['A', 'B', 'C', 'H'].includes(task.category))) {
    const baseline = await runArchitectureBenchmark(spec, 'CONTROLLER')
    const direct = await runArchitectureBenchmark(spec, 'DIRECT')
    assert.equal(baseline.metrics.completed, true)
    assert.equal(direct.metrics.completed, true)
    assert.equal(direct.metrics.executeCount, 1)
    assert.equal(direct.metrics.verifyCount, 1)
    assert.equal(direct.metrics.controllerDecisionCount, 0)
    assert.equal(direct.metrics.reviewCount, 0)
    assert.equal(direct.metrics.repoInspectionCount, 2)
    assert.deepEqual(direct.metrics.failureSurface, [])
    assert.ok(direct.metrics.dispatchCount < baseline.metrics.dispatchCount)
    assert.ok(direct.metrics.stateWriteCount < baseline.metrics.stateWriteCount)
  }
})

test('v0.2.8 architecture A/B safety categories converge through escalation', async () => {
  const codeFailure = architectureBenchmarkTasks.find((task) => task.category === 'D')!
  const highRisk = architectureBenchmarkTasks.find((task) => task.category === 'F')!
  const repaired = await runArchitectureBenchmark(codeFailure, 'DIRECT')
  assert.equal(repaired.metrics.completed, true)
  assert.equal(repaired.metrics.escalated, true)
  assert.equal(repaired.metrics.executeCount, 2)
  const reviewed = await runArchitectureBenchmark(highRisk, 'DIRECT')
  assert.equal(reviewed.metrics.completed, true)
  assert.equal(reviewed.metrics.escalated, true)
  assert.ok(reviewed.metrics.reviewCount >= 1)
})
