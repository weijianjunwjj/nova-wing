import type { VerificationResult } from '../model.js'
import { TaskController, type TaskAction, type TaskActionResult } from './task-controller.js'
import { createTaskStateV2, loadTaskStateV2, type TaskActorIdentity, type TaskStateV2 } from './task-state-v2.js'
import { approvalContext, assessRisk, type ApprovalEvidence, type ReviewEvidence } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
import { VERIFICATION_APPROVAL_BLOCKER } from './verification-approval.js'
import { scopeBlockers } from '../claude-code-executor.js'
import type { WorkSessionTask } from './model.js'
import type { WorkSessionTaskResult, WorkSessionTaskRunContext, WorkSessionTaskRunner } from './task-runner.js'
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
  dispatch(input: { action: TaskAction; agent: AgentCapabilityProfile; task: TaskStateV2; handoff?: V2StructuredHandoff; approvedVerificationCommand?: string }): Promise<TaskActionResult & { review?: ReviewEvidence; approval?: ApprovalEvidence; providerHistory?: readonly string[]; providerHealth?: readonly ProviderHealthObservation[] }>
  /** Production V2 has no agent-reported-repository fallback. */
  inspectRepository(): Promise<RepositoryReality>
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
    }
    let previousDecisionKey: string | undefined
    let noProgressRepeats = 0
    for (let iteration = 0; iteration < (this.options.maxActions ?? 20); iteration++) {
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
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: decision.reasonCode === 'ACCEPTANCE_EVIDENCE_BINDING_MISSING' ? 'CONFIGURATION_REQUIRED' : 'DECISION_REQUIRED', reason: decision.reason }, taskStateV2: state }
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
      const eligibleAgents = decision.action === 'REVIEW'
        ? this.options.agents.filter((candidate) => candidate.identity !== undefined && candidate.identity.runtimeIdentity !== state.implementer?.runtimeIdentity)
        : this.options.agents
      const agent = selectAgent(decision.action, eligibleAgents, decision.action === 'REVIEW' ? undefined : previousAgent)
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
      const observedState: TaskStateV2 = { ...state, gitState: { repositoryIdentity: observed.repositoryIdentity, branch: observed.branch, headSha: observed.headSha, changedFiles: observed.changedFiles, worktreeFingerprint: observed.worktreeFingerprint } }
      state = controller.applyResult({ ...observedState, currentAgent: agent.id, providerHistory: result.providerHistory ?? appendProviderHistory(state.providerHistory, agent.id),
        ...(decision.action === 'EXECUTE' && agent.identity !== undefined ? { implementer: selected.identity! } : {}) }, decision.action, result)
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
        else note({ type: 'VERIFICATION_FAILED', action: 'VERIFY', ...repositoryFacts(state), evidenceRefs: verificationResults.map((resultItem) => resultItem.name) })
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
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: state.blockers[0] ?? decision.reason }, taskStateV2: state,
          ...(commands.length === 1 ? { pendingVerificationCommand: commands[0]! } : {}) }
      }
    }
    return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'STALLED', reason: 'controller action budget exhausted' }, taskStateV2: { ...state, status: 'SUSPENDED' } }
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
