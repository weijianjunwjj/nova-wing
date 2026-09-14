import type { ExecutionActivityFact, GuardianPhase, GuardianProgressObserver } from '../progress.js'
import { canonicalVerificationFailure } from './task-controller.js'
import { createTaskStateV2, loadTaskStateV2, type TaskGitStateV2, type TaskStateV2 } from './task-state-v2.js'
import { assessRisk, completionGate } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
import {
  bindingsFromVerificationPlan,
  planVerification,
  validateVerificationPlanAfterExecution,
  type VerificationPlan,
} from './verification-planner.js'
import { assessDirectPathEligibility, concreteRuntimeProvider } from './direct-path.js'
import type { WorkSessionTask } from './model.js'
import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import type { WorkSessionTaskResult, WorkSessionTaskRunContext, WorkSessionTaskRunner } from './task-runner.js'
import {
  agentIdentity,
  completionEvidence,
  isConfirmedNoOp,
  NO_OP_AUTO_RETRY,
  selectAgent,
  type AgentCapabilityProfile,
  type V2ActionDispatcher,
} from './v2-controller-task-runner.js'
import { providerOf, repositoryFacts, type TaskEventV2 } from './task-observability.js'

/**
 * v0.3.0 Golden Path.
 *
 * A strictly bounded, deterministic default for ordinary LOW/MEDIUM tasks. It
 * reuses the Verification Planner, provider runtime (the V2ActionDispatcher),
 * repository inspection, deterministic verifier, evidence model and Git
 * finalizer — but it never calls the TaskController decision loop, never
 * escalates a recoverable failure, and caps every task at EXECUTE ≤ 2 and
 * VERIFY ≤ 2.
 *
 * The only two automatic recoveries are:
 *   1. EXECUTOR NO-OP — replace the stale thread once, retry EXECUTE once.
 *      A second NO-OP stops with EXECUTOR_NO_PROGRESS_AFTER_RETRY.
 *   2. CODE_FAILURE   — run one EXECUTE fix, then VERIFY once more.
 *      A second CODE_FAILURE stops with CODE_FAILURE_AFTER_SINGLE_FIX.
 *
 * Every other failure stops immediately with an explicit, human-readable
 * terminal reason. HIGH / CRITICAL risk and any other ineligible task go to the
 * legacy advanced (Controller) path via `fallbackRunner`.
 */

export interface GoldenPathEligibility {
  eligible: boolean
  reasons: readonly string[]
}

/** The canonical, human-readable terminal categories produced by the Golden Path. */
export type GoldenPathTerminal =
  | 'EXECUTOR_NO_PROGRESS_AFTER_RETRY'
  | 'CODE_FAILURE_AFTER_SINGLE_FIX'
  | 'ENVIRONMENT_REQUIRED'
  | 'VERIFIER_CONFIGURATION_REQUIRED'
  | 'UNRELATED_TEST_FAILURE'
  | 'EXECUTOR_FAILED'
  | 'SAFETY_BLOCKED'
  | 'UNKNOWN'

export interface GoldenPathTerminalResult extends WorkSessionTaskResult {
  status: 'HUMAN_REQUIRED'
  humanRequired: { category: GoldenPathTerminal; reason: string }
}

/** The result of one V2ActionDispatcher.dispatch call, including provider provenance. */
type GoldenDispatchResult = Awaited<ReturnType<V2ActionDispatcher['dispatch']>>

/**
 * Golden Path eligibility. It is the v0.2.8 fixed-protocol Direct gate plus the
 * explicit v0.3.0 contract gates (migration / security-auth / public API) for
 * distinct, human-readable reasons. Fail-closed: any failed condition disqualifies.
 */
