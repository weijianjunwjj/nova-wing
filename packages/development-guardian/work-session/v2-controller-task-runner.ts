import type { VerificationResult } from '../model.js'
import { canonicalVerificationFailure, TaskController, type TaskAction, type TaskActionResult } from './task-controller.js'
import { createTaskStateV2, loadTaskStateV2, type TaskActorIdentity, type TaskStateV2 } from './task-state-v2.js'
import { approvalContext, assessRisk, type ApprovalEvidence, type ReviewEvidence } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
import { VERIFICATION_APPROVAL_BLOCKER } from './verification-approval.js'
import { scopeBlockers } from '../claude-code-executor.js'
import { isIndependentReviewerCandidate } from './reviewer-runtime.js'
import type { WorkSessionTask } from './model.js'
import type { WorkSessionTaskResult, WorkSessionTaskRunContext, WorkSessionTaskRunner } from './task-runner.js'
import type { GuardianPhase, GuardianProgressObserver } from '../progress.js'
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

function agentIdentity(agent: AgentCapabilityProfile): TaskActorIdentity {
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
  dispatch(input: { action: TaskAction; agent: AgentCapabilityProfile; task: TaskStateV2; handoff?: V2StructuredHandoff; approvedVerificationCommand?: string }): Promise<TaskActionResult & { review?: ReviewEvidence; approval?: ApprovalEvidence; providerHistory?: readonly string[]; providerHealth?: readonly ProviderHealthObservation[]; providerFailure?: ReviewerProviderFailure }>
  /** Production V2 has no agent-reported-repository fallback. */
  inspectRepository(): Promise<RepositoryReality>
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
const RECOVERY_ACTION_BUDGET = 4
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
  }) {}

  async run(task: WorkSessionTask, resumeData?: unknown, _checkpoint?: unknown, context?: WorkSessionTaskRunContext): Promise<WorkSessionTaskResult> {
    const controller = this.options.controller ?? new TaskController()
    let state: TaskStateV2
    try {
      state = context?.taskStateV2 === undefined ? createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task) : loadTaskStateV2(context.taskStateV2)
      if (state.identity.taskId !== task.id || state.identity.sessionId !== this.options.sessionId) throw new Error('task identity mismatch')
      const configured = createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task)
      if (JSON.stringify([state.goal, state.constraints, state.acceptanceCriteria, state.permissions, state.completion.bindings]) !==
          JSON.stringify([configured.goal, configured.constraints, configured.acceptanceCriteria, configured.permissions, configured.completion.bindings])) throw new Error('persisted task policy does not match trusted definition')
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
      const violations = scopeBlockers({ id: task.id, goal: state.goal, state: 'EXECUTING', iteration: 0, maxIterations: 1, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths }, state.gitState.changedFiles)
      if (violations.length) state = { ...state, blockers: [...new Set([...state.blockers, ...violations])] }
      const decision = controller.decide(state, { reconciliationRequired: !reconciliation.reconciled })
      state = { ...state, currentAction: decision.action,
        ...((decision.action === 'REQUEST_APPROVAL' || decision.action === 'SUSPEND') ? { status: 'SUSPENDED' as const } : {}) }
      note({ type: 'CONTROLLER_DECIDED', action: decision.action, reasonCode: decision.reasonCode, ...repositoryFacts(state), explanation: explanation(decision.reasonCode, decision.action, {}, [], []) })
      const phase: GuardianPhase = decision.action === 'VERIFY' ? 'VERIFYING' : decision.action === 'REVIEW' ? 'FINAL_REVIEW' : decision.action === 'EXECUTE' ? 'EXECUTING' : decision.action === 'RECONCILE' ? 'RECOVERING' : 'REVIEWING'
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
        const verificationResults = state.verificationState.results
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
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: `no available agent for ${decision.action}` }, taskStateV2: { ...state, status: 'SUSPENDED' } }
      }
      const selectedAgent = agent.id
      const selectedProvider = providerOf(agent)
      const previousProfile = previousAgent === undefined ? undefined : this.options.agents.find((candidate) => candidate.id === previousAgent)
      const previousProvider = previousAgent === undefined ? undefined : providerOf(previousProfile ?? { id: previousAgent })
      const selectionCode = selectionReasonCode({ action: decision.action, selected: agent, ...(previousAgent === undefined ? {} : { previousAgent }), ...(previousProfile === undefined ? {} : { previousProfile }) })
      const selectionFactors: string[] = previousProfile === undefined
        ? [`${selectedAgent} satisfies ${decision.action}`]
        : [`previous provider ${previousProvider} is not usable for ${decision.action}`]
      note({ type: 'AGENT_DISPATCHED', action: decision.action, reasonCode: selectionCode, agent: selectedAgent, provider: selectedProvider,
        ...(agent.identity?.runtimeIdentity === undefined ? {} : { runtimeIdentity: agent.identity.runtimeIdentity }),
        ...repositoryFacts(state),
        explanation: explanation(selectionCode, decision.action, { selectedAgent, selectedProvider, ...(previousAgent === undefined ? {} : { previousAgent }), ...(previousProvider === undefined ? {} : { previousProvider }) }, selectionFactors) })
      if (decision.action === 'VERIFY') note({ type: 'VERIFICATION_STARTED', action: 'VERIFY', ...repositoryFacts(state) })
      emitProgress(phase, 'active', { kind: decision.action === 'VERIFY' ? 'VERIFIER_STARTED' : 'PROVIDER_DISPATCHED', provider: selectedProvider, ...(decision.action === 'VERIFY' ? { verifier: 'deterministic' } : {}) })
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
      const result = await this.options.dispatcher.dispatch({ action: decision.action, agent: structuredClone(selected), task: dispatchedState, ...(handoff === undefined ? {} : { handoff }), ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }) })
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
      state = controller.applyResult({ ...observedState, currentAgent: agent.id, providerHistory: result.providerHistory ?? appendProviderHistory(state.providerHistory, agent.id),
        ...(decision.action === 'EXECUTE' && agent.identity !== undefined ? { implementer: selected.identity! } : {}) }, decision.action, { ...result, repositoryChanged, implementationEvidenceAdded })
      // Provider switches are derived from the authoritative providerHistory delta,
      // never reconstructed from memory or agent narrative after the fact.
      const providerSwitches = deriveProviderSwitches(providerHistoryBefore, state.providerHistory)
      for (const [fromProvider, toProvider] of providerSwitches) {
        const switchCode = providerSwitchReasonCode(health.get(fromProvider))
        reasonEvent('PROVIDER_SWITCHED', decision.action, switchCode, { previousProvider: fromProvider, selectedProvider: toProvider, ...(previousAgent === undefined ? {} : { previousAgent }) }, [`provider changed from ${fromProvider} to ${toProvider}`], state)
      }
      const verificationResults = result.verificationResults ?? state.verificationState.results
      if (decision.action === 'VERIFY' && verificationResults !== undefined) {
        const passed = verificationResults.length > 0 && verificationResults.every((resultItem) => resultItem.status === 'passed')
        if (passed) note({ type: 'VERIFICATION_PASSED', action: 'VERIFY', ...repositoryFacts(state), evidenceRefs: verificationResults.map((resultItem) => resultItem.name) })
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
      note({ type: result.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', action: decision.action, agent: selectedAgent, provider: selectedProvider, ...repositoryFacts(state) })
      emitProgress(phase, result.status === 'SUCCESS' ? 'completed' : 'failed', { kind: decision.action === 'VERIFY' ? 'VERIFIER_COMPLETED' : result.status === 'SUCCESS' ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED', provider: selectedProvider, outcome: result.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED' })
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

function completionEvidence(state: TaskStateV2, verificationResults: readonly VerificationResult[]) {
  return {
    repositoryReality: { repositoryIdentity: state.gitState.repositoryIdentity!, branch: state.gitState.branch!, headSha: state.gitState.headSha!,
      worktreeFingerprint: state.gitState.worktreeFingerprint!, changedFiles: state.gitState.changedFiles },
    changedFiles: state.gitState.changedFiles,
    verificationResults,
    blockers: state.blockers,
    finalReviewerVerdict: 'done' as const,
    requiredVerification: [...new Set(state.completion.bindings.flatMap((binding) => binding.requiredEvidence))],
  }
}
