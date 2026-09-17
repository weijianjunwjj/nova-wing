import type { ExecutionActivityFact, GuardianPhase, GuardianProgressObserver } from '../progress.js'
import { scopeBlockers } from '../claude-code-executor.js'
import { canonicalVerificationFailure } from './task-controller.js'
import { createTaskStateV2, loadTaskStateV2, type TaskGitStateV2, type TaskStateV2 } from './task-state-v2.js'
import { assessRisk, completionGate } from './risk-evidence.js'
import { reconcileTaskState, type RepositoryReality } from './reconciliation.js'
import {
  bindingsFromVerificationPlan,
  planVerification,
  validateVerificationPlanAfterExecution,
  verificationPlanApprovalSatisfied,
  verificationPlanFingerprintValid,
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
import { isAutonomousRecoveryCategory, RECOVERY_ACTION_BUDGET, validateAutonomousDiagnosis, type AutonomousRecoveryOptions } from './autonomous-diagnosis.js'

/**
 * v0.3.0 Golden Path.
 *
 * A strictly bounded, deterministic default for ordinary LOW/MEDIUM tasks. It
 * reuses the Verification Planner, provider runtime (the V2ActionDispatcher),
 * repository inspection, deterministic verifier, evidence model and Git
 * finalizer — but it never calls the TaskController decision loop, never
 * enters a Controller loop, and caps Golden at EXECUTE ≤ 2 and VERIFY ≤ 2.
 * After those bounds, v0.3.1 may diagnose once and explicitly enter Advanced
 * recovery using the existing durable Controller recovery action budget.
 *
 * The only two recoveries within Golden are:
 *   1. EXECUTOR NO-OP — replace the stale thread once, retry EXECUTE once.
 *      A second NO-OP stops with EXECUTOR_NO_PROGRESS_AFTER_RETRY.
 *   2. CODE_FAILURE   — run one EXECUTE fix, then VERIFY once more.
 *      A second CODE_FAILURE stops with CODE_FAILURE_AFTER_SINGLE_FIX.
 *
 * Unsafe and human-owned failures still stop. Other ordinary failures can use
 * structured diagnosis and the same bounded Advanced recovery grant.
 * HIGH / CRITICAL risk and other ineligible tasks use the existing advanced
 * (Controller) path via `fallbackRunner`.
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
  | 'APPROVAL_REQUIRED'
  | 'EVIDENCE_MISSING'
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
    type: item.stepId ?? item.name,
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
    blockers: verification.status === 'SUCCESS'
      ? state.blockers
      : [...new Set([...state.blockers, ...(verification.blockers ?? []), ...(verification.summary === undefined ? [] : [verification.summary])])],
    currentAction: 'VERIFY',
    status: 'ACTIVE',
    updatedAt: new Date().toISOString(),
  }
}

type GoldenVerificationAssessment = {
  passed: boolean
  category?: GoldenPathTerminal
  reason?: string
  verifier?: string | undefined
}

/** Validate the complete VERIFY contract before classifying any code failure. */
export function assessGoldenVerification(plan: VerificationPlan, verification: GoldenDispatchResult): GoldenVerificationAssessment {
  const results = verification.verificationResults ?? []
  const blockers = verification.blockers ?? []
  const approval = results.find((item) => item.status === 'skipped' && item.classification === 'PERMISSION_REQUIRED')
  if (approval !== undefined || blockers.some((blocker) => /requires human approval|approval required/iu.test(blocker))) {
    const verifier = approval?.command ?? approval?.name ?? blockers.find((blocker) => /approval/iu.test(blocker))
    return { passed: false, category: 'APPROVAL_REQUIRED', verifier,
      reason: `验证未执行，需要批准：${verifier ?? '具体 verifier command 未返回'}` }
  }
  if (verification.status === 'BLOCKED' || blockers.length > 0) {
    return { passed: false, category: 'SAFETY_BLOCKED', verifier: results.find((item) => item.status !== 'passed')?.stepId,
      reason: `VERIFY 返回未解决 blocker：${blockers.join('; ') || verification.summary || '未提供具体原因'}` }
  }
  if (verification.status === 'FAILED' && results.every((item) => item.status === 'passed')) {
    return { passed: false, category: 'SAFETY_BLOCKED', reason: `VERIFY adapter returned FAILED despite passed results: ${verification.summary ?? '未提供具体原因'}` }
  }
  const requiredIds = plan.steps.map((step) => step.id)
  if (requiredIds.length === 0 || new Set(requiredIds).size !== requiredIds.length) {
    return { passed: false, category: 'VERIFIER_CONFIGURATION_REQUIRED', reason: 'VerificationPlan contains empty or duplicate step identities.' }
  }
  const byStep = new Map<string, typeof results>()
  for (const result of results) {
    if (result.stepId === undefined) continue
    byStep.set(result.stepId, [...(byStep.get(result.stepId) ?? []), result])
  }
  for (const step of plan.steps) {
    const matching = byStep.get(step.id) ?? []
    if (matching.length === 0) return { passed: false, category: 'EVIDENCE_MISSING', verifier: step.id,
      reason: `缺少必需验证结果：stepId=${step.id}, command=${step.command}, cwd=${step.cwd}` }
    if (matching.length !== 1) return { passed: false, category: 'VERIFIER_CONFIGURATION_REQUIRED', verifier: step.id,
      reason: `验证结果身份重复或歧义：stepId=${step.id}, count=${matching.length}` }
    const result = matching[0]!
    if ((result.command ?? result.name) !== step.command || result.cwd !== step.cwd) {
      return { passed: false, category: 'VERIFIER_CONFIGURATION_REQUIRED', verifier: step.id,
        reason: `验证结果与计划不匹配：stepId=${step.id}, expected=${step.command}@${step.cwd}, actual=${result.command ?? result.name}@${result.cwd ?? 'missing'}` }
    }
  }
  const required = requiredIds.map((id) => byStep.get(id)![0]!)
  const skipped = required.find((item) => item.status === 'skipped')
  if (skipped !== undefined) {
    const classification = canonicalVerificationFailure(skipped.classification)
    if (classification === 'ENVIRONMENT_FAILURE') return { passed: false, category: 'ENVIRONMENT_REQUIRED', verifier: skipped.stepId, reason: skipped.details ?? '验证环境不可用。' }
    return { passed: false, category: classification === 'VERIFIER_CONFIGURATION_FAILURE' ? 'VERIFIER_CONFIGURATION_REQUIRED' : 'EVIDENCE_MISSING',
      verifier: skipped.stepId, reason: `验证步骤未启动：${skipped.command ?? skipped.name}; ${skipped.details ?? '未提供原因'}` }
  }
  const failed = required.filter((item) => item.status === 'failed')
  if (failed.length === 0) return { passed: true }
  const classified = failed.map((item) => ({ item, classification: canonicalVerificationFailure(item.classification) }))
  const priority = classified.find((entry) => entry.classification === 'ENVIRONMENT_FAILURE') ??
    classified.find((entry) => entry.classification === 'VERIFIER_CONFIGURATION_FAILURE') ??
    classified.find((entry) => entry.classification === 'UNRELATED_TEST_FAILURE') ??
    classified.find((entry) => entry.classification === 'EVIDENCE_MISSING') ??
    classified.find((entry) => entry.classification === 'UNKNOWN')
  if (priority !== undefined) {
    const category = priority.classification === 'ENVIRONMENT_FAILURE' ? 'ENVIRONMENT_REQUIRED'
      : priority.classification === 'VERIFIER_CONFIGURATION_FAILURE' ? 'VERIFIER_CONFIGURATION_REQUIRED'
        : priority.classification === 'UNRELATED_TEST_FAILURE' ? 'UNRELATED_TEST_FAILURE'
          : priority.classification === 'EVIDENCE_MISSING' ? 'EVIDENCE_MISSING' : 'UNKNOWN'
    return { passed: false, category, verifier: priority.item.stepId ?? priority.item.name,
      reason: priority.item.details ?? `Verification failed: ${priority.item.command ?? priority.item.name}` }
  }
  return { passed: false, category: 'CODE_FAILURE_AFTER_SINGLE_FIX', verifier: failed[0]?.stepId ?? failed[0]?.name,
    reason: failed[0]?.details ?? `deterministic CODE_FAILURE: ${failed[0]?.command ?? failed[0]?.name}` }
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
  autonomousRecovery?: AutonomousRecoveryOptions
}

export class GoldenPathTaskRunner implements WorkSessionTaskRunner {
  constructor(private readonly options: GoldenPathTaskRunnerOptions) {}

  async run(
    task: WorkSessionTask, resumeData?: unknown, checkpoint?: GuardianTaskRecoveryCheckpoint, context?: WorkSessionTaskRunContext,
  ): Promise<WorkSessionTaskResult> {
    const persisted = context?.taskStateV2
    const approvedResume = typeof resumeData === 'object' && resumeData !== null && (resumeData as { approval?: unknown }).approval === true
    const exactVerificationApproval = context?.approvedVerificationCommand !== undefined && persisted?.verificationPlan?.steps.some((step) =>
      step.admission === 'APPROVAL_REQUIRED' && (step.originalCommand ?? step.command) === context.approvedVerificationCommand) === true &&
      verificationPlanApprovalSatisfied(persisted.verificationPlan, context.approvedVerificationCommand)
    if (this.options.autonomousRecovery !== undefined && persisted?.execution?.path === 'GOLDEN' && persisted.status !== 'PENDING' && exactVerificationApproval) {
      if (persisted.autonomousRecovery?.goldenExecuteCount === 0 && persisted.autonomousRecovery.executorHistory.length === 0) {
        // Approval was requested before EXECUTE: continue that exact Golden boundary.
        return this.run(task, resumeData, checkpoint, { ...context, taskStateV2: { ...persisted, status: 'PENDING', blockers: [] } })
      }
      const budget = persisted.actionBudget ?? createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task).actionBudget!
      const advanced: TaskStateV2 = { ...persisted, status: 'ACTIVE', currentAction: 'VERIFY', blockers: [],
        verificationState: { ...persisted.verificationState, results: [] }, execution: { ...persisted.execution, path: 'CONTROLLER', escalated: true },
        autonomousRecovery: { ...(persisted.autonomousRecovery ?? { goldenExecuteCount: 2, goldenVerifyCount: 2, executorHistory: [], verificationHistory: [persisted.verificationState.results] }), phase: 'ADVANCED' },
        actionBudget: { ...budget, originalExhausted: true, recoveryGranted: true, recoveryLimit: Math.min(budget.recoveryLimit, RECOVERY_ACTION_BUDGET) } }
      context?.taskEventLog?.append({ type: 'ADVANCED_RECOVERY', taskId: task.id, sessionId: this.options.sessionId, ...repositoryFacts(advanced), metadata: { reason: 'exact verifier approval', phase: 'ADVANCED' } })
      await context?.persistTaskStateV2?.(advanced)
      return this.finishRecovery(await this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: advanced }), context)
    }
    if (this.options.autonomousRecovery !== undefined && persisted?.autonomousRecovery?.phase === 'HUMAN_REQUIRED' &&
        (context?.chosenReviewer !== undefined || context?.approvedVerificationCommand !== undefined || approvedResume)) {
      // Preserve existing Runtime Repair / exact-command / risk approval control paths.
      const advanced = { ...persisted, autonomousRecovery: { ...persisted.autonomousRecovery, phase: 'ADVANCED' as const } }
      return this.finishRecovery(await this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: advanced }), context)
    }
    if (this.options.autonomousRecovery !== undefined && persisted?.execution?.path === 'GOLDEN' &&
        (persisted.autonomousRecovery === undefined || persisted.status !== 'PENDING' || persisted.autonomousRecovery.goldenExecuteCount > 0)) {
      // An interrupted Golden run must never reset its counters on restart.
      return this.recover(task, { status: 'HUMAN_REQUIRED', taskStateV2: persisted, humanRequired: {
        category: persisted.autonomousRecovery?.triggerCategory ?? 'EVIDENCE_MISSING',
        reason: persisted.autonomousRecovery?.triggerReason ?? 'Golden execution was interrupted; inspect durable evidence before continuing.',
      } }, resumeData, checkpoint, context)
    }
    if (this.options.autonomousRecovery !== undefined && (persisted?.autonomousRecovery?.phase === 'HUMAN_REQUIRED' || persisted?.autonomousRecovery?.phase === 'DIAGNOSING')) {
      return this.recover(task, { status: 'HUMAN_REQUIRED', taskStateV2: persisted, humanRequired: {
        category: persisted.autonomousRecovery.triggerCategory ?? 'EVIDENCE_MISSING', reason: persisted.autonomousRecovery.triggerReason ?? '补充指令后重新诊断。',
      } }, resumeData, checkpoint, context)
    }
    const result = await this.runGolden(task, resumeData, checkpoint, context)
    if (result.taskStateV2?.autonomousRecovery?.phase === 'ADVANCED') return this.finishRecovery(result, context)
    return this.recover(task, result, resumeData, checkpoint, context)
  }

  private async finishRecovery(result: WorkSessionTaskResult, context?: WorkSessionTaskRunContext): Promise<WorkSessionTaskResult> {
    const state = result.taskStateV2
    if (state?.autonomousRecovery === undefined) return result
    if (result.status === 'COMPLETED' && state.verificationPlan !== undefined) {
      const verified = assessGoldenVerification(state.verificationPlan, { status: 'SUCCESS', verificationResults: state.verificationState.results, blockers: state.blockers })
      if (!verified.passed) result = { status: 'HUMAN_REQUIRED', taskStateV2: state, humanRequired: {
        category: verified.category ?? 'EVIDENCE_MISSING', reason: verified.reason ?? 'Advanced Recovery 没有取得完整的确定性验证证据。',
      } }
    }
    const next: TaskStateV2 = { ...state,
      ...(result.status === 'HUMAN_REQUIRED' ? { status: 'SUSPENDED' } : {}),
      autonomousRecovery: { ...state.autonomousRecovery, phase: result.status === 'COMPLETED' ? 'COMPLETED' : result.status === 'HUMAN_REQUIRED' ? 'HUMAN_REQUIRED' : 'ADVANCED',
        ...(result.humanRequired === undefined ? {} : { triggerCategory: result.humanRequired.category, triggerReason: result.humanRequired.reason }) } }
    const failure = next.verificationState.results.find((item) => item.status !== 'passed') ??
      next.autonomousRecovery!.verificationHistory.flat().findLast((item) => item.status !== 'passed')
    await context?.persistTaskStateV2?.(next)
    return { ...result, taskStateV2: next, ...(failure === undefined ? {} : { verificationFailure: failure }),
      ...(result.humanRequired === undefined ? {} : { humanRequired: { ...result.humanRequired,
        reason: `已完成 ${next.autonomousRecovery!.goldenExecuteCount} 轮 Golden 执行，并使用 ${next.actionBudget?.recoveryConsumed ?? 0}/${next.actionBudget?.recoveryLimit ?? RECOVERY_ACTION_BUDGET} 个恢复动作。${result.humanRequired.reason}` +
          (failure === undefined ? '' : ` 最后验证：${failure.command ?? failure.name}；${failure.details ?? failure.classification ?? failure.status}。`) +
          ` 当前修改：${next.gitState.changedFiles.join(', ') || '无'}。请查看失败证据并补充更具体的修复指令；涉及权限时需要明确授权。` } }) }
  }

  private async recover(
    task: WorkSessionTask, result: WorkSessionTaskResult, resumeData?: unknown,
    checkpoint?: GuardianTaskRecoveryCheckpoint, context?: WorkSessionTaskRunContext,
  ): Promise<WorkSessionTaskResult> {
    const recovery = this.options.autonomousRecovery
    if (recovery === undefined || result.status !== 'HUMAN_REQUIRED' || result.humanRequired === undefined || result.taskStateV2 === undefined ||
        !isAutonomousRecoveryCategory(result.humanRequired.category) || result.pendingVerificationCommand !== undefined) return result
    let state: TaskStateV2
    try {
      state = loadTaskStateV2(result.taskStateV2)
      const configured = createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task)
      if (JSON.stringify([state.identity, state.goal, state.constraints, state.acceptanceCriteria, state.permissions]) !==
          JSON.stringify([configured.identity, configured.goal, configured.constraints, configured.acceptanceCriteria, configured.permissions])) throw new Error('policy mismatch')
      if (state.verificationPlan !== undefined && !verificationPlanFingerprintValid(state.verificationPlan)) throw new Error('invalid verification plan')
    } catch {
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'RECOVERY_BLOCKED', reason: '持久化任务或验证计划与当前授权不一致，不能自动恢复。' } }
    }
    state = { ...state, autonomousRecovery: { ...(state.autonomousRecovery ?? {
      phase: 'GOLDEN', goldenExecuteCount: 2, goldenVerifyCount: 2, executorHistory: [], verificationHistory: [state.verificationState.results],
    }), triggerCategory: result.humanRequired.category, triggerReason: result.humanRequired.reason } }
    const stop = async (category: string, reason: string): Promise<WorkSessionTaskResult> => this.finishRecovery({
      status: 'HUMAN_REQUIRED', humanRequired: { category, reason }, taskStateV2: state,
    }, context)
    const existingBudget = state.actionBudget ?? createTaskStateV2({ id: this.options.sessionId, branch: this.options.branch }, task).actionBudget!
    if (existingBudget.recoveryExhausted || existingBudget.recoveryConsumed >= Math.min(existingBudget.recoveryLimit, RECOVERY_ACTION_BUDGET)) {
      state = { ...state, actionBudget: { ...existingBudget, recoveryExhausted: true } }
      return stop('ACTION_BUDGET_EXHAUSTED', '自动恢复额度已用完；继续消耗额外额度需要你的决定。')
    }
    if (context?.shouldPauseAutonomousWork?.() || (context?.hardDeadlineAtMs !== undefined && Date.now() >= context.hardDeadlineAtMs)) return { status: 'PAUSED', taskStateV2: state }
    const reality = await this.options.dispatcher.inspectRepository()
    const reconciled = reconcileTaskState(state, reality)
    if (!reconciled.reconciled) return stop('REPO_DRIFT', `自动恢复前仓库发生变化：${reconciled.reasons.join('; ')}`)
    const violations = scopeBlockers({ id: task.id, goal: state.goal, state: 'EXECUTING', iteration: 0, maxIterations: 1,
      allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths }, reality.changedFiles)
    if (violations.length > 0) return stop('SAFETY_BLOCKED', violations.join('; '))
    const note = (type: 'GOLDEN_EXHAUSTED' | 'AUTONOMOUS_DIAGNOSIS' | 'ADVANCED_RECOVERY'): void => {
      context?.taskEventLog?.append({ type, taskId: task.id, sessionId: this.options.sessionId, ...repositoryFacts(state),
        metadata: { phase: state.autonomousRecovery!.phase, executeCount: state.autonomousRecovery!.goldenExecuteCount,
          verifyCount: state.autonomousRecovery!.goldenVerifyCount, recoveryConsumed: state.actionBudget?.recoveryConsumed } })
    }
    if (state.autonomousRecovery!.phase === 'GOLDEN') note('GOLDEN_EXHAUSTED')
    state = { ...state, status: 'ACTIVE', currentAction: 'ANALYZE',
      autonomousRecovery: { ...state.autonomousRecovery!, phase: 'DIAGNOSING' },
      actionBudget: { ...existingBudget, originalExhausted: true, recoveryGranted: true,
        recoveryLimit: Math.min(existingBudget.recoveryLimit, RECOVERY_ACTION_BUDGET), recoveryConsumed: existingBudget.recoveryConsumed + 1 } }
    // Charge before the model call: interruption/restart cannot refund a diagnosis.
    note('AUTONOMOUS_DIAGNOSIS')
    await context?.persistTaskStateV2?.(state)
    const progress = { phase: 'RECOVERING' as const, status: 'active' as const, iteration: 0, elapsedMs: 0,
      activity: { kind: 'CONTROLLER_PHASE_CHANGED' as const } }
    context?.onProgress?.(progress)
    this.options.progressObserver?.(progress)
    let decision: Awaited<ReturnType<AutonomousRecoveryOptions['diagnose']>>
    try {
      const results = [...state.autonomousRecovery!.verificationHistory.flat(), ...state.verificationState.results]
      const verifierOutputs = await Promise.all(results.map(async (item) => ({
        ...(item.stepId === undefined ? {} : { stepId: item.stepId }), command: item.command ?? item.name,
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        output: await recovery.readVerificationOutput?.(item) ?? item.details ?? item.firstFailure?.tracebackSnippet ?? '',
      })))
      decision = await recovery.diagnose({ task: structuredClone(state), category: result.humanRequired.category,
        reason: result.humanRequired.reason, currentPath: state.execution?.path === 'GOLDEN' ? 'GOLDEN' : 'CONTROLLER',
        diff: await recovery.inspectDiff(), verifierOutputs, recoveryInstructions: context?.recoveryInstructions ?? [] })
    } catch {
      return stop(result.humanRequired.category, '自动诊断未取得有效的结构化结果，请检查模型连接或补充失败信息后重试。')
    }
    const validation = validateAutonomousDiagnosis(decision, state, context?.approvedVerificationCommand)
    if (!validation.ok) return stop(validation.category ?? result.humanRequired.category, validation.reason)
    state = { ...state, autonomousRecovery: { ...state.autonomousRecovery!, diagnosis: validation.decision } }
    // Diagnosis is read-only. Never treat a changed repository as its own checkpoint.
    if (!reconcileTaskState(state, await this.options.dispatcher.inspectRepository()).reconciled) return stop('REPO_DRIFT', '诊断期间仓库发生变化，请先核对修改。')
    if (decision.strategy === 'REPLAN_VERIFICATION') {
      if (state.actionBudget!.recoveryConsumed >= state.actionBudget!.recoveryLimit) return stop('ACTION_BUDGET_EXHAUSTED', '恢复额度不足以重新规划并验证。')
      state = { ...state, actionBudget: { ...state.actionBudget!, recoveryConsumed: state.actionBudget!.recoveryConsumed + 1 } }
      await context?.persistTaskStateV2?.(state)
      const plan = await planVerification({ repositoryRoot: this.options.repositoryRoot, task, risk: assessRisk(state).level,
        changedAreaHint: decision.paths.length > 0 ? decision.paths : state.gitState.changedFiles.length > 0 ? state.gitState.changedFiles : task.allowedPaths ?? [] })
      if (plan.confidence === 'INSUFFICIENT' || plan.approvalRequired) return stop('PLANNING_REQUIRED', '确定性规划仍无法建立无需新增授权的验证计划，请明确验收方式。')
      state = { ...state, verificationPlan: plan, autonomousRecovery: { ...state.autonomousRecovery!,
        ...(state.autonomousRecovery!.originalVerificationPlan !== undefined || state.verificationPlan === undefined ? {} : { originalVerificationPlan: state.verificationPlan }) } }
    }
    if (state.verificationPlan === undefined || state.verificationPlan.confidence === 'INSUFFICIENT' ||
        !verificationPlanApprovalSatisfied(state.verificationPlan, context?.approvedVerificationCommand)) {
      return stop('PLANNING_REQUIRED', '恢复仍缺少可安全执行的确定性验证计划。')
    }
    if (context?.shouldPauseAutonomousWork?.() || (context?.hardDeadlineAtMs !== undefined && Date.now() >= context.hardDeadlineAtMs)) return { status: 'PAUSED', taskStateV2: state }
    const needsImplementation = decision.strategy === 'FIX_IMPLEMENTATION' || (decision.strategy === 'REPLAN_VERIFICATION' && state.autonomousRecovery!.goldenExecuteCount === 0)
    state = { ...state, status: needsImplementation ? 'PENDING' : 'ACTIVE', currentAction: needsImplementation ? 'EXECUTE' : 'VERIFY', blockers: [],
      verificationState: needsImplementation ? state.verificationState : { ...state.verificationState, results: [] },
      completion: { ...state.completion, bindings: bindingsFromVerificationPlan(state.verificationPlan, { identity: 'step' }) },
      execution: { ...state.execution!, path: 'CONTROLLER', escalated: true }, autonomousRecovery: { ...state.autonomousRecovery!, phase: 'ADVANCED' } }
    note('ADVANCED_RECOVERY')
    await context?.persistTaskStateV2?.(state)
    return this.finishRecovery(await this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: state }), context)
  }

  private async runGolden(
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
      completion: { ...state.completion, bindings: bindingsFromVerificationPlan(plan, { identity: 'step' }) },
      execution: { path: 'GOLDEN', escalated: false, startCheckpoint: { ...state.gitState } },
      autonomousRecovery: { phase: 'GOLDEN', goldenExecuteCount: 0, goldenVerifyCount: 0, executorHistory: [], verificationHistory: [] },
      updatedAt: new Date().toISOString(),
    }
    note({ type: 'VERIFICATION_PLANNED', ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command), metadata: { planId: plan.planId, fingerprint: plan.fingerprint, confidence: plan.confidence, scope: plan.estimatedScope } })
    await context?.persistTaskStateV2?.(state)

    if (plan.confidence === 'INSUFFICIENT') {
      state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND' }
      note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', ...repositoryFacts(state), metadata: { reason: 'verification planning requires human evidence selection' } })
      return { status: 'HUMAN_REQUIRED', humanRequired: { category: 'PLANNING_REQUIRED', reason: 'no trustworthy task-local or package-local verifier; root-suite fallback is forbidden' }, taskStateV2: state }
    }

    if (plan.approvalRequired && !verificationPlanApprovalSatisfied(plan, context?.approvedVerificationCommand)) {
      const blockedStep = plan.steps.find((step) => step.admission !== undefined && step.admission !== 'ALLOWED')
      const category: GoldenPathTerminal = blockedStep?.admission === 'UNSUPPORTED' ? 'VERIFIER_CONFIGURATION_REQUIRED' : 'APPROVAL_REQUIRED'
      const reason = blockedStep?.admission === 'UNSUPPORTED'
        ? `验证计划包含不支持的步骤，未启动 Executor：${blockedStep.originalCommand ?? blockedStep.command}; ${blockedStep.admissionReason ?? 'unsupported verifier'}`
        : `验证命令需要精确批准，未启动 Executor：${blockedStep?.originalCommand ?? blockedStep?.command ?? 'unknown verifier'}`
      state = { ...state, status: 'SUSPENDED', currentAction: 'SUSPEND', blockers: [reason], updatedAt: new Date().toISOString() }
      note({ type: 'TASK_SUSPENDED', action: 'SUSPEND', ...repositoryFacts(state), metadata: { reason, planId: plan.planId } })
      await context?.persistTaskStateV2?.(state)
      return { ...goldenTerminal({ category, reason, state, executeCount: 0, verifyCount: 0, provider: undefined,
        verifier: blockedStep?.id ?? plan.planId, changedFiles: state.gitState.changedFiles })
      , ...(blockedStep === undefined || blockedStep.admission === 'UNSUPPORTED' ? {} : { pendingVerificationCommand: blockedStep.originalCommand ?? blockedStep.command }) }
    }

    const eligibility = assessGoldenPathEligibility({
      task: state,
      plan,
      agents: this.options.agents,
      repositoryConsistent: initial.reconciled,
      unownedDirtyChanges: start.changedFiles.length > 0,
      ...(context?.approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand: context.approvedVerificationCommand }),
    })
    if (!eligibility.eligible) {
      state = { ...state,
        completion: { ...state.completion, bindings: bindingsFromVerificationPlan(plan) },
        execution: { ...state.execution!, path: 'CONTROLLER', escalated: true } }
      note({ type: 'DIRECT_PATH_ESCALATED', ...repositoryFacts(state), metadata: { stage: 'ELIGIBILITY', reasons: eligibility.reasons } })
      await context?.persistTaskStateV2?.(state)
      return this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: state })
    }

    const agent = selectAgent('EXECUTE', this.options.agents)
    if (agent === undefined) {
      state = { ...state,
        completion: { ...state.completion, bindings: bindingsFromVerificationPlan(plan) },
        execution: { ...state.execution!, path: 'CONTROLLER', escalated: true } }
      return this.options.fallbackRunner.run(task, resumeData, checkpoint, { ...context, taskStateV2: state })
    }

    let executeCount = 0
    let verifyCount = 0
    const routeProvider = concreteRuntimeProvider(providerOf(agent))

    const dispatchExecute = async (retry?: { reason: 'NO_OP_EXECUTION'; instruction: string }): Promise<{ result: GoldenDispatchResult; end: RepositoryReality }> => {
      if (executeCount >= 2) throw new Error('Golden EXECUTE budget exhausted')
      executeCount += 1
      state = { ...state, autonomousRecovery: { ...state.autonomousRecovery!, goldenExecuteCount: executeCount },
        actionBudget: { ...state.actionBudget!, originalConsumed: state.actionBudget!.originalConsumed + 1 } }
      await context?.persistTaskStateV2?.(state)
      note({
        type: 'AGENT_DISPATCHED', action: 'EXECUTE', agent: agent.id,
        ...(routeProvider === undefined ? {} : { provider: routeProvider }), ...repositoryFacts(state),
        ...(retry === undefined ? {} : { metadata: { reason: retry.reason, autoRetry: true, attempt: executeCount } }),
      })
      emit('EXECUTING', 'active', { kind: 'PROVIDER_DISPATCHED', ...(routeProvider === undefined ? {} : { provider: routeProvider }) })
      const result = await this.options.dispatcher.dispatch({ action: 'EXECUTE', agent: structuredClone(agent), task: structuredClone(state), ...(retry === undefined ? {} : { retry }), recoveryInstructions: context?.recoveryInstructions ?? [] })
      const end = await this.options.dispatcher.inspectRepository()
      state = { ...state, autonomousRecovery: { ...state.autonomousRecovery!, executorHistory: [...state.autonomousRecovery!.executorHistory,
        { status: result.status, ...(result.summary === undefined ? {} : { summary: result.summary }), blockers: result.blockers ?? [], changedFiles: end.changedFiles }] } }
      await context?.persistTaskStateV2?.(state)
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

    const verifyOnce = async (): Promise<GoldenDispatchResult> => {
      if (verifyCount >= 2) throw new Error('Golden VERIFY budget exhausted')
      verifyCount += 1
      state = { ...state, autonomousRecovery: { ...state.autonomousRecovery!, goldenVerifyCount: verifyCount },
        actionBudget: { ...state.actionBudget!, originalConsumed: state.actionBudget!.originalConsumed + 1 } }
      await context?.persistTaskStateV2?.(state)
      note({ type: 'VERIFICATION_STARTED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: plan.steps.map((step) => step.command) })
      emit('VERIFYING', 'active', { kind: 'VERIFIER_STARTED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId })
      const result = await this.options.dispatcher.dispatch({ action: 'VERIFY', agent: structuredClone(agent), task: structuredClone(state),
        ...(context?.approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand: context.approvedVerificationCommand }) })
      state = applyGoldenVerify(state, result)
      state = { ...state, autonomousRecovery: { ...state.autonomousRecovery!, verificationHistory: [...state.autonomousRecovery!.verificationHistory, result.verificationResults ?? []] } }
      return result
    }

    let verification = await verifyOnce()
    let assessment = assessGoldenVerification(plan, verification)
    let passed = assessment.passed
    note({ type: passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: state.verificationState.results.map((item) => item.name) })
    emit('VERIFYING', passed ? 'completed' : 'failed', { kind: 'VERIFIER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId, outcome: passed ? 'PASSED' : 'FAILED' })
    await context?.persistTaskStateV2?.(state)

    if (!passed) {
      note({ type: 'VERIFICATION_CLASSIFIED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { classification: assessment.category, verifier: assessment.verifier, executeCount, verifyCount } })

      if (assessment.category === 'CODE_FAILURE_AFTER_SINGLE_FIX') {
        if (executeCount >= 2) {
          return goldenTerminal({ category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'deterministic CODE_FAILURE remains and the EXECUTE bound is already spent; stopping instead of a third EXECUTE.', state, executeCount, verifyCount, provider: actualProvider, verifier: assessment.verifier, changedFiles: state.gitState.changedFiles })
        }
        const fix = await dispatchExecute()
        const fixChanged = repositoryChangedSince(state.gitState, fix.end)
        state = applyGoldenExecute(state, agent, fix.result, fix.end, actualProvider)
        note({ type: fix.result.status === 'SUCCESS' ? 'AGENT_COMPLETED' : 'AGENT_FAILED', action: 'EXECUTE', agent: agent.id, ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state) })
        emit('EXECUTING', fix.result.status === 'SUCCESS' ? 'completed' : 'failed', { kind: fix.result.status === 'SUCCESS' ? 'PROVIDER_COMPLETED' : 'PROVIDER_FAILED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), outcome: fix.result.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED' })
        await context?.persistTaskStateV2?.(state)
        if (fix.result.status !== 'SUCCESS' || (!fixChanged && fix.result.implementationEvidenceAdded !== true)) {
          note({ type: 'NO_IMPLEMENTATION_PROGRESS', action: 'EXECUTE', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), metadata: { repoChanged: fixChanged, executeCount, verifyCount, originalFailureClassification: 'CODE_FAILURE', verifier: assessment.verifier } })
          return goldenTerminal({ category: 'CODE_FAILURE_AFTER_SINGLE_FIX', reason: 'the single CODE_FAILURE fix produced no repository or implementation-evidence progress; stopping instead of a third EXECUTE.', state, executeCount, verifyCount, provider: actualProvider, verifier: assessment.verifier, changedFiles: state.gitState.changedFiles })
        }
        const fixRisk = assessRisk(state).level
        const fixValidity = validateVerificationPlanAfterExecution({ plan, changedFiles: fix.end.changedFiles, allowedPaths: state.permissions.allowedPaths, forbiddenPaths: state.permissions.forbiddenPaths, riskBefore, riskAfter: fixRisk })
        if (!fixValidity.valid) {
          state = { ...state, blockers: [...new Set([...state.blockers, ...fixValidity.reasons])] }
          return goldenTerminal({ category: 'SAFETY_BLOCKED', reason: `fix crossed a safety boundary: ${fixValidity.reasons.join('; ')}`, state, executeCount, verifyCount, provider: actualProvider, verifier: assessment.verifier, changedFiles: state.gitState.changedFiles })
        }
        verification = await verifyOnce()
        assessment = assessGoldenVerification(plan, verification)
        passed = assessment.passed
        note({ type: passed ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED', action: 'VERIFY', ...(actualProvider === undefined ? {} : { provider: actualProvider }), ...repositoryFacts(state), evidenceRefs: state.verificationState.results.map((item) => item.name) })
        emit('VERIFYING', passed ? 'completed' : 'failed', { kind: 'VERIFIER_COMPLETED', ...(actualProvider === undefined ? {} : { provider: actualProvider }), verifier: plan.planId, outcome: passed ? 'PASSED' : 'FAILED' })
        await context?.persistTaskStateV2?.(state)
        if (!passed) {
          return goldenTerminal({ category: assessment.category ?? 'UNKNOWN', reason: assessment.category === 'CODE_FAILURE_AFTER_SINGLE_FIX'
            ? 'deterministic CODE_FAILURE remains after the single allowed fix; stopping.'
            : assessment.reason ?? 'verification failed after the single implementation fix.', state, executeCount, verifyCount, provider: actualProvider,
          verifier: assessment.verifier, changedFiles: state.gitState.changedFiles })
        }
      } else {
        return goldenTerminal({ category: assessment.category ?? 'UNKNOWN', reason: assessment.reason ?? 'verification failure cannot be safely attributed to the Task implementation.',
          state, executeCount, verifyCount, provider: actualProvider, verifier: assessment.verifier, changedFiles: state.gitState.changedFiles })
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