export function assessGoldenPathEligibility(input: {
  task: TaskStateV2
  plan: VerificationPlan
  agents: readonly AgentCapabilityProfile[]
  repositoryConsistent: boolean
  providerAvailable?: boolean
  unownedDirtyChanges?: boolean
  permissionSufficient?: boolean
  knownEnvironmentBlocker?: boolean
  destructiveAction?: boolean
  independentReviewRequired?: boolean
}): GoldenPathEligibility {
  const base = assessDirectPathEligibility({ ...input })
  const { task } = input
  const contract = [task.goal, ...task.constraints, ...task.acceptanceCriteria].join(' ')
  const explicit: string[] = []
  if (/\b(?:migration|schema change|database migration)\b/iu.test(contract)) {
    explicit.push('migration contract requires the Controller safety net')
  }
  if (/\b(?:authentication|authorization|credential|security boundary|permission model)\b/iu.test(contract)) {
    explicit.push('security or auth boundary requires the Controller safety net')
  }
  if (/\b(?:public API|exported (?:surface|contract)|breaking change|compatibility)\b/iu.test(contract)) {
    explicit.push('public API compatibility change requires the Controller safety net')
  }
  if (input.destructiveAction === true || /\b(?:drop|destroy|force[ -]?push|delete\s+(?:all|database|schema))\b/iu.test(contract)) {
    explicit.push('destructive action requires Controller policy')
  }
  return { eligible: base.eligible && explicit.length === 0, reasons: [...explicit, ...base.reasons] }
}

function repositoryChangedSince(before: TaskGitStateV2, after: RepositoryReality): boolean {
  return before.headSha !== after.headSha ||
    before.worktreeFingerprint !== after.worktreeFingerprint ||
    JSON.stringify([...before.changedFiles].sort()) !== JSON.stringify([...after.changedFiles].sort())
}

/** Reuse the exact EvidenceV2 shape the completion gate and Controller expect. */
function applyGoldenVerify(state: TaskStateV2, verification: GoldenDispatchResult): TaskStateV2 {
  const results = verification.verificationResults ?? []
  const evidence = results.map((item) => ({
    type: item.name,
    status: item.status === 'passed' ? 'PASSED' as const : 'FAILED' as const,
    source: 'deterministic' as const,
    ...(state.gitState.repositoryIdentity === undefined ? {} : { repositoryIdentity: state.gitState.repositoryIdentity }),
    ...(state.gitState.branch === undefined ? {} : { branch: state.gitState.branch }),
    ...(state.gitState.headSha === undefined ? {} : { headSha: state.gitState.headSha }),
    ...(state.gitState.worktreeFingerprint === undefined ? {} : { workspaceIdentity: state.gitState.worktreeFingerprint }),
    timestamp: new Date().toISOString(),
  }))
  return {
    ...state,
    verificationState: { ...state.verificationState, results },
    completion: { ...state.completion, evidence },
    currentAction: 'VERIFY',
    status: 'ACTIVE',
    updatedAt: new Date().toISOString(),
  }
}

function applyGoldenExecute(
  state: TaskStateV2,
  agent: AgentCapabilityProfile,
  execute: GoldenDispatchResult,
  end: RepositoryReality,
  actualProvider: string | undefined,
): TaskStateV2 {
  const identity = agentIdentity(agent)
  const implementer = actualProvider === undefined ? identity : { ...identity, provider: actualProvider }
  return {
    ...state,
    gitState: { ...end },
    artifacts: [...new Set([...state.artifacts, ...(execute.changedFiles ?? end.changedFiles)])],
    currentAgent: agent.id,
    implementer,
    providerHistory: execute.providerHistory ?? (actualProvider === undefined ? state.providerHistory : [...state.providerHistory, actualProvider]),
    verificationState: { ...state.verificationState, results: [] },
    completion: { ...state.completion, review: undefined },
    currentAction: 'EXECUTE',
    status: 'ACTIVE',
    updatedAt: new Date().toISOString(),
  }
}

function goldenTerminal(input: {
  category: GoldenPathTerminal
  reason: string
  state: TaskStateV2
  executeCount: number
  verifyCount: number
  provider: string | undefined
  verifier: string | undefined
  changedFiles: readonly string[]
}): GoldenPathTerminalResult {
  const facts = [
    `provider=${input.provider ?? 'unknown'}`,
    `executeCount=${input.executeCount}`,
    `verifyCount=${input.verifyCount}`,
    `verifier=${input.verifier ?? 'deterministic'}`,
    `changedFiles=${input.changedFiles.length === 0 ? 'none' : input.changedFiles.join(',')}`,
  ]
  const state: TaskStateV2 = { ...input.state, status: 'SUSPENDED', currentAction: 'SUSPEND', updatedAt: new Date().toISOString() }
  return {
    status: 'HUMAN_REQUIRED',
    humanRequired: { category: input.category, reason: `${input.reason} [${facts.join('; ')}]` },
    taskStateV2: state,
  }
}

