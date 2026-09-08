import type { VerificationResult } from '../model.js'
import { TaskController, type TaskAction, type TaskActionResult } from './task-controller.js'
import { createTaskStateV2, type TaskActorIdentity, type TaskStateV2 } from './task-state-v2.js'
import type { ApprovalEvidence, ReviewEvidence } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
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

export interface V2StructuredHandoff {
  task: TaskStateV2
  action: TaskAction
  reason: string
}

export interface V2ActionDispatcher {
  dispatch(input: { action: TaskAction; agent: AgentCapabilityProfile; task: TaskStateV2; handoff?: V2StructuredHandoff }): Promise<TaskActionResult & { review?: ReviewEvidence; approval?: ApprovalEvidence; providerHistory?: readonly string[] }>
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

  async run(task: WorkSessionTask, _resumeData?: unknown, _checkpoint?: unknown, context?: WorkSessionTaskRunContext): Promise<WorkSessionTaskResult> {
    const controller = this.options.controller ?? new TaskController()
    let state = context?.taskStateV2 ?? createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task)
    let previousAgent = state.currentAgent
    for (let iteration = 0; iteration < (this.options.maxActions ?? 20); iteration++) {
      if (context?.shouldPauseAutonomousWork?.()) return { status: 'PAUSED', taskStateV2: { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND' } }
      const reconciliation = reconcileTaskState(state, await this.options.dispatcher.inspectRepository())
      state = reconciliation.state
      const decision = controller.decide(state, { reconciliationRequired: !reconciliation.reconciled })
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
      const agent = selectAgent(decision.action, this.options.agents, previousAgent)
      if (agent === undefined) {
        return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'ENVIRONMENT_REQUIRED', reason: `no available agent for ${decision.action}` }, taskStateV2: { ...state, status: 'SUSPENDED' } }
      }
      const handoff = previousAgent === undefined || previousAgent === agent.id ? undefined
        : createStructuredHandoff(state, decision.action, `provider switch from ${previousAgent} to ${agent.id}`)
      const result = await this.options.dispatcher.dispatch({ action: decision.action, agent, task: state, ...(handoff === undefined ? {} : { handoff }) })
      const observed = await this.options.dispatcher.inspectRepository()
      const observedState: TaskStateV2 = { ...state, gitState: { repositoryIdentity: observed.repositoryIdentity, branch: observed.branch, headSha: observed.headSha, changedFiles: observed.changedFiles, worktreeFingerprint: observed.worktreeFingerprint } }
      state = controller.applyResult({ ...observedState, currentAgent: agent.id, providerHistory: result.providerHistory ?? [...state.providerHistory, agent.id],
        ...(decision.action === 'EXECUTE' ? { implementer: agentIdentity(agent) } : {}) }, decision.action, result)
      if (result.review !== undefined || result.approval !== undefined) {
        state = { ...state, completion: { ...state.completion,
          ...(result.review === undefined ? {} : { review: result.review }),
          ...(result.approval === undefined ? {} : { approval: result.approval }),
        } }
      }
      previousAgent = agent.id
      if (result.status === 'BLOCKED') return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'DECISION_REQUIRED', reason: state.blockers[0] ?? decision.reason }, taskStateV2: state }
    }
    return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'STALLED', reason: 'controller action budget exhausted' }, taskStateV2: { ...state, status: 'SUSPENDED' } }
  }
}

function completionEvidence(state: TaskStateV2, verificationResults: readonly VerificationResult[]) {
  return {
    changedFiles: state.gitState.changedFiles,
    verificationResults,
    blockers: state.blockers,
    finalReviewerVerdict: 'done' as const,
    requiredVerification: verificationResults.map((result) => result.name),
  }
}
