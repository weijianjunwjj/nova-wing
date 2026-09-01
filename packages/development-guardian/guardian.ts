import type { GuardianBrain, GuardianExecutor } from './ports.js'
import type {
  DelegationPacket,
  ExecutionReport,
  GuardianBrainAttempt,
  GuardianBrainFailure,
  GuardianBrainOperationKind,
  GuardianRunResult,
  GuardianTask,
} from './model.js'
import type { GuardianProgressObserver, GuardianProgressEvent } from './progress.js'
import {
  GuardianBrainInfrastructureError,
  RetryableGuardianBrainError,
  guardianBrainFailureFrom,
} from './brain-error.js'
import {
  BRAIN_REVIEW_BUDGET_EXHAUSTED_MESSAGE,
  DEFAULT_BRAIN_REVIEW_ATTEMPT_TIMEOUT_MS,
  DEFAULT_BRAIN_REVIEW_TOTAL_BUDGET_MS,
  MINIMUM_BRAIN_REVIEW_ATTEMPT_BUDGET_MS,
} from './brain-review-budget.js'
import { environmentVerificationFailure } from './verification-evidence.js'

export const VERIFICATION_ENVIRONMENT_REQUIRED_STOP =
  'VERIFICATION_ENVIRONMENT_REQUIRED'
export const EXECUTOR_ENVIRONMENT_UNAVAILABLE_STOP =
  'EXECUTOR_ENVIRONMENT_UNAVAILABLE'
export const NO_OP_EXECUTION_STOP = 'NO_OP_EXECUTION'

export class GuardianStopError extends Error {
  constructor(
    message: string,
    public readonly task: GuardianTask,
  ) {
    super(message)
    this.name = 'GuardianStopError'
  }
}

function hasNonPassingVerification(report: ExecutionReport): boolean {
  return report.verificationResults.some((result) => result.status !== 'passed')
}

function requireExecutablePacket(packet: DelegationPacket): void {
  if ((packet.verdict === 'proceed' || packet.verdict === 'revise') && packet.instructions.length === 0) {
    throw new Error('executable delegation packet must include instructions')
  }
}

function mergeUnique(...groups: readonly (readonly string[] | undefined)[]): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))]
}

function enforceTaskConstraints(task: GuardianTask, packet: DelegationPacket): DelegationPacket {
  return {
    ...packet,
    goal: task.goal,
    constraints: mergeUnique(task.constraints, packet.constraints),
    doNotDo: mergeUnique(task.doNotDo, packet.doNotDo),
  }
}