export interface GoldenPathTaskRunnerOptions {
  sessionId: string
  branch: string
  agents: readonly AgentCapabilityProfile[]
  dispatcher: V2ActionDispatcher
  repositoryRoot: string
  progressObserver?: GuardianProgressObserver
  /** Legacy advanced (Controller) path used for ineligible or resumed tasks. */
  fallbackRunner: WorkSessionTaskRunner
}

export class GoldenPathTaskRunner implements WorkSessionTaskRunner {
  constructor(private readonly options: GoldenPathTaskRunnerOptions) {}

  async run(
    task: WorkSessionTask,
    resumeData?: unknown,
    checkpoint?: GuardianTaskRecoveryCheckpoint,
    context?: WorkSessionTaskRunContext,
  ): Promise<WorkSessionTaskResult> {
    // The Golden Path is a fresh, strictly-bounded default. Resumed / escalated /
    // non-PENDING tasks always go through the legacy advanced path.
    if (context?.taskStateV2 !== undefined) {
      try {
        const persisted = loadTaskStateV2(context.taskStateV2)
        if (persisted.status !== 'PENDING' || persisted.execution?.escalated === true) {
          return this.options.fallbackRunner.run(task, resumeData, checkpoint, context)
        }
      } catch {
        return this.options.fallbackRunner.run(task, resumeData, checkpoint, context)
      }
    }

    const eventLog = context?.taskEventLog
    const note = (input: Omit<TaskEventV2, 'eventId' | 'taskId' | 'sessionId' | 'timestamp'>): void => {
      eventLog?.append({ taskId: task.id, sessionId: this.options.sessionId, ...input })
    }
    const emit = (phase: GuardianPhase, status: 'active' | 'completed' | 'failed', activity?: ExecutionActivityFact): void => {
      const event = { phase, status, iteration: 0, elapsedMs: 0, ...(activity === undefined ? {} : { activity }) } as const
      context?.onProgress?.(event)
      this.options.progressObserver?.(event)
    }

    let state = context?.taskStateV2 === undefined
      ? createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task)
      : loadTaskStateV2(context.taskStateV2)
    note({ type: 'TASK_CREATED', ...repositoryFacts(state) })
    emit('PLANNING', 'active', { kind: 'CONTROLLER_PHASE_CHANGED' })

    const start = await this.options.dispatcher.inspectRepository()
    const initial = reconcileTaskState(state, start)
    state = initial.state

