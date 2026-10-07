import type { V2ActionDispatcher } from '../work-session/v2-controller-task-runner.js'
import type { TaskActionResult } from '../work-session/task-controller.js'
import type { CompiledRuntimePlan } from './runtime-plan.js'
import type { DeliveryStore } from './service.js'
import type { CapabilityEvidence } from './capability-layer.js'
import { CAPABILITY_REGISTRY, type ProviderAvailability } from './capability-layer.js'
import { inspectDeliveryTarget } from './runtime-plan.js'
import { bindObligationAtCommit, createClaudeBlueprintReviewer, createClaudeBlueprintRepairer } from './verification-blueprint-planner.js'
import { taskCompletionGate, type AssertionCompletionEvidence, type VerificationBindingTransition } from './staged-verification.js'
import { commitImplementationCheckpoint, type ImplementationCheckpointHandoff } from '../work-session/implementation-checkpoint.js'

export function pendingEvidenceKey(assertionId: string, obligationId: string): string {
  return `NOVAWING_VERIFICATION_PENDING:${assertionId}:${obligationId}`
}

/** The trusted V2 seam keeps development possible and completion fail closed until a verifier is bound. */
export function createDeliveryRuntimeDispatcher(plan: CompiledRuntimePlan, store: DeliveryStore,
  defaultDispatcher: V2ActionDispatcher,
  providerAvailability?: (providerId: string) => ProviderAvailability): V2ActionDispatcher {
  const completionProofs = new Map<string, { transitions: VerificationBindingTransition[];
    evidence: AssertionCompletionEvidence[] }>()
  return {
    inspectRepository: () => defaultDispatcher.inspectRepository(),
    async deliveryCompletionGate(task) {
      const bindings = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === task.identity.taskId &&
        item.blocking && item.ownership === 'OWNER')
      const transitions: VerificationBindingTransition[] = []
      const evidence: AssertionCompletionEvidence[] = []
      const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath).catch(() => undefined)
      if (!current?.clean) return { status: 'BLOCKED', reason: 'Implementation repository is not clean.' }
      for (const binding of bindings) {
        const stage = binding.stagedVerification
        const verdict = task.completion.review?.assertionVerdicts?.find((item) => item.assertionId === binding.assertionId)
        if (stage.readiness === 'EXTERNAL_DEFERRED' || stage.readiness === 'HUMAN_DEFERRED') {
          if (verdict?.verdict !== 'DEFERRED') return { status: 'BLOCKED', reason: `${binding.assertionId} requires DEFERRED review.` }
          evidence.push({ assertionId: binding.assertionId, runtimeTaskId: binding.runtimeTaskId,
            providerId: binding.verificationCapability.providerId, collector: 'independent-reviewer',
            verificationStep: 'COMPLETION_DEFERRED', expectedOutcome: binding.expectedOutcome,
            evidenceId: `DEFERRED:${binding.assertionId}`, executed: false, observedMatch: false,
            reviewerVerdict: 'DEFERRED' })
          continue
        }
        if (verdict?.verdict !== 'PASS') return { status: 'BLOCKED', reason: `${binding.assertionId} has no independent PASS.` }
        const transition = await store.getBindingTransition(plan, binding.assertionId, binding.runtimeTaskId).catch(() => undefined)
        if (stage.readiness === 'PROVISIONABLE_DURING_EXECUTION' && !transition)
          return { status: 'BLOCKED', reason: `${binding.assertionId} has no durable blueprint transition.` }
        if (transition) {
          if (transition.implementationCommit !== current.baselineCommit) return { status: 'BLOCKED',
            reason: `${binding.assertionId} implementation commit changed after verification.` }
          transitions.push(transition)
        }
        const result = task.verificationState.results.find((item) => item.stepId ===
          pendingEvidenceKey(binding.assertionId, stage.obligation?.obligationId ?? '') && item.status === 'passed')
        const observed = result?.rawOutputRef ? await store.getCapabilityEvidence(plan, result.rawOutputRef).catch(() => undefined) : undefined
        if (!result || !observed || observed.facts.observedMatch !== true ||
          !verdict.capabilityEvidence?.evidenceIds.includes(observed.id)) return { status: 'BLOCKED',
          reason: `${binding.assertionId} lacks linked executed evidence.` }
        evidence.push({ assertionId: binding.assertionId, runtimeTaskId: binding.runtimeTaskId,
          ...(transition ? { transitionId: transition.id, implementationCommit: transition.implementationCommit,
            blueprintHash: transition.blueprintHash, artifactHashes: transition.artifactHashes } : {}),
          providerId: observed.providerId, collector: observed.collector,
          verificationStep: result.stepId!, expectedOutcome: binding.expectedOutcome, evidenceId: observed.id,
          executed: true, observedMatch: true, reviewerVerdict: verdict.verdict,
          reviewerEvidenceIds: verdict.capabilityEvidence.evidenceIds })
      }
      const status = taskCompletionGate(bindings, transitions, evidence)
      if (status === 'LOCALLY_VERIFIED') completionProofs.set(task.identity.taskId, { transitions, evidence })
      return { status }
    },
    async deliveryTaskCompleted(task) {
      const proof = completionProofs.get(task.identity.taskId)
      if (!proof) throw new Error('Task has no current delivery completion proof.')
    },
    async deliveryTaskFinalized(task, commitSha) {
      const proof = completionProofs.get(task.identity.taskId)
      if (!proof) throw new Error('Finalized Task has no current delivery completion proof.')
      const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath)
      if (!current.clean || current.baselineCommit !== commitSha)
        throw new Error('Finalized Task implementation commit changed.')
      await store.recordLocalTaskCompletion(plan, task.identity.taskId, proof.transitions, proof.evidence)
      completionProofs.delete(task.identity.taskId)
    },
    async dispatch(input) {
      const bindings = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === input.task.identity.taskId &&
        item.blocking && item.ownership === 'OWNER')
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
      const unresolved = pending.find((item) => item.stagedVerification.readiness === 'UNRESOLVED' ||
        (item.stagedVerification.prerequisite === 'EXECUTION' &&
          ['EXTERNAL_DEFERRED', 'HUMAN_DEFERRED'].includes(item.stagedVerification.readiness)))
      if (unresolved) return { status: 'BLOCKED', blockers: [`${unresolved.assertionId} requires ${unresolved.stagedVerification.readiness} evidence.`] }
      const provisioned = pending.filter((item) => item.stagedVerification.readiness === 'PROVISIONABLE_DURING_EXECUTION')
      const unavailable = bindings.find((item) =>
        ['BOUND_EXECUTABLE', 'PROVISIONABLE_DURING_EXECUTION'].includes(item.stagedVerification.readiness) &&
        (providerAvailability?.(item.verificationCapability.providerId) ??
          CAPABILITY_REGISTRY[item.verificationCapability.family].availability) !== 'AVAILABLE')
      if (unavailable) return { status: 'BLOCKED', blockers: [
        `${unavailable.assertionId} verification provider unavailable during execution.`] }
      let checkpoint: ImplementationCheckpointHandoff | undefined
      try {
        const committed = await commitImplementationCheckpoint({
          repoPath: plan.targetBinding.canonicalPath,
          repositoryIdentity: input.task.gitState.repositoryIdentity ?? '',
          branch: plan.targetBinding.branch ?? '',
          baselineCommit: plan.targetBaselineCommit,
          sessionId: input.task.identity.sessionId,
          taskId: input.task.identity.taskId,
          ...(input.task.attemptId === undefined ? {} : { attemptId: input.task.attemptId }),
          before: input.task.gitState,
          expectedChangedFiles: input.task.gitState.changedFiles,
          allowedPaths: input.task.permissions.allowedPaths,
          forbiddenPaths: input.task.permissions.forbiddenPaths,
        })
        checkpoint = committed.disposition === 'COMMITTED' ? committed.handoff : undefined
      } catch (error) { return { status: 'BLOCKED', blockers: [
        `IMPLEMENTATION_CHECKPOINT_BLOCKED: ${error instanceof Error ? error.message : String(error)}`] } }
      // The commit moved HEAD; the Controller may only adopt it through this
      // one-time handoff, so every post-commit result must carry it.
      const withCheckpoint = (result: TaskActionResult): TaskActionResult & { implementationCheckpoint?: unknown } =>
        checkpoint === undefined ? result : { ...result, implementationCheckpoint: checkpoint }
      const results = [] as NonNullable<Awaited<ReturnType<V2ActionDispatcher['dispatch']>>['verificationResults']>[number][]
      if (bindings.some((item) => item.stagedVerification.readiness === 'BOUND_EXECUTABLE')) {
        const commandOnly = { ...input.task, completion: { ...input.task.completion,
          bindings: input.task.completion.bindings.filter((item) => !item.requiredEvidence.some((value) =>
            value.startsWith('NOVAWING_VERIFICATION_PENDING:'))) } }
        const commandResult = await defaultDispatcher.dispatch({ ...input, task: commandOnly })
        if (commandResult.status !== 'SUCCESS' || !commandResult.verificationResults?.every((item) => item.status === 'passed'))
          return withCheckpoint(commandResult)
        results.push(...commandResult.verificationResults)
      }
      for (const binding of provisioned) {
        const obligation = binding.stagedVerification.obligation!
        let transition = await store.getBindingTransition(plan, binding.assertionId, binding.runtimeTaskId)
        if (transition === undefined) {
          try {
            const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath)
            const criterion = plan.acceptanceCriteria.find((item) => item.id === binding.criterionId)!
            const assertion = criterion.assertions.find((item) => item.id === binding.assertionId)!
            const blueprint = await bindObligationAtCommit({ obligation, assertion, criterion,
              target: plan.targetBinding, commit: current.baselineCommit,
              reviewer: createClaudeBlueprintReviewer({ cwd: process.cwd() }),
              repairer: createClaudeBlueprintRepairer({ cwd: process.cwd() }) })
            transition = await store.bindProvisionedVerifier(plan, binding.assertionId, binding.runtimeTaskId, blueprint)
          } catch (error) { return withCheckpoint({ status: 'BLOCKED', blockers: [
            `${binding.assertionId} blueprint provisioning blocked: ${error instanceof Error ? error.message : String(error)}`] }) }
        }
        let observed: CapabilityEvidence
        try { observed = await store.collectProvisionedEvidence(plan, binding.assertionId, binding.runtimeTaskId) }
        catch (error) { return withCheckpoint({ status: 'BLOCKED',
          blockers: [`${binding.assertionId} exact verifier failed: ${error instanceof Error ? error.message : String(error)}`] }) }
        const key = pendingEvidenceKey(binding.assertionId, obligation.obligationId)
        results.push({ name: key, stepId: key, rawOutputRef: observed.id,
          ...((transition.verifier.family === 'command' || transition.verifier.family === 'scope_review') &&
            transition.verifier.command ? { command: transition.verifier.command } : {}),
          status: observed.result === 'OBSERVED' && observed.facts.observedMatch === true
          ? 'passed' : 'failed', details: JSON.stringify({ transition, evidenceId: observed.id }),
        ...(observed.facts.observedMatch === true ? {} : { classification: 'EVIDENCE_MISSING' as const }) })
      }
      for (const binding of pending.filter((item) => ['EXTERNAL_DEFERRED', 'HUMAN_DEFERRED'].includes(item.stagedVerification.readiness))) {
        const key = `NOVAWING_DEFERRED:${binding.assertionId}:${binding.stagedVerification.readiness}`
        results.push({ name: key, stepId: key, status: 'skipped',
          details: 'Completion-only customer evidence remains open.' })
      }
      if (results.length === 0) return withCheckpoint({ status: 'BLOCKED', blockers: ['No exact delivery verifier was executed.'] })
      return withCheckpoint({ status: results.some((item) => item.status === 'failed') ? 'FAILED' : 'SUCCESS', verificationResults: results })
    },
  }
}