export async function runGuardianTask(options: {
  task: GuardianTask
  brain: GuardianBrain
  executor: GuardianExecutor
  onProgress?: GuardianProgressObserver
  /**
   * W004-B: 纯 additive optional hook。返回 true 时停止当前 Guardian autonomous loop，
   * 不再启动下一 provider operation（Reviewer / Executor），并以
   * WORK_SESSION_HARD_LIMIT_REACHED marker 进入 HUMAN_REQUIRED。
   * 未提供时现有 behavior 100% 不变。
   */
  shouldStopAutonomousWork?: () => boolean
  /**
   * W005-B: user pause is independent from the W004 hard-limit hook. A true
   * result stops before the next provider operation without killing any
   * already-running review/execution.
   */
  shouldPauseAutonomousWork?: () => boolean
  /** Additive bounded retry budget per Brain review operation. Defaults to zero. */
  maxBrainReviewRetries?: number
  /** Additive bounded provider-session rotation budget per review operation. Defaults to zero. */
  maxBrainReviewSessionRotations?: number
  /** Hard timeout for one Brain provider operation. */
  brainReviewAttemptTimeoutMs?: number
  /** Shared wall-clock budget across first attempt, retry, protocol repair, and rotation. */
  brainReviewTotalBudgetMs?: number
  /** Do not start a provider operation with less useful time than this. */
  minimumBrainReviewAttemptBudgetMs?: number
  /** Injectable epoch clock for deterministic Brain budget and timeline tests. */
  brainReviewClock?: { now(): number }
}): Promise<GuardianRunResult> {
  const reports: ExecutionReport[] = []
  let task = { ...options.task }
  const startedAt = performance.now()

  const emitProgress = (
    phase: GuardianProgressEvent['phase'],
    status: GuardianProgressEvent['status'],
    detail?: string,
  ): void => {
    options.onProgress?.({
      phase,
      status,
      iteration: task.iteration,
      elapsedMs: performance.now() - startedAt,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** W004-B: hard boundary 到点 → HUMAN_REQUIRED + 精确 stop marker */
  const stopForHardLimit = (): boolean => {
    if (options.shouldStopAutonomousWork?.() !== true) {
      return false
    }
    task = {
      ...task,
      state: 'HUMAN_REQUIRED',
      stopReason: 'WORK_SESSION_HARD_LIMIT_REACHED',
    }
    emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
    return true
  }

  const stopForUserPause = (): boolean => {
    if (options.shouldPauseAutonomousWork?.() !== true) {
      return false
    }
    task = {
      ...task,
      state: 'HUMAN_REQUIRED',
      stopReason: 'WORK_SESSION_USER_PAUSE_REQUESTED',
    }
    return true
  }

  emitProgress('PREPARING', 'completed')

  // A resolved environment suspension resumes at the deterministic verifier,
  // not at Reviewer/Executor. The repository checkpoint is validated by the
  // Work Session adapter before this function is entered.
  if (
    task.recoveryContinuation === true &&
    task.resumeInput?.approval === true &&
    task.stopReason === VERIFICATION_ENVIRONMENT_REQUIRED_STOP &&
    task.lastReport !== undefined &&
    environmentVerificationFailure(task.lastReport.verificationResults) !== undefined
  ) {
    if (options.executor.retryVerification === undefined) {
      task = { ...task, state: 'HUMAN_REQUIRED' }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }
    try {
      const report = await options.executor.retryVerification({
        task,
        report: task.lastReport,
      })
      reports.push(report)
      task = { ...task, state: 'READY', lastReport: report }
      if (environmentVerificationFailure(report.verificationResults) !== undefined) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: VERIFICATION_ENVIRONMENT_REQUIRED_STOP,
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      delete task.stopReason
    } catch (error) {
      task = {
        ...task,
        state: 'FAILED',
        stopReason: error instanceof Error ? error.message : 'verification retry failed',
      }
      emitProgress('FAILED', 'completed', task.stopReason)
      return { task, reports, failureStage: 'VERIFICATION' }
    }
  }

  // A confirmed no-op retry preserves the Task and scope, but discards the
  // non-credible report so Reviewer/Executor can perform a genuine new attempt.
  if (
    task.recoveryContinuation === true &&
    task.resumeInput?.approval === true &&
    task.stopReason?.startsWith(NO_OP_EXECUTION_STOP) === true &&
    task.lastReport?.changedFiles.length === 0
  ) {
    task = { ...task, state: 'READY' }
    delete task.lastReport
    delete task.stopReason
  }

  while (true) {
    // W004-B checkpoint A：每次开始新的 Brain review 前。绝不 kill 正在 mutation 的 process。
    if (stopForHardLimit()) {
      return { task, reports }
    }
    if (stopForUserPause()) {
      return { task, reports }
    }

    if (task.iteration >= task.maxIterations) {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: `max iterations reached: ${task.maxIterations}`,
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    task = { ...task, state: 'REVIEWING' }
    const reviewPhase = task.lastReport === undefined ? 'REVIEWING' : 'FINAL_REVIEW'
    emitProgress(reviewPhase, 'active')
    let packet: DelegationPacket
    let brainReviewAttempt = 0
    let protocolRepair = false
    const brainClock = options.brainReviewClock ?? { now: () => Date.now() }
    const reviewStartedAtMs = brainClock.now()
    const reviewDeadlineAtMs = reviewStartedAtMs +
      (options.brainReviewTotalBudgetMs ?? DEFAULT_BRAIN_REVIEW_TOTAL_BUDGET_MS)
    const perAttemptTimeoutMs =
      options.brainReviewAttemptTimeoutMs ?? DEFAULT_BRAIN_REVIEW_ATTEMPT_TIMEOUT_MS
    const minimumAttemptBudgetMs = options.minimumBrainReviewAttemptBudgetMs ??
      MINIMUM_BRAIN_REVIEW_ATTEMPT_BUDGET_MS
    const attemptTimeline: GuardianBrainAttempt[] = []
    let nextOperationKind: GuardianBrainOperationKind = 'normal'
    let lastFailure: GuardianBrainFailure | undefined

    const budgetExhaustedError = (): GuardianBrainInfrastructureError =>
      new GuardianBrainInfrastructureError(BRAIN_REVIEW_BUDGET_EXHAUSTED_MESSAGE, {
        category: 'TRANSPORT',
        failureType: lastFailure?.failureType === 'BRAIN_UNAVAILABLE'
          ? 'BRAIN_UNAVAILABLE'
          : 'BRAIN_TRANSPORT_FAILED',
        safeMessage: BRAIN_REVIEW_BUDGET_EXHAUSTED_MESSAGE,
        adapter: lastFailure?.adapter ?? 'guardian-brain',
        ...(lastFailure?.requestedModel === undefined
          ? {}
          : { requestedModel: lastFailure.requestedModel }),
        ...(lastFailure?.requestedReasoning === undefined
          ? {}
          : { requestedReasoning: lastFailure.requestedReasoning }),
        degraded: lastFailure?.degraded ?? false,
        fingerprint: 'brain-transport:review-time-budget-exhausted',
      })

    const remainingBudgetForNextOperation = (): number => {
      const remainingMs = reviewDeadlineAtMs - brainClock.now()
      if (remainingMs < minimumAttemptBudgetMs) {
        throw budgetExhaustedError()
      }
      return remainingMs
    }
    try {
      let retriesRemaining = options.maxBrainReviewRetries ?? 0
      let rotationsRemaining = options.maxBrainReviewSessionRotations ?? 0
      while (true) {
        const remainingBudgetMs = remainingBudgetForNextOperation()
        const operationStartedAtMs = brainClock.now()
        const operationKind = nextOperationKind
        const transportTimeoutMs = Math.min(perAttemptTimeoutMs, remainingBudgetMs)
        try {
          brainReviewAttempt += 1
          packet = await options.brain.review({
            task,
            ...(task.lastReport === undefined ? {} : { report: task.lastReport }),
            ...(protocolRepair ? { protocolRepair: true } : {}),
            transportTimeoutMs,
          })
          const transport = options.brain.captureLastTransportMetrics?.()
          attemptTimeline.push({
            attempt: brainReviewAttempt,
            operationKind,
            startedAt: new Date(operationStartedAtMs).toISOString(),
            durationMs: Math.max(0, Math.round(brainClock.now() - operationStartedAtMs)),
            outcome: 'success',
            failureType: null,
            fingerprint: null,
            timeout: false,
            ...(transport === undefined ? {} : { transport }),
          })
          break
        } catch (error) {
          lastFailure = guardianBrainFailureFrom(error)
          const transport = options.brain.captureLastTransportMetrics?.()
          attemptTimeline.push({
            attempt: brainReviewAttempt,
            operationKind,
            startedAt: new Date(operationStartedAtMs).toISOString(),
            durationMs: Math.max(0, Math.round(brainClock.now() - operationStartedAtMs)),
            outcome: 'failure',
            failureType: lastFailure.failureType ?? null,
            fingerprint: lastFailure.fingerprint,
            timeout: error instanceof RetryableGuardianBrainError && error.kind === 'timeout',
            ...(transport === undefined ? {} : { transport }),
          })
          if (!(error instanceof RetryableGuardianBrainError)) {
            throw error
          }

          if (error.kind === 'conversation') {
            if (
              rotationsRemaining > 0 &&
              options.brain.resetTaskReviewSession !== undefined
            ) {
              // A continuation identity failure cannot be repaired by retrying
              // the same URL. Rotate once within the review-operation budget,
              // then resubmit the unchanged Guardian task and execution evidence.
              if (stopForHardLimit() || stopForUserPause()) {
                return { task, reports }
              }
              remainingBudgetForNextOperation()
              options.brain.resetTaskReviewSession(task.id)
              rotationsRemaining -= 1
              nextOperationKind = 'rotation'
              emitProgress(reviewPhase, 'active', 'rotating stale brain conversation')
              continue
            }
            if (reviewDeadlineAtMs - brainClock.now() < minimumAttemptBudgetMs) {
              throw budgetExhaustedError()
            }
            throw error
          }

          if (retriesRemaining > 0) {
            retriesRemaining -= 1
            if (error.kind === 'protocol') protocolRepair = true
            // Every retry starts a new provider operation and must cross both
            // autonomous safety boundaries before the next invocation.
            if (stopForHardLimit() || stopForUserPause()) {
              return { task, reports }
            }
            remainingBudgetForNextOperation()
            nextOperationKind = 'retry'
            emitProgress(reviewPhase, 'active', 'retrying retryable brain failure')
            continue
          }

          if (
            rotationsRemaining > 0 &&
            options.brain.resetTaskReviewSession !== undefined
          ) {
            // Rotation plus its fresh review is another provider operation and
            // must cross the autonomous boundary before changing provider state.
            if (stopForHardLimit() || stopForUserPause()) {
              return { task, reports }
            }
            remainingBudgetForNextOperation()
            options.brain.resetTaskReviewSession(task.id)
            rotationsRemaining -= 1
            nextOperationKind = 'rotation'
            emitProgress(reviewPhase, 'active', 'rotating retryable brain session')
            continue
          }

          if (reviewDeadlineAtMs - brainClock.now() < minimumAttemptBudgetMs) {
            throw budgetExhaustedError()
          }
          throw error
        }
      }
      requireExecutablePacket(packet)
      emitProgress(reviewPhase, 'completed')
    } catch (error) {
      emitProgress(reviewPhase, 'failed', error instanceof Error ? error.message : String(error))
      const classifiedFailure = guardianBrainFailureFrom(error)
      const brainFailure = {
        ...classifiedFailure,
        stage: reviewPhase === 'FINAL_REVIEW' ? 'FINAL_REVIEW' as const : 'BRAIN_REVIEW' as const,
        ...(brainReviewAttempt === 0 ? {} : { attempt: brainReviewAttempt }),
        timestamp: new Date(brainClock.now()).toISOString(),
        lastReliableCheckpoint: task.lastReport === undefined ? 'BEFORE_EXECUTOR' : 'AFTER_EXECUTOR_VERIFICATION',
        nextResumableAction: reviewPhase,
        attemptTimeline,
      }
      task = {
        ...task,
        state: 'BRAIN_INFRASTRUCTURE_FAILED',
        stopReason: brainFailure.rootCause,
        brainFailure,
      }
      emitProgress('BRAIN_INFRASTRUCTURE_FAILED', 'completed', task.stopReason)
      return { task, reports }
    }
    task = { ...task, lastPacket: packet }

    if (packet.verdict === 'blocked') {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: packet.rationale ?? 'brain reported blocked',
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    if (packet.verdict === 'done') {
      if (task.lastReport === undefined) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete before any execution evidence',
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      if (task.lastReport.verificationResults.length === 0) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete without deterministic verification evidence',
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      if (hasNonPassingVerification(task.lastReport)) {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: 'brain attempted to complete with non-passing deterministic verification',
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
      task = { ...task, state: 'COMPLETED' }
      delete task.stopReason
      emitProgress('COMPLETED', 'completed')
      return { task, reports }
    }

    // W004-B checkpoint B：Reviewer 已返回、但开始新的 Executor execute 前。
    // verdict 为 proceed/revise（blocked/done 已在上方 return），此处到点则不再启动 Executor。
    if (stopForHardLimit()) {
      return { task, reports }
    }
    if (stopForUserPause()) {
      return { task, reports }
    }

    const executionPacket = enforceTaskConstraints(task, packet)
    if (options.executor.preflight !== undefined) {
      try {
        await options.executor.preflight(task)
      } catch {
        task = {
          ...task,
          state: 'HUMAN_REQUIRED',
          stopReason: `${EXECUTOR_ENVIRONMENT_UNAVAILABLE_STOP}: workspace, shell, Git, or executor tool preflight failed`,
        }
        emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
        return { task, reports }
      }
    }
    task = {
      ...task,
      state: 'EXECUTING',
      iteration: task.iteration + 1,
      lastPacket: executionPacket,
    }

    emitProgress('EXECUTING', 'active')
    let report: ExecutionReport
    try {
      report = await options.executor.execute({ task, packet: executionPacket })
      emitProgress('EXECUTING', 'completed')
    } catch (error) {
      emitProgress('EXECUTING', 'failed', error instanceof Error ? error.message : String(error))
      task = {
        ...task,
        state: 'FAILED',
        stopReason: error instanceof Error ? error.message : 'executor failed',
      }
      emitProgress('FAILED', 'completed', task.stopReason)
      return { task, reports, failureStage: 'EXECUTOR' }
    }

    reports.push(report)
    task = { ...task, lastReport: report }

    // Stable structured evidence wins before Reviewer text. An unavailable
    // service/runtime cannot ask the Reviewer to revise code it did not break.
    if (environmentVerificationFailure(report.verificationResults) !== undefined) {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: VERIFICATION_ENVIRONMENT_REQUIRED_STOP,
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    if (report.blockers.length > 0) {
      task = {
        ...task,
        state: 'HUMAN_REQUIRED',
        stopReason: report.blockers.join('; '),
      }
      emitProgress('HUMAN_REQUIRED', 'completed', task.stopReason)
      return { task, reports }
    }

    // 如果有 incompleteReason 但没有 blockers，重新进入 REVIEWING
    // 让 Brain 根据当前进展判断是否 revise
    if (report.incompleteReason !== undefined) {
      emitProgress('EXECUTING', 'completed', report.incompleteReason)
      // 继续循环，重新进入 REVIEWING
      continue
    }
  }
}
