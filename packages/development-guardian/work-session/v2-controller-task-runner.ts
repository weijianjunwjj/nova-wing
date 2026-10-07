import type { VerificationResult } from '../model.js'
import { implementationCheckpointHandoff } from './implementation-checkpoint.js'
import { canonicalVerificationFailure, TaskController, type TaskAction, type TaskActionResult } from './task-controller.js'
import { verifierEvidenceFromBindings } from './completion-criteria.js'
import { createTaskStateV2, loadTaskStateV2, type TaskActorIdentity, type TaskStateV2 } from './task-state-v2.js'
import { approvalContext, assessRisk, completionGate, type ApprovalEvidence, type ReviewEvidence } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
import { VERIFICATION_APPROVAL_BLOCKER } from './verification-approval.js'
import { scopeBlockers } from '../claude-code-executor.js'
import { isIndependentReviewerCandidate } from './reviewer-runtime.js'
import { RECOVERY_ACTION_BUDGET } from './autonomous-diagnosis.js'
import type { WorkSessionTask } from './model.js'
import type { WorkSessionTaskResult, WorkSessionTaskRunContext, WorkSessionTaskRunner } from './task-runner.js'
import type { GuardianPhase, GuardianProgressObserver } from '../progress.js'
import { assessDirectPathEligibility, concreteRuntimeProvider, phaseForAction } from './direct-path.js'
import { bindingsFromVerificationPlan, planVerification, validateVerificationPlanAfterExecution, verificationPlanFingerprintValid } from './verification-planner.js'
import {
  deriveProviderSwitches,
  dispatchMessage,
  providerOf,
  providerSwitchReasonCode,
  repositoryFacts,
  selectionReasonCode,
  ProviderHealthRegistry,
  type DecisionReasonCode,
  type DispatchExplanation,
  type ProviderHealthObservation,
  type TaskEventType,
  type TaskEventV2,
} from './task-observability.js'

export interface AgentCapabilityProfile {
  id: string
  /** Semantic and runtime identity are separately persisted for HIGH review. */
  identity?: TaskActorIdentity
  capabilities: Readonly<{
    coding?: boolean; reasoning?: boolean; review?: boolean; repoNavigation?: boolean; debugging?: boolean; verification?: boolean
  }>
  available: boolean
  quotaExhausted: boolean
  degraded: boolean
}

export function agentIdentity(agent: AgentCapabilityProfile): TaskActorIdentity {
  return agent.identity ?? { agent: agent.id, provider: agent.id, runtimeIdentity: agent.id }
}

/**
 * A dispatcher-originated review is trusted only when it names the exact
 * reviewer the Controller selected. The selected agent's identity is the only
 * trusted runtime identity; a dispatcher may not self-assert a different one.
 */
function trustedReviewEvidence(
  action: TaskAction,
  selected: AgentCapabilityProfile,
  review: ReviewEvidence | undefined,
): ReviewEvidence | undefined {
  if (action !== 'REVIEW' || review === undefined) return undefined
  const identity = agentIdentity(selected)
  if (
    review.reviewer.agent !== identity.agent ||
    review.reviewer.provider !== identity.provider ||
    review.reviewer.runtimeIdentity !== identity.runtimeIdentity
  ) return undefined
  return review
}

export interface V2StructuredHandoff {
  task: TaskStateV2
  action: TaskAction
  reason: string
}

export interface V2ActionDispatcher {
  dispatch(input: { action: TaskAction; agent: AgentCapabilityProfile; task: TaskStateV2; handoff?: V2StructuredHandoff; approvedVerificationCommand?: string; retry?: NoOpExecutionRetry; recoveryInstructions?: readonly string[];
    checkpointImplementation?: (baselineCommit: string) => Promise<TaskStateV2> }): Promise<TaskActionResult & { review?: ReviewEvidence; approval?: ApprovalEvidence; providerHistory?: readonly string[]; providerHealth?: readonly ProviderHealthObservation[]; providerFailure?: ReviewerProviderFailure }>
  /** Production V2 has no agent-reported-repository fallback. */
  inspectRepository(): Promise<RepositoryReality>
  /** Delivery-only durable assertion gate, checked immediately before Task finalization. */
  deliveryCompletionGate?(task: TaskStateV2): Promise<{ status: 'LOCALLY_VERIFIED' | 'BLOCKED'; reason?: string }>
  deliveryTaskCompleted?(task: TaskStateV2): Promise<void>
  deliveryTaskFinalized?(task: TaskStateV2, commitSha: string): Promise<void>
}

function locallyPassingVerificationResults(results: readonly VerificationResult[]): boolean {
  return results.length > 0 && results.every((item) => item.status === 'passed' ||
    (item.status === 'skipped' && item.stepId?.startsWith('NOVAWING_DEFERRED:')))
}

export interface NoOpExecutionRetry {
  reason: 'NO_OP_EXECUTION'
  instruction: string
}

export const NO_OP_AUTO_RETRY: NoOpExecutionRetry = {
  reason: 'NO_OP_EXECUTION',
  instruction: 'Automatic no-op retry: before deciding whether work is needed, use the workspace tools to inspect git status and the relevant repository files. A verbal claim that the task is already satisfied is not evidence. If no edit is needed, still inspect repository reality; deterministic verification runs separately.',
}

/**
 * REVIEW keeps the stable `no available agent for REVIEW` token: Runtime Repair
 * derives NO_AVAILABLE_AGENT_FOR_REVIEW from exactly this text. The operator-facing
 * explanation is appended, it never replaces the machine-readable token.
 */
const REVIEWER_UNAVAILABLE_REASON =
  'no available agent for REVIEW — Independent reviewer unavailable / 未配置独立 Reviewer（本机没有可用的独立 reviewer provider 路由）。'

function noAvailableAgentReason(action: TaskAction): string {
  return action === 'REVIEW' ? REVIEWER_UNAVAILABLE_REASON : `no available agent for ${action}`
}

export function isConfirmedNoOp(result: TaskActionResult, repositoryChanged: boolean): boolean {
  return !repositoryChanged && result.status !== 'SUCCESS' &&
    result.blockers?.some((blocker) => blocker.startsWith('NO_OP_EXECUTION:')) === true
}

/** A reviewer runtime failure: an environment problem, never a verdict on the implementation. */
export interface ReviewerProviderFailure {
  provider: string
  status: 'AVAILABLE' | 'DEGRADED' | 'QUOTA_EXHAUSTED' | 'TIMEOUT' | 'OFFLINE'
  reason: string
}

function requiredCapability(action: TaskAction): keyof AgentCapabilityProfile['capabilities'] | undefined {
  if (action === 'EXECUTE') return 'coding'
  if (action === 'VERIFY') return 'verification'
  if (action === 'REVIEW') return 'review'
  if (action === 'ANALYZE') return 'reasoning'
  return undefined
}

/** REVIEW deliberately excludes its implementer; other actions prefer continuity. */
export function selectAgent(
  action: TaskAction,
  profiles: readonly AgentCapabilityProfile[],
  currentAgent?: string,
): AgentCapabilityProfile | undefined {
  const capability = requiredCapability(action)
  const usable = (profile: AgentCapabilityProfile) => profile.available && !profile.quotaExhausted && !profile.degraded &&
    (capability === undefined || profile.capabilities[capability] === true)
  const current = profiles.find((profile) => profile.id === currentAgent)
  if (action === 'REVIEW') return profiles.find((profile) => profile.id !== currentAgent && usable(profile))
  return current !== undefined && usable(current) ? current : profiles.find(usable)
}

