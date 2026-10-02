import { canonicalSerialize, verifyPlanSnapshot, type PlanSnapshot } from '../planning/freeze.js'
import { relativeTaskWorkspaceScope } from '../workspace-scope.js'
import type { GuardianTask } from '../model.js'
import type { WorkSessionDefinition, WorkSessionTask } from '../work-session/model.js'
import type { TaskRetryRequest } from '../work-session/task-retry.js'
import { DeliveryStore } from './service.js'
import { inspectDeliveryTarget, verifyRuntimePlanCoverage, verifyRuntimePlanIdentity, workSessionDefinitionFor } from './runtime-plan.js'

/** Reads the authoritative artifacts afresh on reconciliation AND on explicit resume. */
export function createDeliveryTaskRetryValidator(store: DeliveryStore,
  getSnapshot: (planId: string, version: number) => Promise<PlanSnapshot | undefined>) {
  return async (request: TaskRetryRequest, definition: WorkSessionDefinition): Promise<void> => {
    const binding = await store.getSession(request.sessionId)
    if (!binding || binding.status !== 'STARTED' || binding.workSessionId !== definition.id ||
      binding.sourceSnapshotId !== request.sourceSnapshotId || binding.sourcePlanHash !== request.sourcePlanHash ||
      binding.runtimePlanHash !== request.runtimePlanHash || binding.targetBindingId !== request.targetBindingId ||
      binding.targetBaselineCommit !== request.targetBaselineCommit) throw new Error('TASK_RETRY_BINDING_MISMATCH')
    const plan = await store.getPlan(binding.runtimePlanId)
    if (!plan) throw new Error('TASK_RETRY_RUNTIME_PLAN_MISSING')
    verifyRuntimePlanIdentity(plan)
    const snapshot = await getSnapshot(plan.sourcePlanId, plan.sourcePlanVersion)
    if (!snapshot) throw new Error('TASK_RETRY_FROZEN_SNAPSHOT_MISSING')
    verifyPlanSnapshot(snapshot)
    verifyRuntimePlanCoverage(snapshot, plan)
    if (plan.runtimePlanHash !== request.runtimePlanHash || plan.sourceSnapshotId !== request.sourceSnapshotId ||
      plan.sourcePlanHash !== request.sourcePlanHash || plan.targetBinding.id !== request.targetBindingId ||
      plan.targetBaselineCommit !== request.targetBaselineCommit || plan.compilerImplementationVersion !== binding.compilerVersion)
      throw new Error('TASK_RETRY_BINDING_MISMATCH')
    const current = await inspectDeliveryTarget(definition.targetRepo)
    // This first operation supports an exact clean baseline, never arbitrary descendant commits.
    if (!current.clean || current.baselineCommit !== request.targetBaselineCommit ||
      current.canonicalPath !== plan.targetBinding.canonicalPath ||
      current.gitRepositoryIdentity !== plan.targetBinding.gitRepositoryIdentity ||
      current.branch !== plan.targetBinding.branch || definition.branch !== current.branch)
      throw new Error('TASK_RETRY_BASELINE_DRIFT')
    if (definition.controlPlane !== 'v2' || definition.directPath?.enabled === true || definition.goldenPath?.enabled === true)
      throw new Error('TASK_RETRY_UNSUPPORTED_CONTROL_PLANE')
    const expected = workSessionDefinitionFor(plan, definition.id)
    const policy = (task: WorkSessionTask) => {
      const normalized = relativeTaskWorkspaceScope(current.canonicalPath,
        { ...task, state: 'READY', iteration: 0, maxIterations: 1 } as GuardianTask)
      return [task.id, task.goal, task.constraints ?? [], task.acceptanceCriteria ?? [],
        normalized.allowedPaths ?? [], normalized.forbiddenPaths ?? [], task.risk ?? 'NORMAL', task.acceptanceEvidenceBindings ?? []]
    }
    if (canonicalSerialize(definition.tasks.map(policy)) !== canonicalSerialize(expected.tasks.map(policy)))
      throw new Error('TASK_RETRY_TASK_POLICY_DRIFT')
  }
}
