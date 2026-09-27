import type { V2ActionDispatcher } from '../work-session/v2-controller-task-runner.js'
import type { CompiledRuntimePlan } from './runtime-plan.js'
import type { DeliveryStore } from './service.js'
import type { CapabilityEvidence } from './capability-layer.js'

export function pendingEvidenceKey(assertionId: string, obligationId: string): string {
  return `NOVAWING_VERIFICATION_PENDING:${assertionId}:${obligationId}`
}

/** The trusted V2 seam keeps development possible and completion fail closed until a verifier is bound. */
export function createDeliveryRuntimeDispatcher(plan: CompiledRuntimePlan, store: DeliveryStore,
  defaultDispatcher: V2ActionDispatcher): V2ActionDispatcher {
  return {
    inspectRepository: () => defaultDispatcher.inspectRepository(),
    async dispatch(input) {
      const bindings = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === input.task.identity.taskId && item.blocking)
      if (bindings.length === 0) return { status: 'BLOCKED', blockers: ['Delivery task has no blocking assertions.'] }
      const pending = bindings.filter((item) => item.stagedVerification.readiness !== 'BOUND_EXECUTABLE')
      if (input.action === 'EXECUTE') {
        // Executor may implement the target; an obligation marker is never a shell command.
        const sanitized = { ...input.task, completion: { ...input.task.completion,
          bindings: input.task.completion.bindings.map((item) => ({ ...item,
            requiredEvidence: item.requiredEvidence.filter((value) => !value.startsWith('NOVAWING_VERIFICATION_PENDING:')) })) } }
        return defaultDispatcher.dispatch({ ...input, task: sanitized })
      }
      if (input.action !== 'VERIFY') return defaultDispatcher.dispatch(input)
      const deferred = pending.find((item) => item.stagedVerification.readiness === 'EXTERNAL_DEFERRED' ||
        item.stagedVerification.readiness === 'HUMAN_DEFERRED' || item.stagedVerification.readiness === 'UNRESOLVED')
      if (deferred) return { status: 'BLOCKED', blockers: [`${deferred.assertionId} requires ${deferred.stagedVerification.readiness} evidence.`] }
      const provisioned = pending.filter((item) => item.stagedVerification.readiness === 'PROVISIONABLE')
      const results = [] as NonNullable<Awaited<ReturnType<V2ActionDispatcher['dispatch']>>['verificationResults']>[number][]
      if (bindings.some((item) => item.stagedVerification.readiness === 'BOUND_EXECUTABLE')) {
        const commandOnly = { ...input.task, completion: { ...input.task.completion,
          bindings: input.task.completion.bindings.filter((item) => !item.requiredEvidence.some((value) =>
            value.startsWith('NOVAWING_VERIFICATION_PENDING:'))) } }
        const commandResult = await defaultDispatcher.dispatch({ ...input, task: commandOnly })
        if (commandResult.status !== 'SUCCESS' || !commandResult.verificationResults?.every((item) => item.status === 'passed'))
          return commandResult
        results.push(...commandResult.verificationResults)
      }
      for (const binding of provisioned) {
        const obligation = binding.stagedVerification.provisioning!
        const transition = await store.getBindingTransition(plan, binding.assertionId, binding.runtimeTaskId)
        if (transition === undefined) return { status: 'BLOCKED', blockers: [`${binding.assertionId} exact verifier has not been provisioned.`] }
        let observed: CapabilityEvidence
        try { observed = await store.collectProvisionedEvidence(plan, binding.assertionId, binding.runtimeTaskId) }
        catch (error) { return { status: 'BLOCKED',
          blockers: [`${binding.assertionId} exact verifier failed: ${error instanceof Error ? error.message : String(error)}`] } }
        const key = pendingEvidenceKey(binding.assertionId, obligation.id)
        results.push({ name: key, stepId: key, rawOutputRef: observed.id,
          ...(transition.verifier.family === 'command' ? { command: transition.verifier.command } : {}),
          status: observed.result === 'OBSERVED' && observed.facts.observedMatch === true
          ? 'passed' : 'failed', details: `Capability evidence: ${observed.id}`,
        ...(observed.facts.observedMatch === true ? {} : { classification: 'EVIDENCE_MISSING' as const }) })
      }
      if (results.length === 0) return { status: 'BLOCKED', blockers: ['No exact delivery verifier was executed.'] }
      return { status: 'SUCCESS', verificationResults: results }
    },
  }
}