export function createStructuredHandoff(task: TaskStateV2, action: TaskAction, reason: string): V2StructuredHandoff {
  return { task, action, reason }
}

/** Appends a provider to the history only when it is a real change; continuity stays a single entry. */
function appendProviderHistory(history: readonly string[], provider: string): readonly string[] {
  return history.length > 0 && history[history.length - 1] === provider ? history : [...history, provider]
}

const MAX_NO_PROGRESS_REPEATS = 2
const CONVERGENCE_HISTORY_LIMIT = 12

function semanticProgressKey(task: TaskStateV2, health: ProviderHealthRegistry): string {
  return JSON.stringify({
    goal: task.goal,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    permissions: task.permissions,
    progress: task.progress,
    decisions: task.decisions,
    assumptions: task.assumptions,
    openQuestions: task.openQuestions,
    artifacts: task.artifacts,
    gitState: task.gitState,
    verificationResults: task.verificationState.results,
    completion: {
      bindings: task.completion.bindings,
      evidence: task.completion.evidence.map(({ timestamp: _timestamp, ...evidence }) => evidence),
      review: task.completion.review,
      approval: task.completion.approval,
    },
    providerHistory: task.providerHistory,
    currentAgent: task.currentAgent,
    implementer: task.implementer,
    currentAction: task.currentAction,
    risk: task.risk,
    status: task.status,
    blockers: task.blockers,
    providerHealth: Object.fromEntries(Object.entries(health.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([provider, observation]) => {
      const { observedAt: _observedAt, ...stable } = observation
      return [provider, stable]
    })),
  })
}

function convergenceRealityKey(task: TaskStateV2, health?: ProviderHealthRegistry): string {
  return JSON.stringify({
    repositoryIdentity: task.gitState.repositoryIdentity,
    headSha: task.gitState.headSha,
    worktreeFingerprint: task.gitState.worktreeFingerprint,
    changedFiles: task.gitState.changedFiles,
    progress: task.progress,
    evidenceGap: task.verificationState.results.map((result) => ({ name: result.name, status: result.status, classification: result.classification })),
    evidence: task.completion.evidence.map(({ timestamp: _timestamp, ...evidence }) => evidence),
    currentAgent: task.currentAgent,
    providerHistory: task.providerHistory,
    providerHealth: health === undefined ? undefined : Object.fromEntries(Object.entries(health.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([provider, observation]) => {
      const { observedAt: _observedAt, ...stable } = observation
      return [provider, stable]
    })),
  })
}

/** Detect a repeated 1-3 decision cycle only while every repository/evidence reality key is unchanged. */
export function detectCyclicNoProgress(history: readonly { decisionKey: string; realityKey: string }[]): { pattern: readonly string[]; cycles: number } | undefined {
  for (let length = 1; length <= 3; length++) {
    const required = length * 2
    if (history.length < required) continue
    const tail = history.slice(-required)
    if (!tail.every((entry) => entry.realityKey === tail[0]!.realityKey)) continue
    const first = tail.slice(0, length).map((entry) => entry.decisionKey)
    const second = tail.slice(length).map((entry) => entry.decisionKey)
    if (first.every((key, index) => key === second[index])) return { pattern: first, cycles: 2 }
  }
  return undefined
}

/**
 * V2 execution entry point. It owns the action loop; Guardian remains usable
 * separately through GuardianWorkSessionTaskRunner for V1 compatibility.
 */
export class V2ControllerTaskRunner implements WorkSessionTaskRunner {
  constructor(private readonly options: {
    sessionId: string
    branch: string
    agents: readonly AgentCapabilityProfile[]
    dispatcher: V2ActionDispatcher
    controller?: TaskController
    maxActions?: number
    progressObserver?: GuardianProgressObserver
    directPath?: { enabled: boolean; repositoryRoot: string }
  }) {}

  async afterRuntimeTaskFinalized(task: TaskStateV2, commitSha: string): Promise<void> {
    await this.options.dispatcher.deliveryTaskFinalized?.(task, commitSha)
  }

  async run(task: WorkSessionTask, resumeData?: unknown, _checkpoint?: unknown, context?: WorkSessionTaskRunContext): Promise<WorkSessionTaskResult> {
    if (this.options.directPath?.enabled !== true || context?.taskStateV2?.execution?.escalated === true || context?.taskStateV2?.status !== undefined && context.taskStateV2.status !== 'PENDING') {
      return this.runController(task, resumeData, _checkpoint, context)
    }
    const direct = await this.runDirect(task, context)
    if (direct.result !== undefined) return direct.result
    return this.runController(task, resumeData, _checkpoint, { ...context, ...(direct.escalationState === undefined ? {} : { taskStateV2: direct.escalationState }) })
  }

