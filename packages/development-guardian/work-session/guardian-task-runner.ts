/**
 * Guardian Work Session Adapter
 * W002 - 桥接 Guardian 和 Work Session
 * W003 - 增加 checkpoint 捕获和恢复
 */

import type { GuardianTask } from '../model.js'
import type { GuardianBrain, GuardianRecoverableExecutor } from '../ports.js'
import type { GuardianProgressObserver } from '../progress.js'
import { classifyWorkSessionFailure } from './failure-classification.js'
import { runGuardianTask } from '../guardian.js'
import type { WorkSessionTask, HumanRequired } from './model.js'
import type {
  WorkSessionTaskRunner,
  WorkSessionTaskResult,
  TaskCompletionEvidence,
  WorkSessionTaskRunContext,
} from './task-runner.js'
import type {
  ChatGptProviderConfigurationState,
  GuardianTaskRecoveryCheckpoint,
  ProviderSessionState,
  RepositoryCheckpoint,
} from './checkpoint.js'
import {
  parseGitStatus,
  computeWorktreeFingerprint,
} from './worktree-fingerprint.js'
import { environmentVerificationFailure } from '../verification-evidence.js'
import { VERIFICATION_APPROVAL_BLOCKER } from './verification-approval.js'

function isChatGptReasoning(
  value: unknown,
): value is 'auto' | 'instant' | 'medium' | 'high' {
  return value === 'auto' || value === 'instant' || value === 'medium' || value === 'high'
}

function readChatGptConfiguration(
  value: unknown,
): ChatGptProviderConfigurationState | undefined {
  if (typeof value !== 'object' || value === null || !('degraded' in value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.degraded !== 'boolean') return undefined

  const configuration: ChatGptProviderConfigurationState = { degraded: source.degraded }
  if (typeof source.requestedModel === 'string') configuration.requestedModel = source.requestedModel
  if (typeof source.actualModel === 'string') configuration.actualModel = source.actualModel
  if (isChatGptReasoning(source.requestedReasoning)) {
    configuration.requestedReasoning = source.requestedReasoning
  }
  if (isChatGptReasoning(source.actualReasoning) || source.actualReasoning === 'unknown') {
    configuration.actualReasoning = source.actualReasoning
  }
  if (typeof source.configuredAt === 'string') configuration.configuredAt = source.configuredAt
  return configuration
}

export interface GuardianTaskBuilderOptions {
  maxIterations?: number
  constraints?: readonly string[]
  acceptanceCriteria?: readonly string[]
  doNotDo?: readonly string[]
  allowedPaths?: readonly string[]
  forbiddenPaths?: readonly string[]
}

/**
 * 从 Work Session Task 构造 Guardian Task
 */
export function createGuardianTask(
  workSessionTask: WorkSessionTask,
  options: GuardianTaskBuilderOptions = {},
): GuardianTask {
  return {
    id: workSessionTask.id,
    goal: workSessionTask.goal,
    state: 'READY',
    iteration: 0,
    maxIterations: options.maxIterations ?? 10,
    ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    ...(options.acceptanceCriteria !== undefined ? { acceptanceCriteria: options.acceptanceCriteria } : {}),
    ...(options.doNotDo !== undefined ? { doNotDo: options.doNotDo } : {}),
    ...(options.allowedPaths !== undefined ? { allowedPaths: options.allowedPaths } : {}),
    ...(options.forbiddenPaths !== undefined ? { forbiddenPaths: options.forbiddenPaths } : {}),
  }
}

/**
 * 已知需要外部运行时/解释器的验证命令（覆盖真实 Python unavailable canary）
 */
const EXTERNAL_RUNTIME_VERIFICATION_COMMANDS = new Set([
  '.venv/Scripts/python.exe -m pytest',
])

/**
 * 结构化：外部运行时/解释器/可执行文件缺失的失败证据。
 * 窄范围，只匹配"运行时/可执行文件不存在"，不做宽泛异常猜测；
 * 普通测试断言失败（如 pytest assertion error）不会命中。
 */
const RUNTIME_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /no such file or directory/i,
  /command not found/i,
  /not recognized as the name of a cmdlet/i,
  /cannot find the (file|path|specified)/i,
  /is not recognized/i,
  /the system cannot find the file specified/i,
  /\bENOENT\b/,
]

function isRuntimeUnavailableDetail(detail: string): boolean {
  return RUNTIME_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))
}

/**
 * W003 BOOTSTRAP CLOSURE：venv target 缺失的信号。
 *
 * 窄范围：只匹配失败详情明确指向 .venv/Scripts/python.exe 本身不存在
 * （No such file or directory / ENOENT）。这是"bootstrap 尚未完成"的信号，
 * 而不是宿主 python 解释器不可用。
 */
function isVenvTargetMissingDetail(detail: string): boolean {
  return (
    /\.venv[/\\]Scripts[/\\]python\.exe/i.test(detail) &&
    (/no such file or directory/i.test(detail) || /\bENOENT\b/i.test(detail))
  )
}

/**
 * W003 BOOTSTRAP CLOSURE：真实宿主运行时失败信号。
 *
 * 只有 venv target 缺失 + 存在宿主 runtime 失败证据（python 解释器 /
 * venv module / executable / interpreter 自身不可用）才是 ENVIRONMENT_REQUIRED。
 * 避免把"尚未 bootstrap"误判为宿主环境故障。
 *
 * 注意精确性：`.venv/Scripts/python.exe: No such file or directory` 是 venv target
 * 缺失（bootstrap 尚未完成），不是宿主 python 不可用；因此这里只匹配独立 python
 * 命令名 / venv module / executable / interpreter 的明确不可用信号。
 */
