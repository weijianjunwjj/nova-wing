import type { V2ActionDispatcher } from '../work-session/v2-controller-task-runner.js'
import type { CompiledRuntimePlan } from './runtime-plan.js'
import type { DeliveryStore } from './service.js'
import type { CapabilityEvidence } from './capability-layer.js'
import { CAPABILITY_REGISTRY, type ProviderAvailability } from './capability-layer.js'
import { inspectDeliveryTarget, workSessionDefinitionFor } from './runtime-plan.js'
import { bindObligationAtCommit, createClaudeBlueprintReviewer, createClaudeBlueprintRepairer, type BlueprintReviewer, type BlueprintRepairer } from './verification-blueprint-planner.js'
import { taskCompletionGate, type AssertionCompletionEvidence, type VerificationBindingTransition } from './staged-verification.js'
import { checkpointOwnedImplementation } from '../work-session/owned-checkpoint.js'
import { completionGate, assessRisk, reviewSatisfied } from '../work-session/risk-evidence.js'
import { verificationPlanFingerprintValid } from '../work-session/verification-planner.js'
import { randomUUID } from 'node:crypto'
import { inspectAtCommit } from './repo-capability-inspector.js'

export function pendingEvidenceKey(assertionId: string, obligationId: string): string {
  return `NOVAWING_VERIFICATION_PENDING:${assertionId}:${obligationId}`
}