  private async runDirect(task: WorkSessionTask, context?: WorkSessionTaskRunContext): Promise<{ result?: WorkSessionTaskResult; escalationState?: TaskStateV2 }> {
    const controller = this.options.controller ?? new TaskController()
    const eventLog = context?.taskEventLog
    const note = (input: Omit<TaskEventV2, 'eventId' | 'taskId' | 'sessionId' | 'timestamp'>): void => { eventLog?.append({ taskId: task.id, sessionId: this.options.sessionId, ...input }) }
    const emit = (phase: GuardianPhase, status: 'active' | 'completed' | 'failed', activity?: import('../progress.js').ExecutionActivityFact): void => {
      const event = { phase, status, iteration: 0, elapsedMs: 0, ...(activity === undefined ? {} : { activity }) } as const
      context?.onProgress?.(event); this.options.progressObserver?.(event)
    }
    let state = createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task)
    if (context?.taskStateV2 !== undefined) {
      try { state = loadTaskStateV2(context.taskStateV2) } catch { return { result: { status: 'HUMAN_REQUIRED', humanRequired: { category: 'RECOVERY_BLOCKED', reason: 'invalid persisted TaskStateV2' } } } }
    }
    note({ type: 'TASK_CREATED', ...repositoryFacts(state) })
    emit('PLANNING', 'active', { kind: 'CONTROLLER_PHASE_CHANGED' })
    const start = await this.options.dispatcher.inspectRepository()
    const initial = reconcileTaskState(state, start)
    state = initial.state
    const plan = await planVerification({ repositoryRoot: this.options.directPath!.repositoryRoot, task, risk: assessRisk(state).level, ...(task.allowedPaths === undefined ? {} : { changedAreaHint: task.allowedPaths }) })
    state = { ...state, verificationPlan: plan, completion: { ...state.completion, bindings: bindingsFromVerificationPlan(plan, { identity: 'step' }) },
      execution: { path: 'DIRECT', escalated: false, startCheckpoint: { ...state.gitState } }, updatedAt: new Date().toISOString() }
    note({ type: 'VERIFICATION_PLANNED', ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command), metadata: { planId: plan.planId, fingerprint: plan.fingerprint, confidence: plan.confidence, scope: plan.estimatedScope } })
    await context?.persistTaskStateV2?.(state)
    if (plan.confidence === 'INSUFFICIENT') {
      state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND' }
      note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', ...repositoryFacts(state), metadata: { reason: 'verification planning requires human evidence selection' } })
      return { result: { status: 'HUMAN_REQUIRED', humanRequired: { category: 'PLANNING_REQUIRED', reason: 'no trustworthy task-local or package-local verifier; root-suite fallback is forbidden' }, taskStateV2: state } }
    }
    const eligibility = assessDirectPathEligibility({
      task: state,
      plan,
      agents: this.options.agents,
      repositoryConsistent: initial.reconciled,
      unownedDirtyChanges: start.changedFiles.length > 0,
    })
    if (!eligibility.eligible) {
      state = { ...state, execution: { ...state.execution!, path: 'CONTROLLER', escalated: true } }
      note({ type: 'DIRECT_PATH_ESCALATED', ...repositoryFacts(state), metadata: { stage: 'ELIGIBILITY', reasons: eligibility.reasons } })
      return { escalationState: state }
    }
    const agent = selectAgent('EXECUTE', this.options.agents)
    if (agent === undefined) return { escalationState: { ...state, execution: { ...state.execution!, path: 'CONTROLLER', escalated: true } } }
    const routeProvider = providerOf(agent)
    note({ type: 'DIRECT_PATH_STARTED', action: 'EXECUTE', agent: agent.id, ...repositoryFacts(state), metadata: { routeProfile: routeProvider, eligibleProviders: this.options.agents.filter((item) => item.available && !item.degraded && !item.quotaExhausted).map(providerOf) } })
    note({ type: 'AGENT_DISPATCHED', action: 'EXECUTE', agent: agent.id, ...repositoryFacts(state), metadata: { routeProfile: routeProvider } })
    emit('EXECUTING', 'active', { kind: 'PROVIDER_DISPATCHED' })
    let execute = await this.options.dispatcher.dispatch({ action: 'EXECUTE', agent: structuredClone(agent), task: structuredClone(state) })
    let end = await this.options.dispatcher.inspectRepository()
    let repositoryChanged = end.headSha !== start.headSha || end.worktreeFingerprint !== start.worktreeFingerprint || JSON.stringify(end.changedFiles) !== JSON.stringify(start.changedFiles)
    if (isConfirmedNoOp(execute, repositoryChanged)) {
      const firstProvider = execute.providerHistory?.at(-1) ?? (routeProvider === 'codex-or-deepseek' ? undefined : routeProvider)
      note({ type: 'AGENT_FAILED', action: 'EXECUTE', agent: agent.id, ...(firstProvider === undefined ? {} : { provider: firstProvider }), ...repositoryFacts(state), metadata: { reason: 'NO_OP_EXECUTION', autoRetry: true, attempt: 1 } })
      emit('EXECUTING', 'failed', { kind: 'PROVIDER_FAILED', ...(firstProvider === undefined ? {} : { provider: firstProvider }), outcome: 'FAILED' })
      await context?.persistTaskStateV2?.(state)
      note({ type: 'AGENT_DISPATCHED', action: 'EXECUTE', agent: agent.id, ...repositoryFacts(state), metadata: { routeProfile: routeProvider, reason: 'NO_OP_EXECUTION', autoRetry: true, attempt: 2 } })
      emit('EXECUTING', 'active', { kind: 'PROVIDER_DISPATCHED', ...(firstProvider === undefined ? {} : { provider: firstProvider }) })
      execute = await this.options.dispatcher.dispatch({ action: 'EXECUTE', agent: structuredClone(agent), task: structuredClone(state), retry: NO_OP_AUTO_RETRY })
      end = await this.options.dispatcher.inspectRepository()
      repositoryChanged = end.headSha !== start.headSha || end.worktreeFingerprint !== start.worktreeFingerprint || JSON.stringify(end.changedFiles) !== JSON.stringify(start.changedFiles)
    }
    const actualProvider = execute.providerHistory?.at(-1) ?? (routeProvider === 'codex-or-deepseek' ? undefined : routeProvider)
    const identity = agentIdentity(agent)
    const actualIdentity = actualProvider === undefined ? identity : { ...identity, provider: actualProvider }
    const observedState: TaskStateV2 = { ...state, gitState: { ...end }, currentAgent: agent.id, implementer: actualIdentity,
      providerHistory: execute.providerHistory ?? (actualProvider === undefined ? state.providerHistory : appendProviderHistory(state.providerHistory, actualProvider)) }
    state = controller.applyResult(observedState, 'EXECUTE', { ...execute, repositoryChanged, implementationEvidenceAdded: execute.implementationEvidenceAdded === true })
    note({ type: execute.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', action: 'EXECUTE', agent: agent.id, ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state) })
    emit('EXECUTING', execute.status === 'SUCCESS' ? 'completed' : 'failed', { kind: execute.status === 'SUCCESS' ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: execute.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED' })
    const riskBefore = assessRisk({ ...state, gitState: { ...state.gitState, changedFiles: [] } }).level
    const riskAfter = assessRisk(state).level
    const planValidity = validateVerificationPlanAfterExecution({ plan, changedFiles: end.changedFiles, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths, riskBefore, riskAfter })
    await context?.persistTaskStateV2?.(state)
    if (execute.status !== 'SUCCESS' || !planValidity.valid) {
      const noOpRecovery = planValidity.valid && isConfirmedNoOp(execute, repositoryChanged)
      state = { ...state, execution: { ...state.execution!, escalated: true, path: 'CONTROLLER' },
        ...(noOpRecovery ? { status: 'PENDING', currentAction: 'EXECUTE', blockers: [] }
          : planValidity.valid ? {} : { blockers: [...state.blockers, ...planValidity.reasons] }) }
      note({ type: 'DIRECT_PATH_ESCALATED', action: 'EXECUTE', ...repositoryFacts(state), metadata: { stage: planValidity.valid ? 'EXECUTE' : 'PLAN_INVALIDATED', reasons: planValidity.valid ? execute.blockers ?? [execute.summary ?? 'execution failed'] : planValidity.reasons, verificationPlan: plan } })
      return { escalationState: state }
    }
    note({ type: 'VERIFICATION_STARTED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command) })
    emit('VERIFYING', 'active', { kind: 'VERIFIER_STARTED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId })
    const verification = await this.options.dispatcher.dispatch({ action: 'VERIFY', agent: structuredClone(agent), task: structuredClone(state) })
    state = controller.applyResult(state, 'VERIFY', verification)
    const passed = verification.status === 'SUCCESS' && locallyPassingVerificationResults(state.verificationState.results)
    note({ type: passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: state.verificationState.results.map((item) => item.name) })
    emit('VERIFYING', passed ? 'completed' : 'failed', { kind: 'VERIFIER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId, outcome: passed ? 'PASSED' : 'FAILED' })
    await context?.persistTaskStateV2?.(state)
    const risk = assessRisk(state)
    if (!passed || !completionGate({ task: state, ...state.completion, risk })) {
      state = { ...state, execution: { ...state.execution!, escalated: true, path: 'CONTROLLER' } }
      note({ type: 'DIRECT_PATH_ESCALATED', action: 'VERIFY', ...repositoryFacts(state), metadata: { stage: 'VERIFY', verificationPlan: plan, failureClassification: state.verificationState.results.find((item) => item.status === 'failed')?.classification ?? 'EVIDENCE_MISSING' } })
      return { escalationState: state }
    }
    if (this.options.dispatcher.deliveryCompletionGate) {
      const delivery = await this.options.dispatcher.deliveryCompletionGate(state)
      if (delivery.status !== 'LOCALLY_VERIFIED') return { escalationState: { ...state,
        blockers: [...state.blockers, delivery.reason ?? 'Delivery assertion evidence is incomplete.'] } }
    }
    emit('FINALIZING', 'active', { kind: 'CONTROLLER_PHASE_CHANGED' })
    await this.options.dispatcher.deliveryTaskCompleted?.(state)
    state = { ...state, status: 'COMPLETED', currentAction: 'COMPLETE', updatedAt: new Date().toISOString() }
    note({ type: 'TASK_COMPLETED', action: 'COMPLETE', ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command), metadata: { executionPath: 'DIRECT', outcome: end.changedFiles.length === 0 ? 'ALREADY_SATISFIED' : 'COMPLETED' } })
    await context?.persistTaskStateV2?.(state)
    emit('COMPLETED', 'completed', { kind: 'PROVIDER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: 'COMPLETED' })
    return { result: { status: 'COMPLETED', taskStateV2: state, completionEvidence: completionEvidence(state, state.verificationState.results) } }
  }

  private async runController(task: WorkSessionTask, resumeData?: unknown, _checkpoint?: unknown, context?: WorkSessionTaskRunContext): Promise<WorkSessionTaskResult> {
    const controller = this.options.controller ?? new TaskController()
    let state: TaskStateV2
    try {
      state = context?.taskStateV2 === undefined ? createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task) : loadTaskStateV2(context.taskStateV2)
      if (state.identity.taskId !== task.id || state.identity.sessionId !== this.options.sessionId) throw new Error('task identity mismatch')
      const configured = createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task)
      // 只要存在可信 VerificationPlan，VERIFY 证据就以 plan step id 为身份；binding 必须
      // 使用同一命名空间，否则 completionGate 永远无法匹配 evidence.type。恢复阶段无关。
      const trustedBindings = state.verificationPlan !== undefined && verificationPlanFingerprintValid(state.verificationPlan)
        ? bindingsFromVerificationPlan(state.verificationPlan, { identity: 'step' }) : configured.completion.bindings
      if (JSON.stringify([state.goal, state.constraints, state.acceptanceCriteria, state.permissions, state.completion.bindings]) !==
          JSON.stringify([configured.goal, configured.constraints, configured.acceptanceCriteria, configured.permissions, trustedBindings])) throw new Error('persisted task policy does not match trusted definition')
    } catch {
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'RECOVERY_BLOCKED', reason: 'invalid persisted TaskStateV2' } }
    }
    const originalLimit = this.options.maxActions ?? state.actionBudget?.originalLimit ?? 20
    state = { ...state,
      controllerConvergence: state.controllerConvergence ?? { recentDecisions: [] },
      actionBudget: state.actionBudget === undefined
        ? { originalLimit, originalConsumed: 0, originalExhausted: false, recoveryLimit: RECOVERY_ACTION_BUDGET, recoveryGranted: false, recoveryConsumed: 0, recoveryExhausted: false }
        : { ...state.actionBudget, originalLimit } }
    const normalizedBudget = state.actionBudget!
    const humanDecision = typeof (resumeData as { decision?: unknown } | undefined)?.decision === 'string'
      ? (resumeData as { decision: string }).decision.trim().toLocaleUpperCase('en-US') : undefined
    if (humanDecision !== undefined && /(?:VERIFY\s*ONLY|NO\s+RE-?EXECUTE)/u.test(humanDecision)) {
      state = { ...state, humanConstraints: { verifyOnly: true }, status: 'ACTIVE', blockers: [] }
    } else if (humanDecision !== undefined && /(?:ALLOW\s+RE-?EXECUTE|REVOKE\s+VERIFY\s*ONLY)/u.test(humanDecision)) {
      state = { ...state, humanConstraints: { verifyOnly: false }, status: 'ACTIVE', blockers: [] }
    }
    const validRecoveryDecision = normalizedBudget.originalExhausted && !normalizedBudget.recoveryGranted &&
      typeof (resumeData as { decision?: unknown } | undefined)?.decision === 'string' &&
      (resumeData as { decision: string }).decision.trim().length > 0
    if (validRecoveryDecision) {
      state = { ...state, status: 'ACTIVE', blockers: [], actionBudget: { ...normalizedBudget, recoveryGranted: true, recoveryConsumed: 0, recoveryExhausted: false } }
    }
    // Explicit approval binds the persisted request, never the newly observed workspace.
    const approvalGrantedOnResume = state.currentAction === 'REQUEST_APPROVAL' && state.blockers.length === 0 &&
        typeof resumeData === 'object' && resumeData !== null && (resumeData as { approval?: unknown }).approval === true
    if (approvalGrantedOnResume) {
      state = { ...state, status: 'ACTIVE', completion: { ...state.completion, approval: {
        approved: true, repositoryIdentity: state.gitState.repositoryIdentity!, branch: state.gitState.branch!,
        reviewedCommit: state.gitState.headSha!, workspaceIdentity: state.gitState.worktreeFingerprint!,
        risk: assessRisk(state).level, riskContext: approvalContext(state), timestamp: new Date().toISOString(),
      } } }
    }
    // A Runtime Repair that selected an independent reviewer resumes the same REVIEW
    // boundary without re-running the Executor. The durable chosen reviewer is trusted
    // only because the repair engine's deterministic validator already accepted it.
    const reviewerSelectedOnResume = state.currentAction === 'REVIEW' && state.status === 'SUSPENDED' &&
        context?.chosenReviewer !== undefined && state.completion.review === undefined
    if (reviewerSelectedOnResume) {
      state = { ...state, status: 'ACTIVE' }
    }
    let approvedVerificationCommand = context?.approvedVerificationCommand
    if (approvedVerificationCommand !== undefined && state.blockers.length > 0 &&
        state.blockers.every((b) => b === VERIFICATION_APPROVAL_BLOCKER + approvedVerificationCommand)) {
      state = { ...state, status: 'ACTIVE', blockers: [] }
    }
    let previousAgent = state.currentAgent
    const eventLog = context?.taskEventLog
    const health = context?.providerHealth ?? new ProviderHealthRegistry()
    health.seedFromProfiles(this.options.agents)
    const sessionId = this.options.sessionId
    const taskId = task.id
    // Task Event Log 是 append-only 历史；即使上下文给了 log，也绝不反向影响 decision。
    const note = (input: Omit<TaskEventV2, 'eventId' | 'taskId' | 'sessionId' | 'timestamp'> & { timestamp?: string }): TaskEventV2 | undefined =>
      eventLog === undefined ? undefined : eventLog.append({ taskId, sessionId, ...input })
    const emitProgress = (phase: GuardianPhase, status: 'active' | 'completed' | 'failed', activity?: import('../progress.js').ExecutionActivityFact): void => {
      const event = { phase, status, iteration: 0, elapsedMs: 0, ...(activity === undefined ? {} : { activity }) } as const
      context?.onProgress?.(event)
      this.options.progressObserver?.(event)
    }
    const explanation = (reasonCode: DecisionReasonCode, action: TaskAction, detail: { selectedAgent?: string; selectedProvider?: string; previousAgent?: string; previousProvider?: string }, factors: readonly string[], alternativesConsidered: readonly string[] = []): DispatchExplanation => ({
      action, reasonCode, timestamp: new Date().toISOString(),
      ...(detail.selectedAgent === undefined ? {} : { selectedAgent: detail.selectedAgent }),
      ...(detail.selectedProvider === undefined ? {} : { selectedProvider: detail.selectedProvider }),
      ...(detail.previousAgent === undefined ? {} : { previousAgent: detail.previousAgent }),
      ...(detail.previousProvider === undefined ? {} : { previousProvider: detail.previousProvider }),
      factors, alternativesConsidered,
      message: dispatchMessage({ reasonCode, action, ...detail }),
    })
    const reasonEvent = (type: TaskEventType, action: TaskAction, reasonCode: DecisionReasonCode, detail: { selectedAgent?: string; selectedProvider?: string; previousAgent?: string; previousProvider?: string }, factors: readonly string[], taskSnapshot: TaskStateV2): void => {
      note({ type, action, reasonCode, ...repositoryFacts(taskSnapshot),
        ...(detail.selectedAgent === undefined ? {} : { agent: detail.selectedAgent }),
        ...(detail.selectedProvider === undefined ? {} : { provider: detail.selectedProvider }),
        ...(detail.previousAgent === undefined ? {} : { metadata: { previousAgent: detail.previousAgent } }),
        ...(detail.previousProvider === undefined ? {} : { previousProvider: detail.previousProvider }),
        explanation: explanation(reasonCode, action, detail, factors) })
    }
    if (eventLog !== undefined) {
      if (!eventLog.has('TASK_CREATED')) {
        note({ type: 'TASK_CREATED', ...repositoryFacts(state) })
      } else {
        note({ type: 'TASK_RESUMED', ...repositoryFacts(state), metadata: { status: state.status } })
      }
      if (approvalGrantedOnResume) {
        note({ type: 'APPROVAL_GRANTED', action: 'REQUEST_APPROVAL', reasonCode: 'RISK_REQUIRES_APPROVAL', ...repositoryFacts(state), explanation: explanation('RISK_REQUIRES_APPROVAL', 'REQUEST_APPROVAL', {}, [], []) })
      }
      if (validRecoveryDecision) {
        note({ type: 'RECOVERY_BUDGET_GRANTED', action: 'SUSPEND', reasonCode: 'RECOVERY_BUDGET_GRANTED', ...repositoryFacts(state), metadata: {
          originalBudgetExhausted: true, humanDecision: true, recoveryBudget: state.actionBudget!.recoveryLimit,
        } })
      }
    }
    if (state.actionBudget!.recoveryExhausted ||
        (state.actionBudget!.recoveryGranted && state.actionBudget!.recoveryConsumed >= state.actionBudget!.recoveryLimit)) {
      state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND', actionBudget: { ...state.actionBudget!, recoveryExhausted: true } }
      note({ type: 'RECOVERY_BUDGET_EXHAUSTED', action: 'SUSPEND', reasonCode: 'RECOVERY_BUDGET_EXHAUSTED', ...repositoryFacts(state), metadata: { terminalForSession: true } })
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ACTION_BUDGET_EXHAUSTED', reason: 'recovery action budget exhausted; session is terminal' }, taskStateV2: state }
    }
    let previousDecisionKey: string | undefined
    let noProgressRepeats = 0
    for (let iteration = 0; iteration < originalLimit + RECOVERY_ACTION_BUDGET + 8; iteration++) {
      if (context?.shouldPauseAutonomousWork?.() || (context?.hardDeadlineAtMs !== undefined && Date.now() >= context.hardDeadlineAtMs)) return { status: 'PAUSED', taskStateV2: state }
      const persistedRepositoryIdentity = state.gitState.repositoryIdentity
      const persistedHeadSha = state.gitState.headSha
      const reconciliation = reconcileTaskState(state, await this.options.dispatcher.inspectRepository())
      state = reconciliation.state
      if (eventLog !== undefined) {
        if (!reconciliation.reconciled) {
          note({ type: 'RECONCILIATION_REQUIRED', action: 'RECONCILE', reasonCode: 'REPOSITORY_RECONCILIATION_REQUIRED', ...repositoryFacts(state),
            metadata: { reasons: [...reconciliation.reasons], ...(persistedRepositoryIdentity === undefined ? {} : { persistedRepositoryIdentity }), ...(persistedHeadSha === undefined ? {} : { persistedHeadSha }) } })
        } else if (eventLog.has('RECONCILIATION_REQUIRED')) {
          note({ type: 'RECONCILIATION_COMPLETED', action: 'RECONCILE', reasonCode: 'REPOSITORY_RECONCILIATION_REQUIRED', ...repositoryFacts(state) })
        }
      }
      const violations = scopeBlockers({ id: task.id, goal: state.goal, state: 'EXECUTING', iteration: 0, maxIterations: 1, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths }, state.gitState.changedFiles, state.gitState.repositoryIdentity)
      if (violations.length) state = { ...state, blockers: [...new Set([...state.blockers, ...violations])] }
      const decision = controller.decide(state, { reconciliationRequired: !reconciliation.reconciled })
      state = { ...state, currentAction: decision.action,
        ...((decision.action === 'REQUEST_APPROVAL' || decision.action === 'SUSPEND') ? { status: 'SUSPENDED' as const } : {}) }
      note({ type: 'CONTROLLER_DECIDED', action: decision.action, reasonCode: decision.reasonCode, ...repositoryFacts(state), explanation: explanation(decision.reasonCode, decision.action, {}, [], []) })
      const phase: GuardianPhase = phaseForAction(decision.action, false)
      emitProgress(phase, 'active', { kind: 'CONTROLLER_PHASE_CHANGED' })
      await context?.persistTaskStateV2?.(state)
      if (decision.action === 'RECONCILE') {
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'REPO_DRIFT', reason: decision.reason }, taskStateV2: state }
      }
      if (decision.action === 'REQUEST_APPROVAL' || decision.action === 'SUSPEND') {
        if (decision.action === 'REQUEST_APPROVAL') {
          reasonEvent('APPROVAL_REQUIRED', 'REQUEST_APPROVAL', 'RISK_REQUIRES_APPROVAL', {}, decision.reason === undefined ? [] : [decision.reason], state)
        } else {
          note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', reasonCode: decision.reasonCode, ...repositoryFacts(state), explanation: explanation(decision.reasonCode, 'SUSPEND', {}, [], []) })
        }
        const category = decision.reasonCode === 'ACCEPTANCE_EVIDENCE_BINDING_MISSING' || decision.reasonCode === 'VERIFIER_CONFIGURATION_FAILURE'
          ? 'CONFIGURATION_REQUIRED'
          : decision.reasonCode === 'VERIFICATION_ENVIRONMENT_FAILURE' ? 'ENVIRONMENT_REQUIRED'
            : decision.reasonCode === 'UNRELATED_TEST_FAILURE' || decision.reasonCode === 'VERIFICATION_UNKNOWN' ? 'DECISION_REQUIRED' : 'DECISION_REQUIRED'
        const failedVerification = state.verificationState.results.find((result) => result.status === 'failed')
        if (failedVerification !== undefined) note({ type: 'VERIFICATION_CLASSIFIED', action: 'VERIFY', reasonCode: decision.reasonCode, ...repositoryFacts(state), metadata: { classification: canonicalVerificationFailure(failedVerification.classification), verifier: failedVerification.name } })
        return { status: 'HUMAN_REQUIRED', humanRequired: { category, reason: decision.reason }, taskStateV2: state, ...(failedVerification === undefined ? {} : { verificationFailure: failedVerification }) }
      }
      if (decision.action === 'REVIEW') {
        reasonEvent('REVIEW_REQUIRED', 'REVIEW', 'RISK_REQUIRES_REVIEW', {}, decision.reason === undefined ? [] : [decision.reason], state)
      }
      if (decision.action === 'COMPLETE') {
        if (this.options.dispatcher.deliveryCompletionGate) {
          const delivery = await this.options.dispatcher.deliveryCompletionGate(state)
          if (delivery.status !== 'LOCALLY_VERIFIED') return { status: 'HUMAN_REQUIRED',
            humanRequired: { category: 'RECOVERY_BLOCKED', reason: delivery.reason ?? 'Delivery assertion evidence is incomplete.' },
            taskStateV2: state }
        }
        const verificationResults = state.verificationState.results
        await this.options.dispatcher.deliveryTaskCompleted?.(state)
        note({ type: 'TASK_COMPLETED', action: 'COMPLETE', reasonCode: 'COMPLETION_CRITERIA_SATISFIED', ...repositoryFacts(state),
          evidenceRefs: [...new Set(state.completion.bindings.flatMap((binding) => binding.requiredEvidence))] })
        return {
          status: 'COMPLETED', taskStateV2: { ...state, status: 'COMPLETED', currentAction: 'COMPLETE' },
          completionEvidence: completionEvidence(state, verificationResults),
        }
      }
      const budget = state.actionBudget!
      const recoveryMode = budget.originalExhausted
      const consumed = recoveryMode ? budget.recoveryConsumed : budget.originalConsumed
      const limit = recoveryMode ? budget.recoveryLimit : budget.originalLimit
      if (consumed >= limit) {
        const reasonCode = recoveryMode ? 'RECOVERY_BUDGET_EXHAUSTED' : 'ACTION_BUDGET_EXHAUSTED'
        state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND', actionBudget: recoveryMode
          ? { ...budget, recoveryExhausted: true }
          : { ...budget, originalExhausted: true } }
        note({ type: recoveryMode ? 'RECOVERY_BUDGET_EXHAUSTED' : 'ACTION_BUDGET_EXHAUSTED', action: 'SUSPEND', reasonCode, ...repositoryFacts(state), metadata: { limit, consumed, terminalForSession: recoveryMode } })
        await context?.persistTaskStateV2?.(state)
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ACTION_BUDGET_EXHAUSTED', reason: recoveryMode ? 'recovery action budget exhausted; session is terminal' : 'controller action budget exhausted; one bounded human recovery decision is available' }, taskStateV2: state }
      }
      // REVIEW excludes its implementer and every provider that produced the
      // implementation; independence is a capability fact, not a role assumption.
      const eligibleAgents = decision.action === 'REVIEW'
        ? this.options.agents.filter((candidate) => isIndependentReviewerCandidate(candidate, state))
        : this.options.agents
      let agent = selectAgent(decision.action, eligibleAgents, decision.action === 'REVIEW' ? undefined : previousAgent)
      // A Runtime Repair may have durably selected an independent reviewer whose static
      // profile is still marked unavailable. That selection was already validated
      // (review-capable + independent); trust it only for the REVIEW action.
      if (agent === undefined && decision.action === 'REVIEW' && context?.chosenReviewer !== undefined) {
        agent = eligibleAgents.find((candidate) =>
          candidate.identity?.runtimeIdentity === context.chosenReviewer!.runtimeIdentity &&
          candidate.capabilities.review === true)
      }
      if (agent === undefined) {
        note({ type: 'TASK_SUSPENDED', action: decision.action, reasonCode: 'NO_AVAILABLE_AGENT', ...repositoryFacts(state), explanation: explanation('NO_AVAILABLE_AGENT', decision.action, {}, [], []) })
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: noAvailableAgentReason(decision.action) }, taskStateV2: { ...state, status: 'SUSPENDED' } }
      }
      const selectedAgent = agent.id
      const selectedProvider = providerOf(agent)
      const projectedProvider = concreteRuntimeProvider(selectedProvider)
      const previousProfile = previousAgent === undefined ? undefined : this.options.agents.find((candidate) => candidate.id === previousAgent)
      const previousProvider = previousAgent === undefined ? undefined : providerOf(previousProfile ?? { id: previousAgent })
      const selectionCode = selectionReasonCode({ action: decision.action, selected: agent, ...(previousAgent === undefined ? {} : { previousAgent }), ...(previousProfile === undefined ? {} : { previousProfile }) })
      const selectionFactors: string[] = previousProfile === undefined
        ? [`${selectedAgent} satisfies ${decision.action}`]
        : [`previous provider ${previousProvider} is not usable for ${decision.action}`]
      if (decision.action === 'REVIEW') {
        note({ type: 'REVIEW_STARTED', action: 'REVIEW', agent: selectedAgent, ...(projectedProvider === undefined ? {} : { provider: projectedProvider }), ...repositoryFacts(state) })
        emitProgress('REVIEWING', 'active', { kind: 'PROVIDER_DISPATCHED', ...(projectedProvider === undefined ? {} : { provider: projectedProvider }) })
      }
      note({ type: 'AGENT_DISPATCHED', action: decision.action, reasonCode: selectionCode, agent: selectedAgent, ...(projectedProvider === undefined ? {} : { provider: projectedProvider }),
        ...(agent.identity?.runtimeIdentity === undefined ? {} : { runtimeIdentity: agent.identity.runtimeIdentity }),
        ...repositoryFacts(state),
        explanation: explanation(selectionCode, decision.action, { selectedAgent, selectedProvider, ...(previousAgent === undefined ? {} : { previousAgent }), ...(previousProvider === undefined ? {} : { previousProvider }) }, selectionFactors) })
      if (decision.action === 'VERIFY') note({ type: 'VERIFICATION_STARTED', action: 'VERIFY', ...repositoryFacts(state) })
      emitProgress(phase, 'active', { kind: decision.action === 'VERIFY' ? 'VERIFIER_STARTED' : 'PROVIDER_DISPATCHED', ...(projectedProvider === undefined ? {} : { provider: projectedProvider }), ...(decision.action === 'VERIFY' ? { verifier: 'deterministic' } : {}) })
      state = { ...state, actionBudget: recoveryMode
        ? { ...state.actionBudget!, recoveryConsumed: state.actionBudget!.recoveryConsumed + 1 }
        : { ...state.actionBudget!, originalConsumed: state.actionBudget!.originalConsumed + 1 } }
      await context?.persistTaskStateV2?.(state)
      const progressBefore = semanticProgressKey(state, health)
      const decisionKey = `${decision.action}:${decision.reasonCode}`
      const dispatchedState = structuredClone(state)
      const selected = structuredClone(agent)
      const handoff = previousAgent === undefined || previousAgent === agent.id ? undefined
        : createStructuredHandoff(dispatchedState, decision.action, `provider switch from ${previousAgent} to ${agent.id}`)
      const checkpoint = implementationCheckpointHandoff({ getState: () => state, setState: (accepted) => { state = accepted },
        ...(context?.persistTaskStateV2 === undefined ? {} : { persist: context.persistTaskStateV2 }) })
      let result: Awaited<ReturnType<V2ActionDispatcher['dispatch']>>
      try {
        result = await this.options.dispatcher.dispatch({ action: decision.action, agent: structuredClone(selected), task: dispatchedState,
          ...(decision.action === 'VERIFY' ? { checkpointImplementation: checkpoint.checkpoint } : {}),
          ...(handoff === undefined ? {} : { handoff }), ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }),
          recoveryInstructions: [...(context?.recoveryInstructions ?? []), ...(state.autonomousRecovery?.diagnosis?.instructions ? [state.autonomousRecovery.diagnosis.instructions] : [])] })
      } finally { checkpoint.close() }
      const actualProvider = result.providerHistory?.at(-1) ?? projectedProvider
      approvedVerificationCommand = undefined
      // Real runtime/router observations from this dispatch become Provider Health facts.
      if (result.providerHealth !== undefined) {
        for (const observation of result.providerHealth) {
          const previous = health.get(observation.provider)
          health.record(observation)
          if (previous === undefined || previous.status !== observation.status) {
            note({ type: 'PROVIDER_HEALTH_CHANGED', provider: observation.provider, ...(observation.executor === undefined ? {} : { runtimeIdentity: observation.executor }),
              reasonCode: providerSwitchReasonCode(observation), metadata: { status: observation.status, ...(observation.reason === undefined ? {} : { reason: observation.reason }) } })
          }
        }
      }
      const observed = await this.options.dispatcher.inspectRepository()
      if (observed.repositoryIdentity !== state.gitState.repositoryIdentity || observed.branch !== state.gitState.branch || observed.headSha !== state.gitState.headSha ||
          (decision.action !== 'EXECUTE' && observed.worktreeFingerprint !== state.gitState.worktreeFingerprint)) {
        state = reconcileTaskState(state, observed).state
        note({ type: 'RECONCILIATION_REQUIRED', action: 'RECONCILE', reasonCode: 'REPOSITORY_RECONCILIATION_REQUIRED', ...repositoryFacts(state), metadata: { reasons: ['repository changed during action'] } })
        await context?.persistTaskStateV2?.(state)
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'REPO_DRIFT', reason: 'repository changed during action' }, taskStateV2: state }
      }
      const providerHistoryBefore = state.providerHistory
      const repositoryChanged = observed.headSha !== state.gitState.headSha || observed.worktreeFingerprint !== state.gitState.worktreeFingerprint ||
        JSON.stringify(observed.changedFiles) !== JSON.stringify(state.gitState.changedFiles)
      const implementationEvidenceAdded = result.implementationEvidenceAdded === true
      const observedState: TaskStateV2 = { ...state, gitState: { repositoryIdentity: observed.repositoryIdentity, branch: observed.branch, headSha: observed.headSha, changedFiles: observed.changedFiles, worktreeFingerprint: observed.worktreeFingerprint } }
      const actualImplementer = actualProvider === undefined || agent.identity === undefined ? agent.identity : { ...agent.identity, provider: actualProvider }
      // providerHistory is implementation provenance, not a list of every runtime
      // that observed or reviewed the task. Polluting it with a reviewer would make
      // that same independent reviewer ineligible during Runtime Repair.
      const nextProviderHistory = decision.action !== 'EXECUTE' ? state.providerHistory
        : result.providerHistory ?? (actualProvider === undefined ? state.providerHistory : appendProviderHistory(state.providerHistory, actualProvider))
      state = controller.applyResult({ ...observedState, currentAgent: agent.id, providerHistory: nextProviderHistory,
        ...(decision.action === 'EXECUTE' && actualImplementer !== undefined ? { implementer: actualImplementer } : {}) }, decision.action, { ...result, repositoryChanged, implementationEvidenceAdded })
      // Provider switches are derived from the authoritative providerHistory delta,
      // never reconstructed from memory or agent narrative after the fact.
      const providerSwitches = deriveProviderSwitches(providerHistoryBefore, state.providerHistory)
      for (const [fromProvider, toProvider] of providerSwitches) {
        const switchCode = providerSwitchReasonCode(health.get(fromProvider))
        reasonEvent('PROVIDER_SWITCHED', decision.action, switchCode, { previousProvider: fromProvider, selectedProvider: toProvider, ...(previousAgent === undefined ? {} : { previousAgent }) }, [`provider changed from ${fromProvider} to ${toProvider}`], state)
      }
      const verificationResults = result.verificationResults ?? state.verificationState.results
      const verificationPassed = decision.action === 'VERIFY' && result.status === 'SUCCESS' &&
        locallyPassingVerificationResults(verificationResults)
      if (decision.action === 'VERIFY' && verificationResults !== undefined) {
        if (verificationPassed) note({ type: 'VERIFICATION_PASSED', action: 'VERIFY', ...repositoryFacts(state), evidenceRefs: verificationResults.map((resultItem) => resultItem.name) })
        else {
          note({ type: 'VERIFICATION_FAILED', action: 'VERIFY', ...repositoryFacts(state), evidenceRefs: verificationResults.map((resultItem) => resultItem.name) })
          for (const failure of verificationResults.filter((item) => item.status === 'failed')) note({ type: 'VERIFICATION_CLASSIFIED', action: 'VERIFY', reasonCode: canonicalVerificationFailure(failure.classification) === 'ENVIRONMENT_FAILURE' ? 'VERIFICATION_ENVIRONMENT_FAILURE' : canonicalVerificationFailure(failure.classification) === 'VERIFIER_CONFIGURATION_FAILURE' ? 'VERIFIER_CONFIGURATION_FAILURE' : canonicalVerificationFailure(failure.classification) === 'UNRELATED_TEST_FAILURE' ? 'UNRELATED_TEST_FAILURE' : canonicalVerificationFailure(failure.classification) === 'CODE_FAILURE' ? 'VERIFICATION_FAILED' : 'VERIFICATION_UNKNOWN', ...repositoryFacts(state), metadata: { classification: canonicalVerificationFailure(failure.classification), verifier: failure.name } })
        }
      }
      if (result.review !== undefined) {
        // Review evidence is accepted only when its reviewer matches the
        // selected agent; a mismatched identity is dropped, never trusted.
        const review = trustedReviewEvidence(decision.action, selected, result.review)
        if (review !== undefined) {
          state = { ...state, completion: { ...state.completion, review } }
          if (review.passed) note({ type: 'REVIEW_PASSED', action: 'REVIEW', agent: selectedAgent, provider: selectedProvider, ...repositoryFacts(state) })
          else note({ type: 'REVIEW_FAILED', action: 'REVIEW', agent: selectedAgent, provider: selectedProvider, ...repositoryFacts(state), metadata: { blockingFindings: [...review.blockingFindings] } })
        } else {
          note({ type: 'REVIEW_FAILED', action: 'REVIEW', agent: selectedAgent, provider: selectedProvider, ...repositoryFacts(state), metadata: { reason: 'reviewer identity did not match selected agent' } })
        }
      }
      note({ type: result.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', action: decision.action, agent: selectedAgent, ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state),
        ...(result.workspaceExecution === undefined ? {} : { metadata: { workspaceExecution: result.workspaceExecution } }) })
      const actionSucceeded = decision.action === 'VERIFY' ? verificationPassed : result.status === 'SUCCESS'
      emitProgress(decision.action === 'REVIEW' ? 'REVIEWING' : phase, actionSucceeded ? 'completed' : 'failed', { kind: decision.action === 'VERIFY' ? 'VERIFIER_COMPLETED' : actionSucceeded ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: decision.action === 'VERIFY' ? verificationPassed ? 'PASSED' : 'FAILED' : actionSucceeded ? 'COMPLETED' : 'FAILED' })
      if (repositoryChanged) emitProgress('EXECUTING', 'completed', { kind: 'REPOSITORY_CHANGED', changedFileCount: observed.changedFiles.length })
      const hadVerificationFailure = dispatchedState.verificationState.results.some((item) => item.status === 'failed')
      if (decision.action === 'EXECUTE' && result.status === 'SUCCESS' && hadVerificationFailure && !repositoryChanged && !implementationEvidenceAdded) {
        const failure = dispatchedState.verificationState.results.find((item) => item.status === 'failed')!
        const reason = `Executor completed without repository or implementation-evidence progress after ${canonicalVerificationFailure(failure.classification)}`
        state = { ...state, verificationState: dispatchedState.verificationState, completion: dispatchedState.completion, status: 'SUSPENDED', currentAction: 'SUSPEND' }
        note({ type: 'NO_IMPLEMENTATION_PROGRESS', action: 'EXECUTE', reasonCode: 'NO_IMPLEMENTATION_PROGRESS', ...repositoryFacts(state), metadata: { repoChanged: false, evidenceChanged: false, originalFailureClassification: canonicalVerificationFailure(failure.classification), verifier: failure.name } })
        note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', reasonCode: 'NO_IMPLEMENTATION_PROGRESS', ...repositoryFacts(state) })
        await context?.persistTaskStateV2?.(state)
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'STALLED_NO_PROGRESS', reason }, taskStateV2: state, verificationFailure: failure }
      }
      const convergenceHistory = [...(state.controllerConvergence?.recentDecisions ?? []), { decisionKey, realityKey: convergenceRealityKey(state, health) }].slice(-CONVERGENCE_HISTORY_LIMIT)
      state = { ...state, controllerConvergence: { recentDecisions: convergenceHistory } }
      const cycle = detectCyclicNoProgress(convergenceHistory)
      if (cycle !== undefined) {
        const reason = `${cycle.pattern.join(' -> ')} repeated ${cycle.cycles} times without repository or evidence progress`
        state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND' }
        note({ type: 'NO_PROGRESS_DETECTED', action: 'SUSPEND', reasonCode: 'CYCLIC_NO_PROGRESS', ...repositoryFacts(state), metadata: { pattern: cycle.pattern, cycles: cycle.cycles } })
        await context?.persistTaskStateV2?.(state)
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'CYCLIC_NO_PROGRESS', reason }, taskStateV2: state }
      }
      const progressAfter = semanticProgressKey(state, health)
      noProgressRepeats = decisionKey === previousDecisionKey && progressAfter === progressBefore ? noProgressRepeats + 1 : 0
      previousDecisionKey = decisionKey
      if (noProgressRepeats >= MAX_NO_PROGRESS_REPEATS) {
        const reason = `${decision.action} / ${decision.reasonCode} repeated without semantic, repository, evidence, blocker, or provider progress`
        state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND' }
        note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', reasonCode: 'STALLED_NO_PROGRESS', ...repositoryFacts(state), metadata: { repeatedAction: decision.action, repeatedReasonCode: decision.reasonCode, repeats: noProgressRepeats, unresolvedCondition: decision.reason }, explanation: explanation('STALLED_NO_PROGRESS', 'SUSPEND', {}, [reason], []) })
        await context?.persistTaskStateV2?.(state)
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'STALLED_NO_PROGRESS', reason }, taskStateV2: state }
      }
      await context?.persistTaskStateV2?.(state)
      previousAgent = agent.id
      if (result.status === 'BLOCKED') {
        const commands = state.blockers.filter((b) => b.startsWith(VERIFICATION_APPROVAL_BLOCKER)).map((b) => b.slice(VERIFICATION_APPROVAL_BLOCKER.length))
        // A reviewer runtime failure is an environment problem, not a verdict on the
        // implementation. It stays REVIEW-pending so Runtime Repair can reselect a
        // legal independent reviewer instead of re-running the Executor, and it must
        // not leave a semantic blocker behind: the implementation is not blocked.
        if (decision.action === 'REVIEW' && result.providerFailure !== undefined) {
          const marker = result.providerFailure.status === 'OFFLINE' ? 'PROVIDER_OFFLINE' : 'PROVIDER_UNAVAILABLE'
          state = { ...state, blockers: [], currentAction: 'REVIEW', status: 'SUSPENDED' }
          note({ type: 'TASK_SUSPENDED', action: 'REVIEW', reasonCode: 'PROVIDER_UNAVAILABLE', ...repositoryFacts(state),
            metadata: { provider: result.providerFailure.provider, providerStatus: result.providerFailure.status },
            explanation: explanation('PROVIDER_UNAVAILABLE', 'REVIEW', { selectedProvider: result.providerFailure.provider }, [result.providerFailure.reason]) })
          return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ENVIRONMENT_REQUIRED',
            reason: `${marker}: reviewer ${result.providerFailure.provider} is ${result.providerFailure.status}: ${result.providerFailure.reason}` }, taskStateV2: state }
        }
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: state.blockers[0] ?? decision.reason }, taskStateV2: state,
          ...(commands.length === 1 ? { pendingVerificationCommand: commands[0]! } : {}) }
      }
    }
    const recoveryMode = state.actionBudget?.originalExhausted === true
    state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND', actionBudget: recoveryMode
      ? { ...state.actionBudget!, recoveryExhausted: true }
      : { ...state.actionBudget!, originalExhausted: true } }
    note({ type: recoveryMode ? 'RECOVERY_BUDGET_EXHAUSTED' : 'ACTION_BUDGET_EXHAUSTED', action: 'SUSPEND', reasonCode: recoveryMode ? 'RECOVERY_BUDGET_EXHAUSTED' : 'ACTION_BUDGET_EXHAUSTED', ...repositoryFacts(state) })
    return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ACTION_BUDGET_EXHAUSTED', reason: recoveryMode ? 'recovery action budget exhausted; session is terminal' : 'controller action budget exhausted; one bounded human recovery decision is available' }, taskStateV2: state }
  }
}

export function completionEvidence(state: TaskStateV2, verificationResults: readonly VerificationResult[]) {
  return {
    repositoryReality: { repositoryIdentity: state.gitState.repositoryIdentity!, branch: state.gitState.branch!, headSha: state.gitState.headSha!,
      worktreeFingerprint: state.gitState.worktreeFingerprint!, changedFiles: state.gitState.changedFiles },
    changedFiles: state.gitState.changedFiles,
    verificationResults,
    blockers: state.blockers,
    finalReviewerVerdict: 'done' as const,
    requiredVerification: [...new Set(verifierEvidenceFromBindings(state.completion.bindings))],
  }
}