const HOST_RUNTIME_FAILURE_PATTERNS: readonly RegExp[] = [
  /['"]?python['"]?(?:\.exe)? is not recognized/i,
  /python(?:\.exe)?: command not found/i,
  /python(?:\.exe)?[^]*the system cannot find the file specified/i,
  /no module named ['"]?venv['"]?/i,
  /ensurepip[^]*(?:not available|error)/i,
  /\bvenv\b[^]*(?:module|ensurepip|runtime)[^]*(?:not available|unavailable|error)/i,
  /(?:executable|interpreter)[^]*(?:not found|unavailable|cannot find|no such file)/i,
]

function isHostRuntimeFailureText(text: string): boolean {
  return HOST_RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * 检测 required runtime / executable / external environment prerequisite 不可用。
 *
 * 结构化、窄范围：仅当已知的 venv-python 验证命令失败、且失败原因是解释器/可执行文件缺失，
 * 并且不存在 scope violation / permission expansion / repo drift / safety blocker 时命中。
 * 这是 ENVIRONMENT_REQUIRED 的 evidence，必须先于纯 timeout → STALLED 判断。
 *
 * W003 BOOTSTRAP CLOSURE：".venv/Scripts/python.exe 不存在"本身不能推出 ENVIRONMENT_REQUIRED。
 * - venv target missing 且无宿主 runtime 失败证据 → recoverable bootstrap prerequisite，
 *   由 Reviewer revise 触发 bootstrap（不是 human-required environment failure）；
 * - venv target missing 且 bootstrap capability 不在 approved capabilities → 不伪装成
 *   environment failure，按既有 permission contract 处理；
 * - 只有真实 bootstrap attempt 失败、证据表明宿主 python / executable / venv module 不可用时，
 *   才归类 ENVIRONMENT_REQUIRED。
 */
function detectEnvironmentPrerequisiteBlock(task: GuardianTask): string | undefined {
  const report = task.lastReport
  if (report === undefined) {
    return undefined
  }

  // 更强的 blocker（scope / repo drift / safety）或 permission 证据存在时，不得归类为 ENVIRONMENT_REQUIRED
  if (report.blockers.length > 0) {
    return undefined
  }
  if (report.permissionDenials !== undefined && report.permissionDenials.length > 0) {
    return undefined
  }

  const structuredFailure = environmentVerificationFailure(report.verificationResults)
  if (structuredFailure !== undefined) {
    const firstFailure = structuredFailure.firstFailure
    const endpoint = firstFailure?.tracebackSnippet.match(
      /\b(?:server at\s+)?["']?((?:\d{1,3}\.){3}\d{1,3})["']?(?:,?\s+port\s+|:)(\d{2,5})/iu,
    )
    const target = endpoint === null || endpoint === undefined
      ? undefined
      : `${endpoint[1]}:${endpoint[2]}`
    const affected = structuredFailure.affectedTests
    return [
      `${firstFailure?.exceptionType ?? 'External service'} unavailable${target === undefined ? '' : `: ${target}`} — ${firstFailure?.title ?? structuredFailure.finalSummary ?? 'connection failed'}.`,
      'The verification suite did not reach normal test execution.',
      affected === undefined
        ? undefined
        : `${affected} errors originated from the shared ${firstFailure?.phase ?? 'setup'} failure (rootCauseCount=${structuredFailure.rootCauseCount ?? 1}).`,
      'Code execution is complete. Fix the local service/runtime, then retry verification.',
    ].filter((value): value is string => value !== undefined).join(' ')
  }

  for (const result of report.verificationResults) {
    if (result.status !== 'failed') {
      continue
    }
    if (!EXTERNAL_RUNTIME_VERIFICATION_COMMANDS.has(result.name)) {
      continue
    }
    const detail = result.details ?? ''
    if (!isRuntimeUnavailableDetail(detail)) {
      continue
    }

    // venv target 缺失且不存在宿主 runtime 失败证据：recoverable bootstrap prerequisite，
    // 不是 ENVIRONMENT_REQUIRED。bootstrap capability 是否可用都不在此伪装 environment failure。
    if (isVenvTargetMissingDetail(detail) && !isHostRuntimeFailureText(`${report.summary}\n${detail}`)) {
      continue
    }

    const snippet = detail.trim().slice(0, 200)
    return `required runtime/executable unavailable: ${result.name}${
      snippet.length > 0 ? ` (${snippet})` : ''
    }`
  }

  return undefined
}

/** 纯 Reviewer 超时：brain review 阶段失败且原因明确是超时 */
function isPureReviewerTimeout(reason: string): boolean {
  return (
    reason.includes('brain review failed') &&
    (reason.includes('timed out') || reason.includes('timeout'))
  )
}

function isReviewerProtocolFailure(reason: string): boolean {
  return reason === 'brain review failed: reviewer returned malformed Guardian JSON'
}

const REPO_DRIFT_PATTERNS: readonly RegExp[] = [
  /\bREPO_DRIFT\b/u,
  /\bpre-existing changes\b/iu,
  /\brepository checkpoint mismatch\b/iu,
  /\bbranch mismatch\b/iu,
  /\bHEAD mismatch\b/u,
  /\bworktree fingerprint mismatch\b/iu,
  /\bchanged[- ]file[- ]set mismatch\b/iu,
  /\bunexpected (?:repository|worktree) changes?\b/iu,
]

function isRepoDriftReason(reason: string): boolean {
  return REPO_DRIFT_PATTERNS.some((pattern) => pattern.test(reason))
}

const SCOPE_VIOLATION_PATTERNS: readonly RegExp[] = [
  /\bscope violation\b/iu,
  /\boutside (?:the )?allowed scope\b/iu,
  /\binside (?:the )?forbidden scope\b/iu,
  /\bforbidden (?:path|file|scope|operation|action)\b/iu,
]

function hasScopeViolationEvidence(task: GuardianTask, reason: string): boolean {
  const typedReason = /^(?:SCOPE_VIOLATION|SAFETY_BLOCKED):/u.test(reason) ? [reason] : []
  return [...typedReason, ...(task.lastReport?.blockers ?? [])]
    .some((item) => SCOPE_VIOLATION_PATTERNS.some((pattern) => pattern.test(item)))
}

function providerFailureEvidence(task: GuardianTask, reason: string): string {
  const report = task.lastReport
  if (report === undefined) {
    return reason
  }

  return [
    reason,
    report.summary,
    report.incompleteReason,
    ...report.blockers,
    ...report.verificationResults
      .filter((result) => result.status === 'failed')
      .map((result) => result.details),
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('\n')
}

function hasProviderCredentialPrerequisite(evidence: string): boolean {
  const hasProviderAccountPrerequisite =
    /\binsufficient (?:account )?balance\b/iu.test(evidence) ||
    /\binsufficient (?:account )?credits?\b/iu.test(evidence) ||
    /\b(?:billing|account) quota (?:is )?(?:unavailable|exhausted)\b/iu.test(evidence)
  const hasProviderAuthPrerequisite =
    /\b(?:authentication required|provider credentials? required|unauthorized due to provider (?:credential|account) setup)\b/iu.test(
      evidence,
    )

  return hasProviderAccountPrerequisite || hasProviderAuthPrerequisite
}

/**
 * Narrow external Provider credential/account/billing prerequisite evidence.
 * A bare HTTP status, application permission denial, or repository permission
 * problem is intentionally insufficient.
 */
function isProviderCredentialRequired(task: GuardianTask, reason: string): boolean {
  const evidence = providerFailureEvidence(task, reason)
  const hasProviderContext =
    /\b(?:claude code|executor provider|model provider|external provider|ask[- ]?bridge|chatgpt)\b/iu.test(
      evidence,
    )

  return hasProviderContext && hasProviderCredentialPrerequisite(evidence)
}

/**
 * Finding #9: only an Executor Provider credential/account/billing recovery
 * invalidates the checkpoint's Claude session. Brain-only credential recovery,
 * product decisions, repository drift, and other HUMAN_REQUIRED causes keep the
 * Executor session eligible for Exact Resume.
 */
export function isExecutorProviderCredentialRecovery(task: GuardianTask): boolean {
  const reason = task.stopReason ?? 'unknown'
  const evidence = providerFailureEvidence(task, reason)

  if (hasScopeViolationEvidence(task, reason) || isRepoDriftReason(reason)) {
    return false
  }
  if (task.lastReport?.execution?.activeExecutor === 'codex' &&
    ['quota_exhausted', 'auth_required', 'configuration_error', 'model_unavailable'].includes(task.lastReport.execution.lastErrorKind ?? '')) return true

  // Require the Executor context and credential prerequisite to occur in the
  // same structured evidence item. This avoids combining an unrelated Claude
  // mention in one field with an AskBridge credential failure in another.
  return evidence.split('\n').some((item) =>
    /\b(?:claude code|executor provider|model provider)\b/iu.test(item) &&
    hasProviderCredentialPrerequisite(item),
  )
}

/**
 * A user-confirmed Executor credential recovery makes only the failed provider
 * attempt stale. Keep task identity, constraints, Reviewer packet, iteration,
 * and repository checkpoint, but do not present the old 402/auth report as the
 * current execution result to the Reviewer.
 */
function invalidateResolvedExecutorCredentialFailure(task: GuardianTask): GuardianTask {
  const recovered: GuardianTask = { ...task, state: 'READY' }
  delete recovered.lastReport
  delete recovered.stopReason
  delete recovered.brainFailure
  return recovered
}

/**
 * 分类 HumanRequired 类别
 */
export function classifyHumanRequired(task: GuardianTask): HumanRequired {
  const reason = task.stopReason ?? 'unknown'

  if (task.lastReport?.execution?.lastErrorKind === 'no_op_execution' ||
      reason.startsWith('NO_OP_EXECUTION:')) {
    return { category: 'EXECUTOR_RETRY_REQUIRED', reason }
  }

  if (reason.startsWith('EXECUTOR_ENVIRONMENT_UNAVAILABLE:')) {
    return { category: 'ENVIRONMENT_REQUIRED', reason }
  }

  // W004-B hard boundary：精确 stop marker → BUDGET_EXHAUSTED（优先级最高）。
  // 不得映射成 DECISION_REQUIRED / STALLED / ENVIRONMENT_REQUIRED。
  if (reason.includes('WORK_SESSION_HARD_LIMIT_REACHED')) {
    return {
      category: 'BUDGET_EXHAUSTED',
      reason: 'work session hard time boundary reached',
    }
  }

  // Max iterations reached
  if (reason.includes('max iterations')) {
    return {
      category: 'STALLED',
      reason,
    }
  }

  // Repo drift：只依赖结构化 marker 或明确 mismatch/unexpected-change 语义。
  if (isRepoDriftReason(reason)) {
    return {
      category: 'REPO_DRIFT',
      reason,
    }
  }

  // Scope violation
  if (hasScopeViolationEvidence(task, reason)) {
    return {
      category: 'SAFETY_BLOCKED',
      reason,
    }
  }

  // Permission required (capability 不足)
  if (task.lastReport?.execution?.activeExecutor === 'codex' && task.lastReport.execution.lastErrorKind !== undefined) {
    return { category: ['quota_exhausted', 'auth_required'].includes(task.lastReport.execution.lastErrorKind)
      ? 'CREDENTIAL_REQUIRED' : 'ENVIRONMENT_REQUIRED', reason: task.lastReport.execution.lastError ?? reason }
  }

  // Permission required (capability 不足)
  // 不依赖英文关键词，根据结构化证据判断
  if (
    task.lastReport?.permissionDenials !== undefined &&
    task.lastReport.permissionDenials.length > 0 &&
    task.lastReport.blockers.length === 0 &&
    task.lastPacket?.verdict === 'blocked'
  ) {
    return {
      category: 'PERMISSION_REQUIRED',
      reason,
    }
  }

  // Verification 需要额外授权
  const verificationCommand = pendingVerificationCommand(task)
  if (verificationCommand !== undefined) {
    return {
      category: 'DECISION_REQUIRED',
      reason: `${VERIFICATION_APPROVAL_BLOCKER}${verificationCommand}`,
    }
  }

  // 外部 Provider credential/account/billing 前置条件不是产品决策。
  if (isProviderCredentialRequired(task, reason)) {
    return {
      category: 'CREDENTIAL_REQUIRED',
      reason,
    }
  }

  // Environment prerequisite unavailable（如 Python 解释器缺失导致 venv/pytest 无法运行）
  // 不是 DECISION_REQUIRED；必须先于纯 timeout → STALLED 判断，保证后续 timeout 不覆盖
  const environmentBlock = detectEnvironmentPrerequisiteBlock(task)
  if (environmentBlock !== undefined) {
    return {
      category: 'ENVIRONMENT_REQUIRED',
      reason: `${reason}; ${environmentBlock}`,
    }
  }

  // This is a bounded recovery exhaustion, not a user product decision.
  if (isReviewerProtocolFailure(reason)) {
    return {
      category: 'REVIEWER_PROTOCOL_FAILURE',
      reason,
    }
  }

  // 纯 Reviewer timeout 且没有更强 blocker → STALLED（现有等价 stalled semantics）
  const report = task.lastReport
  const hasBlockerEvidence =
    report !== undefined &&
    (report.blockers.length > 0 ||
      (report.permissionDenials !== undefined && report.permissionDenials.length > 0))
  if (isPureReviewerTimeout(reason) && !hasBlockerEvidence) {
    return {
      category: 'STALLED',
      reason,
    }
  }

  // 默认为需要人决策
  return {
    category: 'DECISION_REQUIRED',
    reason,
  }
}

export interface GuardianWorkSessionTaskRunnerOptions {
  brain: GuardianBrain
  createExecutor: (
    task: WorkSessionTask,
    resumeData?: unknown,
    onProgress?: GuardianProgressObserver,
    approvedVerificationCommand?: string,
  ) => GuardianRecoverableExecutor
  createGuardianTask?: (task: WorkSessionTask, resumeData?: unknown) => GuardianTask
  taskBuilder?: GuardianTaskBuilderOptions
  /** W003: Repository 信息（用于 checkpoint） */
  repoPath?: string
  /** W003: Git 命令运行器（用于 checkpoint） */
  gitRunner?: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  /** W004-B: 可注入 clock，用于 hard deadline 判断（缺省 Date.now） */
  clock?: { now(): number }
  /** W005-A: 纯 additive Guardian progress observer，原样透传给 runGuardianTask。 */
  onProgress?: GuardianProgressObserver
  /** Defaults to one bounded retry for each transient Brain review timeout. */
  maxBrainReviewRetries?: number
  /** Defaults to one bounded Brain provider-session rotation per review operation. */
  maxBrainReviewSessionRotations?: number
  /** Hard timeout for one Brain provider operation. */
  brainReviewAttemptTimeoutMs?: number
  /** Shared wall-clock budget for one complete Brain Review. */
  brainReviewTotalBudgetMs?: number
  /** Minimum remaining wall-clock budget required before starting an operation. */
  minimumBrainReviewAttemptBudgetMs?: number
}

/**
 * Guardian Work Session Task Runner
 * 桥接 runGuardianTask 和 Work Session Runtime
 *
 * V1 compatibility adapter for the Guardian-centric control plane
 * (`controlPlane: 'v1'`). The V2 path uses V2ControllerTaskRunner instead; this
 * adapter keeps V1 working and must not drive V2 decisions.
 */
export class GuardianWorkSessionTaskRunner implements WorkSessionTaskRunner {
  constructor(private readonly options: GuardianWorkSessionTaskRunnerOptions) {}

  /**
   * W003: 捕获 repository checkpoint
   */
  private async captureRepositoryCheckpoint(
    repoPath: string,
  ): Promise<RepositoryCheckpoint | undefined> {
    if (this.options.gitRunner === undefined) {
      return undefined
    }

    try {
      const branchResult = await this.options.gitRunner('git branch --show-current')
      if (branchResult.exitCode !== 0) {
        return undefined
      }

      const headResult = await this.options.gitRunner('git rev-parse HEAD')
      if (headResult.exitCode !== 0) {
        return undefined
      }

      const statusResult = await this.options.gitRunner('git status --porcelain --untracked-files=all')
      if (statusResult.exitCode !== 0) {
        return undefined
      }

      const entries = parseGitStatus(statusResult.stdout)
      const changedFiles = entries.map((e) => e.path)

      return {
        repoPath,
        branch: branchResult.stdout.trim(),
        headSha: headResult.stdout.trim(),
        changedFiles,
        worktreeFingerprint: await computeWorktreeFingerprint(repoPath, entries),
      }
    } catch {
      return undefined
    }
  }

  /**
   * W003: 捕获 provider session state
   *
   * checkpoint 必须绑定当前 Task：只读取 taskId 对应的 conversation URL。
   * 禁止 first key / arbitrary key 猜测，否则会把另一个任务的 URL 写进 checkpoint。
   */
  private captureProviderSessionState(
    taskId: string,
    brain: GuardianBrain,
    executor: GuardianRecoverableExecutor,
  ): ProviderSessionState {
    const state: ProviderSessionState = {}

    // 捕获 brain state（如 ChatGPT conversation URL）
    if ('captureProviderState' in brain && typeof brain.captureProviderState === 'function') {
      const brainState = brain.captureProviderState()
      if (typeof brainState === 'object' && brainState !== null) {
        const staleTaskIds: readonly unknown[] =
          'staleTaskIds' in brainState && Array.isArray(brainState.staleTaskIds)
          ? brainState.staleTaskIds
          : []
        const conversationIsStale = staleTaskIds.some((value) => value === taskId)
        if (conversationIsStale) {
          state.chatgptConversationStale = true
        }
        // 通用处理：不依赖 AskBridgeBrain 具体结构，但显式按 taskId 读取
        if (
          !conversationIsStale &&
          'taskConversationUrls' in brainState &&
          typeof brainState.taskConversationUrls === 'object'
        ) {
          const urls = brainState.taskConversationUrls as Record<string, string | undefined>
          const url = urls[taskId]
          if (url !== undefined) {
            state.chatgptConversationUrl = url
          }
        }
        if ('configuration' in brainState) {
          const configuration = readChatGptConfiguration(brainState.configuration)
          if (configuration !== undefined) state.chatgptConfiguration = configuration
        }
      }
    }

    // 捕获 executor state（如 Claude sessionId）
    if (typeof executor.captureProviderState === 'function') {
      const executorState = executor.captureProviderState()
      if (executorState.codingExecution !== undefined) state.codingExecution = executorState.codingExecution
      if (executorState.claudeSessionId !== undefined) {
        state.claudeSessionId = executorState.claudeSessionId
      }
    }

    return state
  }

  private async captureTaskCheckpoint(
    task: GuardianTask,
    workSessionTask: WorkSessionTask,
    executor: GuardianRecoverableExecutor,
  ): Promise<GuardianTaskRecoveryCheckpoint | undefined> {
    if (this.options.repoPath === undefined) {
      return undefined
    }
    const repoCheckpoint = await this.captureRepositoryCheckpoint(this.options.repoPath)
    if (repoCheckpoint === undefined) {
      return undefined
    }
    const checkpointTask = { ...task }
    // Runtime consumed this approval before starting the current Guardian run.
    // Persisting it would incorrectly turn a one-shot verifier fact into a
    // reusable recovery capability.
    delete checkpointTask.approvedVerificationCommand
    return {
      version: 1,
      task: checkpointTask,
      provider: this.captureProviderSessionState(
        workSessionTask.id,
        this.options.brain,
        executor,
      ),
      repo: repoCheckpoint,
      capturedAt: new Date().toISOString(),
    }
  }

  /**
   * W003: 从 checkpoint 恢复 provider state
   */
  private restoreProviderState(
    checkpoint: GuardianTaskRecoveryCheckpoint,
    brain: GuardianBrain,
    executor: GuardianRecoverableExecutor,
    restoreExecutorSession: boolean,
  ): void {
    const providerState = checkpoint.provider

    // 恢复 brain state（如 ChatGPT conversation URL）
    if (
      'restoreProviderState' in brain &&
      typeof brain.restoreProviderState === 'function'
    ) {
      const mustStartFresh = providerState.chatgptConversationStale === true ||
        providerState.chatgptConversationUrl === undefined
      // 通用处理：不依赖 AskBridgeBrain 具体类型
      const brainState = {
        taskConversationUrls: mustStartFresh
          ? {}
          : { [checkpoint.task.id]: providerState.chatgptConversationUrl as string },
        reviewedTaskIds: mustStartFresh
          ? []
          : [checkpoint.task.id],
        staleTaskIds: mustStartFresh
          ? [checkpoint.task.id]
          : [],
        ...(providerState.chatgptConfiguration === undefined
          ? {}
          : { configuration: providerState.chatgptConfiguration }),
      }
      brain.restoreProviderState(brainState)
    }

    // 恢复 executor state（如 Claude sessionId）
    if (
      (providerState.codingExecution !== undefined || (restoreExecutorSession && providerState.claudeSessionId !== undefined)) &&
      typeof executor.restoreProviderState === 'function'
    ) {
      executor.restoreProviderState({
        ...(restoreExecutorSession && providerState.claudeSessionId !== undefined ? { claudeSessionId: providerState.claudeSessionId } : {}),
        ...(providerState.codingExecution === undefined ? {} : { codingExecution: providerState.codingExecution }),
      })
    }
  }

  /**
   * W003: resume 前 RepositoryCheckpoint 前置验证（fail-closed gate）
   *
   * 必须在任何 provider execution（Brain review / Executor execute）之前完成：
   * - repo path / branch / HEAD / worktree fingerprint 全部 match 才放行；
   * - provider sessions 缺失不能绕过 checkpoint；
   * - 也不会因为没有 provider session 而要求 worktree clean。
   * 只读 git 命令，绝无 reset/clean/restore/checkout 等破坏性操作。
   */
  async verifyRecoveryCheckpoint(
    checkpoint: GuardianTaskRecoveryCheckpoint,
  ): Promise<{ ok: boolean; reason?: string; category?: string }> {
    const repoPath = this.options.repoPath
    const gitRunner = this.options.gitRunner
    if (repoPath === undefined || gitRunner === undefined) {
      // fail closed：缺少 repo identity 验证能力时不得自动信任 checkpoint。
      // 无法验证 RepositoryCheckpoint → 无法证明 repository 未 drift → 统一归类 REPO_DRIFT。
      // 不做任何 provider 恢复 / recovery continuation / Brain / Executor 启动。
      return {
        ok: false,
        reason: 'checkpoint verification unavailable',
        category: 'REPO_DRIFT',
      }
    }

    try {
      if (checkpoint.repo.repoPath !== repoPath) {
        return {
          ok: false,
          reason: `REPO_DRIFT: repo path changed from ${checkpoint.repo.repoPath} to ${repoPath}`,
        }
      }

      const branchResult = await gitRunner('git branch --show-current')
      if (branchResult.exitCode !== 0) {
        return { ok: false, reason: 'REPO_DRIFT: cannot read current branch' }
      }
      if (branchResult.stdout.trim() !== checkpoint.repo.branch) {
        return {
          ok: false,
          reason: `REPO_DRIFT: branch changed from ${checkpoint.repo.branch} to ${branchResult.stdout.trim()}`,
        }
      }

      const headResult = await gitRunner('git rev-parse HEAD')
      if (headResult.exitCode !== 0) {
        return { ok: false, reason: 'REPO_DRIFT: cannot read HEAD' }
      }
      if (headResult.stdout.trim() !== checkpoint.repo.headSha) {
        return {
          ok: false,
          reason: `REPO_DRIFT: HEAD changed from ${checkpoint.repo.headSha.slice(0, 8)} to ${headResult.stdout.trim().slice(0, 8)}`,
        }
      }

      const statusResult = await gitRunner('git status --porcelain --untracked-files=all')
      if (statusResult.exitCode !== 0) {
        return { ok: false, reason: 'REPO_DRIFT: cannot read git status' }
      }
      const entries = parseGitStatus(statusResult.stdout)
      const fingerprint = await computeWorktreeFingerprint(repoPath, entries)
      if (fingerprint !== checkpoint.repo.worktreeFingerprint) {
        return { ok: false, reason: 'REPO_DRIFT: worktree files changed since checkpoint' }
      }

      return { ok: true }
    } catch {
      return { ok: false, reason: 'REPO_DRIFT: checkpoint verification failed' }
    }
  }

  async run(
    workSessionTask: WorkSessionTask,
    resumeData?: any,
    checkpoint?: GuardianTaskRecoveryCheckpoint,
    context?: WorkSessionTaskRunContext,
  ): Promise<WorkSessionTaskResult> {
    const sanitizedResumeInput = sanitizeResumeInput(resumeData)
    // W003 Task Identity gate：checkpoint 只能授权它所属的 Task（fail-closed）
    // 不靠 repository checkpoint 单独授权另一个 Task；必须最先判断，不做任何 git/provider 调用
    if (checkpoint !== undefined && checkpoint.task.id !== workSessionTask.id) {
      return {
        status: 'HUMAN_REQUIRED',
        summary: `checkpoint task ${checkpoint.task.id} does not match work session task ${workSessionTask.id}`,
        humanRequired: {
          category: 'SAFETY_BLOCKED',
          reason: `checkpoint task ${checkpoint.task.id} does not match work session task ${workSessionTask.id}`,
        },
      }
    }

    // 从 checkpoint 或新建 Guardian Task
    let guardianTask = checkpoint?.task ?? (
      this.options.createGuardianTask
        ? this.options.createGuardianTask(workSessionTask, sanitizedResumeInput)
        : createGuardianTask(workSessionTask, this.options.taskBuilder)
    )

    const onProgress: GuardianProgressObserver | undefined =
      this.options.onProgress !== undefined || context?.onProgress !== undefined
        ? (event) => {
            // Both sinks are observability-only. One consumer must not prevent
            // the other or alter Guardian execution.
            try { this.options.onProgress?.(event) } catch {}
            try { context?.onProgress?.(event) } catch {}
          }
        : undefined

    // 为每个 Work Session Task 创建新的 Executor instance. Production hook
    // events use this same merged sink, so UI and durable Ledger see identical facts.
    const executor = this.options.createExecutor(
      workSessionTask,
      sanitizedResumeInput,
      onProgress,
      context?.approvedVerificationCommand,
    )

    // W003: 如果有 checkpoint，先做 repo gate —— 任何 provider execution 之前
    if (checkpoint !== undefined) {
      const gate = await this.verifyRecoveryCheckpoint(checkpoint)
      if (!gate.ok) {
        return {
          status: 'HUMAN_REQUIRED',
          ...(gate.reason !== undefined ? { summary: gate.reason } : {}),
          humanRequired: {
            category: gate.category ?? 'REPO_DRIFT',
            reason: gate.reason ?? 'REPO_DRIFT',
          },
        }
      }

      // Finding #9: credential/account/billing recovery for the Executor may
      // mean that an externally selected Provider/account has changed. Keep
      // the independently healthy Brain session, but do not inject the stale
      // Claude session into the new Executor instance. Repository recovery is
      // still authorized solely by the already-passed fail-closed gate above.
      const executorCredentialRecovery = isExecutorProviderCredentialRecovery(checkpoint.task)
      const restoreExecutorSession = !executorCredentialRecovery
      this.restoreProviderState(
        checkpoint,
        this.options.brain,
        executor,
        restoreExecutorSession,
      )

      // W003: recovery continuation 只取决于"本次 run() 携带并成功验证了 checkpoint"。
      // 通过 task identity gate（run 顶部）与 RepositoryCheckpoint gate（上方）之后即视为延续，
      // 不由 sessionId / conversationUrl / lastPacket / lastReport 推断。
      guardianTask = {
        ...(executorCredentialRecovery
          ? invalidateResolvedExecutorCredentialFailure(checkpoint.task)
          : checkpoint.task),
        recoveryContinuation: true,
        resumeInput: sanitizedResumeInput,
      }

      // 如果 executor 支持 setRecoveryCheckpoint，设置 checkpoint
      if (typeof executor.setRecoveryCheckpoint === 'function') {
        executor.setRecoveryCheckpoint({
          repoPath: checkpoint.repo.repoPath,
          branch: checkpoint.repo.branch,
          headSha: checkpoint.repo.headSha,
          changedFiles: checkpoint.repo.changedFiles,
          worktreeFingerprint: checkpoint.repo.worktreeFingerprint,
        })
      }
    }

    if (checkpoint === undefined && Object.keys(sanitizedResumeInput).length > 0) {
      guardianTask = { ...guardianTask, resumeInput: sanitizedResumeInput }
    }

    if (context?.approvedVerificationCommand !== undefined) {
      guardianTask = {
        ...guardianTask,
        approvedVerificationCommand: context.approvedVerificationCommand,
      }
    }

    // 运行 Guardian
    // W004-B: context.hardDeadlineAtMs + 可测试 clock → 构造 shouldStopAutonomousWork。
    // 未提供 deadline 时不注入 hook，现有 Guardian behavior 100% 不变。
    const hardDeadlineAtMs = context?.hardDeadlineAtMs
    const result = await runGuardianTask({
      task: guardianTask,
      brain: this.options.brain,
      executor,
      ...(hardDeadlineAtMs !== undefined
        ? {
            shouldStopAutonomousWork: () =>
              (this.options.clock?.now() ?? Date.now()) >= hardDeadlineAtMs,
          }
        : {}),
      ...(context?.shouldPauseAutonomousWork !== undefined
        ? { shouldPauseAutonomousWork: context.shouldPauseAutonomousWork }
        : {}),
      ...(onProgress === undefined ? {} : { onProgress }),
      maxBrainReviewRetries: this.options.maxBrainReviewRetries ?? 1,
      maxBrainReviewSessionRotations: this.options.maxBrainReviewSessionRotations ?? 1,
      ...(this.options.brainReviewAttemptTimeoutMs === undefined
        ? {}
        : { brainReviewAttemptTimeoutMs: this.options.brainReviewAttemptTimeoutMs }),
      ...(this.options.brainReviewTotalBudgetMs === undefined
        ? {}
        : { brainReviewTotalBudgetMs: this.options.brainReviewTotalBudgetMs }),
      ...(this.options.minimumBrainReviewAttemptBudgetMs === undefined
        ? {}
        : { minimumBrainReviewAttemptBudgetMs: this.options.minimumBrainReviewAttemptBudgetMs }),
      ...(this.options.clock === undefined ? {} : { brainReviewClock: this.options.clock }),
    })

    // 映射结果
    if (result.task.state === 'COMPLETED') {
      // W004-A: 真 COMPLETED 时把最小结构化 evidence 返回给 WorkSession。
      // COMPLETED 语义已保证 lastReport 存在、verification 全 passed、blockers 为空、
      // lastPacket.verdict === 'done'；这里只摘取 Git finalization 必要字段，
      // 不把完整 Guardian 内部对象泄漏给 WorkSession。
      const report = result.task.lastReport
      const packet = result.task.lastPacket
      const completionEvidence: TaskCompletionEvidence | undefined =
        report !== undefined && packet !== undefined
          ? {
              changedFiles: report.changedFiles,
              verificationResults: report.verificationResults,
              blockers: report.blockers,
              finalReviewerVerdict: packet.verdict,
              requiredVerification: packet.verification,
              ...(report.incompleteReason !== undefined
                ? { incompleteReason: report.incompleteReason }
                : {}),
            }
          : undefined

      return {
        status: 'COMPLETED',
        ...(result.task.lastReport?.summary !== undefined
          ? { summary: result.task.lastReport.summary }
          : {}),
        ...(completionEvidence !== undefined ? { completionEvidence } : {}),
      }
    }

    if (result.task.state === 'FAILED') {
      const failure = classifyWorkSessionFailure(
        result.task.stopReason ?? 'Guardian task failed',
        result.failureStage === undefined ? {} : { failureStage: result.failureStage },
      )
      return {
        status: 'FAILED',
        ...(result.task.stopReason !== undefined
          ? { error: result.task.stopReason }
          : {}),
        failureStage: failure.failureStage,
        failureCategory: failure.failureCategory,
      }
    }

    if (result.task.state === 'BRAIN_INFRASTRUCTURE_FAILED') {
      const capturedCheckpoint = await this.captureTaskCheckpoint(
        result.task,
        workSessionTask,
        executor,
      )
      return {
        status: 'BRAIN_INFRASTRUCTURE_FAILED',
        ...(result.task.lastReport?.summary === undefined
          ? {}
          : { summary: result.task.lastReport.summary }),
        ...(result.task.brainFailure === undefined
          ? {}
          : { brainFailure: result.task.brainFailure }),
        ...(capturedCheckpoint === undefined ? {} : { checkpoint: capturedCheckpoint }),
      }
    }

    if (result.task.stopReason === 'WORK_SESSION_USER_PAUSE_REQUESTED') {
      const capturedCheckpoint = await this.captureTaskCheckpoint(
        result.task,
        workSessionTask,
        executor,
      )
      return {
        status: 'PAUSED',
        ...(result.task.lastReport?.summary !== undefined
          ? { summary: result.task.lastReport.summary }
          : {}),
        ...(capturedCheckpoint !== undefined ? { checkpoint: capturedCheckpoint } : {}),
      }
    }

    if (result.task.state === 'HUMAN_REQUIRED') {
      // W003/W005-B: HUMAN_REQUIRED and PAUSED share exact checkpoint semantics.
      const capturedCheckpoint = await this.captureTaskCheckpoint(
        result.task,
        workSessionTask,
        executor,
      )

      const verificationCommand = pendingVerificationCommand(result.task)
      const verificationFailure = environmentVerificationFailure(
        result.task.lastReport?.verificationResults ?? [],
      )
      return {
        status: 'HUMAN_REQUIRED',
        ...(result.task.lastReport?.summary !== undefined
          ? { summary: result.task.lastReport.summary }
          : {}),
        humanRequired: classifyHumanRequired(result.task),
        ...(verificationCommand === undefined
          ? {}
          : { pendingVerificationCommand: verificationCommand }),
        ...(verificationFailure === undefined ? {} : { verificationFailure }),
        ...(capturedCheckpoint !== undefined ? { checkpoint: capturedCheckpoint } : {}),
      }
    }

    // 不应该到达这里
    return {
      status: 'FAILED',
      error: `unexpected Guardian state: ${result.task.state}`,
    }
  }
}

/**
 * Resolve the one unambiguous scoped-verification candidate supplied either by
 * a blocked Reviewer packet or by Executor's deterministic-verification
 * evidence. Runtime performs the authoritative repo-scoped command parse
 * before persisting any approval.
 */
export function pendingVerificationCommand(task: GuardianTask): string | undefined {
  // A blocked Reviewer may ask for one exact verifier both before Executor and
  // during Final Review. This is only an untrusted candidate: Runtime remains
  // the authority that parses repo scope, fingerprints the command, and decides
  // whether a durable approval can exist.
  const packet = task.lastPacket
  // A Reviewer that supplies more than one verifier is ambiguous even if an
  // Executor report happens to name one of them. Never select from that set.
  if (packet?.verdict === 'blocked' && packet.verification.length > 1) return undefined
  const packetCommand =
    packet?.verdict === 'blocked' &&
    packet.instructions.length === 0 &&
    packet.verification.length === 1
      ? packet.verification[0]
      : undefined

  const report = task.lastReport
  const reportCommands = report === undefined
    ? []
    : report.blockers
      .filter((blocker) => blocker.startsWith(VERIFICATION_APPROVAL_BLOCKER))
      .map((blocker) => blocker.slice(VERIFICATION_APPROVAL_BLOCKER.length))
      .filter((command) => report.verificationResults.some(
        (result) => result.name === command && result.status === 'skipped' &&
          result.details === 'verification command is not in the MVP allowlist',
      ))
  const reportCommand = reportCommands.length === 1 ? reportCommands[0] : undefined

  // Two distinct sources must agree. Ambiguity never creates an approval.
  if (packetCommand !== undefined && reportCommand !== undefined) {
    return packetCommand === reportCommand ? packetCommand : undefined
  }
  return packetCommand ?? reportCommand
}

function sanitizeResumeInput(value: unknown): { decision?: string; approval?: boolean } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const record = value as Record<string, unknown>
  const result: { decision?: string; approval?: boolean } = {}
  if (typeof record.decision === 'string') {
    const decision = record.decision.trim().slice(0, 2_000)
    if (decision.length > 0) {
      result.decision = decision
    }
  }
  if (typeof record.approval === 'boolean') {
    result.approval = record.approval
  }
  return result
}