    const plan = await planVerification({
      repositoryRoot: this.options.repositoryRoot,
      task,
      risk: assessRisk(state).level,
      ...(task.allowedPaths === undefined ? {} : { changedAreaHint: task.allowedPaths }),
    })
    state = {
      ...state,
      verificationPlan: plan,
      completion: { ...state.completion, bindings: bindingsFromVerificationPlan(plan) },
      execution: { path: 'GOLDEN', escalated: false, startCheckpoint: { ...state.gitState } },
      updatedAt: new Date().toISOString(),
    }
    note({ type: 'VERIFICATION_PLANNED', ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command), metadata: { planId: plan.planId, fingerprint: plan.fingerprint, confidence: plan.confidence, scope: plan.estimatedScope } })
    await context?.persistTaskStateV2?.(state)

    if (plan.confidence === 'INSUFFICIENT') {
      state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND' }
      note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', ...repositoryFacts(state), metadata: { reason: 'verification planning requires human evidence selection' } })
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'PLANNING_REQUIRED', reason: 'no trustworthy task-local or package-local verifier; root-suite fallback is forbidden' }, taskStateV2: state }
    }

    const eligibility = assessGoldenPathEligibility({
      task: state,
      plan,
      agents: this.options.agents,
      repositoryConsistent: initial.reconciled,
      unownedDirtyChanges: start.changedFiles.length > 0,
    })
    if (!eligibility.eligible) {
      state = { ...state, execution: { ...state.execution!, path: 'CONTROLLER', escalated: true } }
      note({ type: 'DIRECT_PATH_ESCALATED', ...repositoryFacts(state), metadata: { stage: 'ELIGIBILITY', reasons: eligibility.reasons } })
      await context?.persistTaskStateV2?.(state)
      return this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: state })
    }

    const agent = selectAgent('EXECUTE', this.options.agents)
    if (agent === undefined) {
      state = { ...state, execution: { ...state.execution!, path: 'CONTROLLER', escalated: true } }
      return this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: state })
    }

    let executeCount = 0
    let verifyCount = 0
    const routeProvider = concreteRuntimeProvider(providerOf(agent))

    const dispatchExecute = async (retry?: { reason: 'NO_OP_EXECUTION'; instruction: string }): Promise<{ result: GoldenDispatchResult; end: RepositoryReality }> => {
      executeCount += 1
      note({
        type: 'AGENT_DISPATCHED', action: 'EXECUTE', agent: agent.id,
        ...(routeProvider === undefined ? {} : { provider: routeProvider }), ...repositoryFacts(state),
        ...(retry === undefined ? {} : { metadata: { reason: retry.reason, autoRetry: true, attempt: executeCount } }),
      })
      emit('EXECUTING', 'active', { kind: 'PROVIDER_DISPATCHED', ...(routeProvider === undefined ? {} : { provider: routeProvider }) })
      const result = await this.options.dispatcher.dispatch({ action: 'EXECUTE', agent: structuredClone(agent), task: structuredClone(state), ...(retry === undefined ? {} : { retry }) })
      const end = await this.options.dispatcher.inspectRepository()
      return { result, end }
    }

    let execute = await dispatchExecute()
    let end = execute.end
    let changed = repositoryChangedSince(start, end)
    if (isConfirmedNoOp(execute.result, changed)) {
      emit('EXECUTING', 'failed', { kind: 'PROVIDER_FAILED', ...(routeProvider === undefined ? {} : { provider: routeProvider }), outcome: 'FAILED' })
      const retry = await dispatchExecute(NO_OP_AUTO_RETRY)
      execute = retry
      end = retry.end
      changed = repositoryChangedSince(start, end)
      if (isConfirmedNoOp(execute.result, changed)) {
        const actualProvider = execute.result.providerHistory?.at(-1) ?? routeProvider
        state = { ...state, gitState: { ...end }, currentAction: 'EXECUTE' }
        note({ type: 'TASK_FAILED', action: 'EXECUTE', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { reason: 'EXECUTOR_NO_PROGRESS_AFTER_RETRY', executeCount, verifyCount } })
        await context?.persistTaskStateV2?.(state)
        return goldenTerminal({ category: 'EXECUTOR_NO_PROGRESS_AFTER_RETRY', reason: 'Executor produced no repository change after the automatic retry; stopping instead of escalating.', state, executeCount, verifyCount, provider: actualProvider, verifier: plan.planId, changedFiles: end.changedFiles })
      }
    }

    const actualProvider = execute.result.providerHistory?.at(-1) ?? routeProvider
    state = applyGoldenExecute(state, agent, execute.result, end, actualProvider)
    note({ type: execute.result.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', action: 'EXECUTE', agent: agent.id, ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state) })
    emit('EXECUTING', execute.result.status === 'SUCCESS' ? 'completed' : 'failed', { kind: execute.result.status === 'SUCCESS' ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: execute.result.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED' })
    await context?.persistTaskStateV2?.(state)

    if (execute.result.status !== 'SUCCESS') {
      note({ type: 'TASK_FAILED', action: 'EXECUTE', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { executeCount, verifyCount } })
      return goldenTerminal({ category: 'EXECUTOR_FAILED', reason: execute.result.blockers?.[0] ?? execute.result.summary ?? 'execution failed without a no-op signal', state, executeCount, verifyCount, provider: actualProvider, verifier: plan.planId, changedFiles: end.changedFiles })
    }

    const riskBefore = assessRisk({ ...state, gitState: { ...state.gitState, changedFiles: [] } }).level
    const riskAfter = assessRisk(state).level
    const planValidity = validateVerificationPlanAfterExecution({ plan, changedFiles: end.changedFiles, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths, riskBefore, riskAfter })
    if (!planValidity.valid) {
      state = { ...state, blockers: [...new Set([...state.blockers, ...planValidity.reasons])] }
      note({ type: 'TASK_FAILED', action: 'EXECUTE', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { reasons: planValidity.reasons, executeCount, verifyCount } })
      return goldenTerminal({ category: 'SAFETY_BLOCKED', reason: `execution crossed a safety boundary: ${planValidity.reasons.join('; ')}`, state, executeCount, verifyCount, provider: actualProvider, verifier: plan.planId, changedFiles: end.changedFiles })
    }

    const verifyOnce = async (): Promise<void> => {
      verifyCount += 1
      note({ type: 'VERIFICATION_STARTED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command) })
      emit('VERIFYING', 'active', { kind: 'VERIFIER_STARTED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId })
      const result = await this.options.dispatcher.dispatch({ action: 'VERIFY', agent: structuredClone(agent), task: structuredClone(state) })
      state = applyGoldenVerify(state, result)
    }

    const passedNow = (): boolean => state.verificationState.results.length > 0 && state.verificationState.results.every((item) => item.status === 'passed')

    await verifyOnce()
    let passed = passedNow()
    note({ type: passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: state.verificationState.results.map((item) => item.name) })
    emit('VERIFYING', passed ? 'completed' : 'failed', { kind: 'VERIFIER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId, outcome: passed ? 'PASSED' : 'FAILED' })
    await context?.persistTaskStateV2?.(state)

    if (!passed) {
      const firstFailed = state.verificationState.results.find((item) => item.status === 'failed')
      const classification = canonicalVerificationFailure(firstFailed?.classification)
      note({ type: 'VERIFICATION_CLASSIFIED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { classification, verifier: firstFailed?.name, executeCount, verifyCount } })

      if (classification === 'CODE_FAILURE') {
        if (executeCount >= 2) {
          return goldenTerminal({ category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'deterministic CODE_FAILURE remains and the EXECUTE bound is already spent; stopping instead of a third EXECUTE.', state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
        }
        const fix = await dispatchExecute()
        const fixChanged = repositoryChangedSince(state.gitState, fix.end)
        state = applyGoldenExecute(state, agent, fix.result, fix.end, actualProvider)
        note({ type: fix.result.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', action: 'EXECUTE', agent: agent.id, ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state) })
        emit('EXECUTING', fix.result.status === 'SUCCESS' ? 'completed' : 'failed', { kind: fix.result.status === 'SUCCESS' ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: fix.result.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED' })
        await context?.persistTaskStateV2?.(state)
        if (fix.result.status !== 'SUCCESS' || (!fixChanged && fix.result.implementationEvidenceAdded !== true)) {
          note({ type: 'NO_IMPLEMENTATION_PROGRESS', action: 'EXECUTE', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { repoChanged: fixChanged, executeCount, verifyCount, originalFailureClassification: classification, verifier: firstFailed?.name } })
          return goldenTerminal({ category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'the single CODE_FAILURE fix produced no repository or implementation-evidence progress; stopping instead of a third EXECUTE.', state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
        }
        const fixRisk = assessRisk(state).level
        const fixValidity = validateVerificationPlanAfterExecution({ plan, changedFiles: fix.end.changedFiles, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths, riskBefore, riskAfter: fixRisk })
        if (!fixValidity.valid) {
          state = { ...state, blockers: [...new Set([...state.blockers, ...fixValidity.reasons])] }
          return goldenTerminal({ category: 'SAFETY_BLOCKED', reason: `fix crossed a safety boundary: ${fixValidity.reasons.join('; ')}`, state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
        }
        await verifyOnce()
        passed = passedNow()
        note({ type: passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: state.verificationState.results.map((item) => item.name) })
        emit('VERIFYING', passed ? 'completed' : 'failed', { kind: 'VERIFIER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId, outcome: passed ? 'PASSED' : 'FAILED' })
        await context?.persistTaskStateV2?.(state)
        if (!passed) {
          const secondFailed = state.verificationState.results.find((item) => item.status === 'failed')
          const secondClassification = canonicalVerificationFailure(secondFailed?.classification)
          if (secondClassification === 'ENVIRONMENT_FAILURE') return goldenTerminal({ category: 'ENVIRONMENT_REQUIRED', reason: 'verification requires an unavailable environment or runtime.', state, executeCount, verifyCount, provider: actualProvider, verifier: secondFailed?.name, changedFiles: state.gitState.changedFiles })
          if (secondClassification === 'VERIFIER_CONFIGURATION_FAILURE') return goldenTerminal({ category: 'VERIFIER_CONFIGURATION_REQUIRED', reason: 'verifier or Task Contract configuration requires repair.', state, executeCount, verifyCount, provider: actualProvider, verifier: secondFailed?.name, changedFiles: state.gitState.changedFiles })
          if (secondClassification === 'UNRELATED_TEST_FAILURE') return goldenTerminal({ category: 'UNRELATED_TEST_FAILURE', reason: 'an audited pre-existing failure is unrelated to the Task; task-local disposition is required.', state, executeCount, verifyCount, provider: actualProvider, verifier: secondFailed?.name, changedFiles: state.gitState.changedFiles })
          return goldenTerminal({ category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'deterministic CODE_FAILURE remains after the single allowed fix; stopping.', state, executeCount, verifyCount, provider: actualProvider, verifier: secondFailed?.name, changedFiles: state.gitState.changedFiles })
        }
      } else if (classification === 'ENVIRONMENT_FAILURE') {
        return goldenTerminal({ category: 'ENVIRONMENT_REQUIRED', reason: 'verification requires an unavailable environment or runtime.', state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
      } else if (classification === 'VERIFIER_CONFIGURATION_FAILURE') {
        return goldenTerminal({ category: 'VERIFIER_CONFIGURATION_REQUIRED', reason: 'verifier or Task Contract configuration requires repair.', state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
      } else if (classification === 'UNRELATED_TEST_FAILURE') {
        return goldenTerminal({ category: 'UNRELATED_TEST_FAILURE', reason: 'an audited pre-existing failure is unrelated to the Task; task-local disposition is required.', state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
      } else {
        return goldenTerminal({ category: 'UNKNOWN', reason: 'verification failure cannot be safely attributed to the Task implementation.', state, executeCount, verifyCount, provider: actualProvider, verifier: firstFailed?.name, changedFiles: state.gitState.changedFiles })
      }
    }

    const risk = assessRisk(state)
    if (!completionGate({ task: state, ...state.completion, risk })) {
      return goldenTerminal({ category: 'UNKNOWN', reason: 'the completion gate did not pass despite passing verifiers; stopping.', state, executeCount, verifyCount, provider: actualProvider, verifier: plan.planId, changedFiles: state.gitState.changedFiles })
    }

    emit('FINALIZING', 'active', { kind: 'CONTROLLER_PHASE_CHANGED' })
    state = { ...state, status: 'COMPLETED', currentAction: 'COMPLETE', blockers: [], updatedAt: new Date().toISOString() }
    note({ type: 'TASK_COMPLETED', action: 'COMPLETE', ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command), metadata: { executionPath: 'GOLDEN', outcome: state.gitState.changedFiles.length === 0 ? 'ALREADY_SATISFIED' : 'COMPLETED' } })
    await context?.persistTaskStateV2?.(state)
    emit('COMPLETED', 'completed', { kind: 'PROVIDER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: 'COMPLETED' })
    return { status: 'COMPLETED', taskStateV2: state, completionEvidence: completionEvidence(state, state.verificationState.results) }
  }
}
