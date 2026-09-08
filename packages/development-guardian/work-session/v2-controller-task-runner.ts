import type { VerificationResult } from '../model.js'
import { TaskController, type TaskAction, type TaskActionResult } from './task-controller.js'
import { createTaskStateV2, loadTaskStateV2, type TaskActorIdentity, type TaskStateV2 } from './task-state-v2.js'
import { approvalContext, assessRisk, type ApprovalEvidence, type ReviewEvidence } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
import { VERIFICATION_APPROVAL_BLOCKER } from './verification-approval.js'
import { scopeBlockers } from '../claude-code-executor.js'
import type { WorkSessionTask } from './model.js'
import type { WorkSessionTaskResult, WorkSessionTaskRunContext, WorkSessionTaskRunner } from './task-runner.js'

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
  dispatch(input: { action: TaskAction; agent: AgentCapabilityProfile; task: TaskStateV2; handoff?: V2StructuredHandoff; approvedVerificationCommand?: string }): Promise<TaskActionResult & { review?: ReviewEvidence; approval?: ApprovalEvidence; providerHistory?: readonly string[] }>
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
    if (state.currentAction === 'REQUEST_APPROVAL' && state.blockers.length === 0 &&
        typeof resumeData === 'object' && resumeData !== null && (resumeData as { approval?: unknown }).approval === true) {
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
    for (let iteration = 0; iteration < (this.options.maxActions ?? 20); iteration++) {
      if (context?.shouldPauseAutonomousWork?.() || (context?.hardDeadlineAtMs !== undefined && Date.now() >= context.hardDeadlineAtMs)) return { status: 'PAUSED', taskStateV2: state }
      const reconciliation = reconcileTaskState(state, await this.options.dispatcher.inspectRepository())
      state = reconciliation.state
      const violations = scopeBlockers({ id: task.id, goal: state.goal, state: 'EXECUTING', iteration: 0, maxIterations: 1, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths }, state.gitState.changedFiles)
      if (violations.length) state = { ...state, blockers: [...new Set([...state.blockers, ...violations])] }
      const decision = controller.decide(state, { reconciliationRequired: !reconciliation.reconciled })
      state = { ...state, currentAction: decision.action,
        ...((decision.action === 'REQUEST_APPROVAL' || decision.action === 'SUSPEND') ? { status: 'SUSPENDED' as const } : {}) }
      await context?.persistTaskStateV2?.(state)
      if (decision.action === 'RECONCILE') {
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'REPO_DRIFT', reason: decision.reason }, taskStateV2: state }
      }
      if (decision.action === 'REQUEST_APPROVAL' || decision.action === 'SUSPEND') {
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: decision.reason }, taskStateV2: state }
      }
      if (decision.action === 'COMPLETE') {
        const verificationResults = state.verificationState.results
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
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: `no available agent for ${decision.action}` }, taskStateV2: { ...state, status: 'SUSPENDED' } }
      }
      const dispatchedState = structuredClone(state)
      const selected = structuredClone(agent)
      const handoff = previousAgent === undefined || previousAgent === agent.id ? undefined
        : createStructuredHandoff(dispatchedState, decision.action, `provider switch from ${previousAgent} to ${agent.id}`)
      const result = await this.options.dispatcher.dispatch({ action: decision.action, agent: structuredClone(selected), task: dispatchedState, ...(handoff === undefined ? {} : { handoff }), ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }) })
      approvedVerificationCommand = undefined
      const observed = await this.options.dispatcher.inspectRepository()
      if (observed.repositoryIdentity !== state.gitState.repositoryIdentity || observed.branch !== state.gitState.branch || observed.headSha !== state.gitState.headSha ||
          (decision.action !== 'EXECUTE' && observed.worktreeFingerprint !== state.gitState.worktreeFingerprint)) {
        state = reconcileTaskState(state, observed).state
        await context?.persistTaskStateV2?.(state)
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'REPO_DRIFT', reason: 'repository changed during action' }, taskStateV2: state }
      }
      const observedState: TaskStateV2 = { ...state, gitState: { repositoryIdentity: observed.repositoryIdentity, branch: observed.branch, headSha: observed.headSha, changedFiles: observed.changedFiles, worktreeFingerprint: observed.worktreeFingerprint } }
      state = controller.applyResult({ ...observedState, currentAgent: agent.id, providerHistory: result.providerHistory ?? [...state.providerHistory, agent.id],
        ...(decision.action === 'EXECUTE' && agent.identity !== undefined ? { implementer: selected.identity! } : {}) }, decision.action, result)
      if (result.review !== undefined) {
        // Review evidence is accepted only when its reviewer matches the
        // selected agent; a mismatched identity is dropped, never trusted.
        const review = trustedReviewEvidence(decision.action, selected, result.review)
        state = { ...state, completion: { ...state.completion,
          ...(review === undefined ? {} : { review }),

        } }
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