/** The trusted V2 seam keeps development possible and completion fail closed until a verifier is bound. */
export function createDeliveryRuntimeDispatcher(plan: CompiledRuntimePlan, store: DeliveryStore,
  defaultDispatcher: V2ActionDispatcher,
  providerAvailability?: (providerId: string) => ProviderAvailability,
  blueprintReview?: { reviewer: BlueprintReviewer; repairer?: BlueprintRepairer }): V2ActionDispatcher {
  const completionProofs = new Map<string, { transitions: VerificationBindingTransition[];
    evidence: AssertionCompletionEvidence[] }>()
  const contributionProofs = new Set<string>()
  const contributor = (taskId: string): boolean =>
    plan.acceptanceBindings.some((binding) => binding.runtimeTaskId === taskId && binding.blocking && binding.ownership === 'CONTRIBUTES') &&
    !plan.acceptanceBindings.some((binding) => binding.runtimeTaskId === taskId && binding.blocking && binding.ownership === 'OWNER')
  return {
    inspectRepository: () => defaultDispatcher.inspectRepository(),
    async deliveryCompletionGate(task) {
      completionProofs.delete(task.identity.taskId)
      contributionProofs.delete(task.identity.taskId)
      const bindings = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === task.identity.taskId &&
        item.blocking && item.ownership === 'OWNER')
      const transitions: VerificationBindingTransition[] = []
      const evidence: AssertionCompletionEvidence[] = []
      const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath).catch(() => undefined)
      if (!current?.clean) return { status: 'BLOCKED', reason: 'Implementation repository is not clean.' }
      if (bindings.length === 0 && contributor(task.identity.taskId)) {
        const source = plan.tasks.find((item) => item.id === task.identity.taskId)
        const expectedCriteria = source?.outputs.map((output, index) => `TechnicalOutput ${task.identity.taskId}/${index + 1}: ${output}`)
        const verification = task.verificationPlan
        if (!source || !expectedCriteria?.length || JSON.stringify(task.acceptanceCriteria) !== JSON.stringify(expectedCriteria) ||
          task.goal !== source.objective || !verification || !verificationPlanFingerprintValid(verification) ||
          verification.confidence !== 'HIGH' || !verification.steps.some((step) => step.id === 'targeted-test' || step.id === 'package-test') ||
          verification.steps.some((step) => step.admission !== 'ALLOWED') ||
          task.verificationState.results.length < verification.steps.length ||
          !verification.steps.every((step) => task.verificationState.results.some((result) => result.stepId === step.id && result.status === 'passed')) ||
          task.completion.review?.assertionVerdicts?.length || !reviewSatisfied(task) ||
          !completionGate({ task, ...task.completion, risk: assessRisk(task) }) ||
          task.gitState.headSha !== current.baselineCommit ||
          (task.taskBaseCommit !== current.baselineCommit && !task.ownedCheckpoints?.some((checkpoint) =>
            checkpoint.after.headSha === current.baselineCommit)))
          return { status: 'BLOCKED', reason: 'Contributor technical verification, checkpoint or independent review is incomplete.' }
        if (task.taskBaseCommit === current.baselineCommit) {
          const noOp = task.contributorNoOp
          const facts = noOp ? await inspectAtCommit(plan.targetBinding, current.baselineCommit).catch(() => undefined) : undefined
          if (!noOp || noOp.headSha !== current.baselineCommit || !noOp.reason.trim() ||
            !noOp.files.length || !facts || noOp.files.some((file) => facts.artifactHashes[file.path] !== file.sha256))
            return { status: 'BLOCKED', reason: 'Contributor ALREADY_SATISFIED lacks exact host-observed file proof.' }
        }
        contributionProofs.add(task.identity.taskId)
        return { status: 'CONTRIBUTION_VERIFIED' }
      }
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
      if (!proof && !contributionProofs.has(task.identity.taskId)) throw new Error('Task has no current delivery completion proof.')
    },
    async deliveryTaskFinalized(task, commitSha) {
      const proof = completionProofs.get(task.identity.taskId)
      if (!proof && !contributionProofs.has(task.identity.taskId)) throw new Error('Finalized Task has no current delivery completion proof.')
      const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath)
      if (!current.clean || current.baselineCommit !== commitSha)
        throw new Error('Finalized Task implementation commit changed.')
      if (proof) await store.recordLocalTaskCompletion(plan, task.identity.taskId, proof.transitions, proof.evidence)
      else await store.recordContributorTaskCompletion(plan, task, commitSha)
      completionProofs.delete(task.identity.taskId)
      contributionProofs.delete(task.identity.taskId)
    },
    async dispatch(input) {
      const expected = workSessionDefinitionFor(plan, input.task.identity.sessionId).tasks.find((task) => task.id === input.task.identity.taskId)
      if (!expected || input.task.goal !== expected.goal ||
        JSON.stringify(input.task.constraints) !== JSON.stringify(expected.constraints) ||
        JSON.stringify(input.task.acceptanceCriteria) !== JSON.stringify(expected.acceptanceCriteria) ||
        JSON.stringify(input.task.permissions.allowedPaths) !== JSON.stringify(expected.allowedPaths) ||
        !(expected.forbiddenPaths ?? []).every((path) => input.task.permissions.forbiddenPaths.includes(path))) {
        return { status: 'BLOCKED', blockers: ['GOVERNANCE_DRIFT: runtime task differs from its frozen execution contract.'] }
      }
      const bindings = plan.acceptanceBindings.filter((item) => item.runtimeTaskId === input.task.identity.taskId &&
        item.blocking && item.ownership === 'OWNER')
      if (bindings.length === 0 && contributor(input.task.identity.taskId)) {
        if (input.action === 'EXECUTE') {
          const sanitized = { ...input.task, completion: { ...input.task.completion,
            bindings: input.task.completion.bindings.map((item) => ({ ...item,
              requiredEvidence: item.requiredEvidence.filter((value) => !value.startsWith('NOVAWING_TECHNICAL_PENDING:')) })) } }
          return defaultDispatcher.dispatch({ ...input, task: sanitized })
        }
        if (input.action === 'VERIFY') {
          if (!input.task.verificationPlan || !verificationPlanFingerprintValid(input.task.verificationPlan))
            return { status: 'BLOCKED', blockers: ['Contributor verification plan is unavailable.'] }
          try {
            if (!input.implementationCheckpoint && input.task.gitState.changedFiles.length)
              throw new Error('OWNED_CHECKPOINT_HANDOFF_REQUIRED')
            const task = await checkpointOwnedImplementation({ task: input.task, baselineCommit: plan.targetBaselineCommit,
              inspect: () => defaultDispatcher.inspectRepository(),
              handoff: input.implementationCheckpoint ?? { dispatchId: randomUUID(),
                accept: async () => { throw new Error('OWNED_CHECKPOINT_HANDOFF_REQUIRED') } } })
            return defaultDispatcher.dispatch({ ...input, task })
          } catch (error) { return { status: 'BLOCKED', blockers: [
            `IMPLEMENTATION_CHECKPOINT_BLOCKED: ${error instanceof Error ? error.message : String(error)}`] } }
        }
        return defaultDispatcher.dispatch(input)
      }
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
      try {
        if (input.task.gitState.repositoryIdentity !== plan.targetBinding.canonicalPath ||
          input.task.gitState.branch !== plan.targetBinding.branch)
          throw new Error('OWNED_CHECKPOINT_TARGET_BINDING_MISMATCH')
        if (!input.implementationCheckpoint && input.task.gitState.changedFiles.length)
          throw new Error('OWNED_CHECKPOINT_HANDOFF_REQUIRED')
        const task = await checkpointOwnedImplementation({ task: input.task, baselineCommit: plan.targetBaselineCommit,
          inspect: () => defaultDispatcher.inspectRepository(),
          handoff: input.implementationCheckpoint ?? { dispatchId: randomUUID(),
            accept: async () => { throw new Error('OWNED_CHECKPOINT_HANDOFF_REQUIRED') } } })
        input = { ...input, task }
      } catch (error) { return { status: 'BLOCKED', blockers: [
        `IMPLEMENTATION_CHECKPOINT_BLOCKED: ${error instanceof Error ? error.message : String(error)}`] } }
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
        const obligation = binding.stagedVerification.obligation!
        let transition = await store.getBindingTransition(plan, binding.assertionId, binding.runtimeTaskId)
        if (transition === undefined) {
          try {
            const current = await inspectDeliveryTarget(plan.targetBinding.canonicalPath)
            const criterion = plan.acceptanceCriteria.find((item) => item.id === binding.criterionId)!
            const assertion = criterion.assertions.find((item) => item.id === binding.assertionId)!
            const blueprint = await bindObligationAtCommit({ obligation, assertion, criterion,
              target: plan.targetBinding, commit: current.baselineCommit,
              reviewer: blueprintReview?.reviewer ?? createClaudeBlueprintReviewer({ cwd: process.cwd() }),
              ...(blueprintReview ? (blueprintReview.repairer ? { repairer: blueprintReview.repairer } : {})
                : { repairer: createClaudeBlueprintRepairer({ cwd: process.cwd() }) }) })
            transition = await store.bindProvisionedVerifier(plan, binding.assertionId, binding.runtimeTaskId, blueprint)
          } catch (error) { return { status: 'BLOCKED', blockers: [
            `${binding.assertionId} blueprint provisioning blocked: ${error instanceof Error ? error.message : String(error)}`] } }
        }
        let observed: CapabilityEvidence
        try { observed = await store.collectProvisionedEvidence(plan, binding.assertionId, binding.runtimeTaskId) }
        catch (error) { return { status: 'BLOCKED',
          blockers: [`${binding.assertionId} exact verifier failed: ${error instanceof Error ? error.message : String(error)}`] } }
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
      if (results.length === 0) return { status: 'BLOCKED', blockers: ['No exact delivery verifier was executed.'] }
      return { status: results.some((item) => item.status === 'failed') ? 'FAILED' : 'SUCCESS', verificationResults: results }
    },
  }
}
