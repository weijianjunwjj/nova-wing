import { basename } from 'node:path'

import type { HumanRequired, WorkSessionDefinition, WorkSessionDurableState } from './model.js'
import type { TaskRunSummary } from './task-run-analytics.js'
import {
  safeFailureMessage,
  type WorkSessionFailureCategory,
  type WorkSessionFailureStage,
} from './failure-classification.js'

export interface HumanRequiredNotification {
  notificationId: string
  session: {
    id: string
    targetRepo: string
    branch: string
  }
  progress: {
    completedTaskIds: readonly string[]
    currentTaskId: string | null
  }
  humanRequired: HumanRequired
  recommendation?: string
  control: {
    localUrl?: string
    instruction: string
  }
}

export interface WorkSessionCompletedNotification {
  notificationId: string
  session: {
    id: string
    targetRepo: string
    branch: string
  }
  completedTaskIds: readonly string[]
  completionReason: 'ALL_TASKS_COMPLETED'
  activeElapsedMs?: number
  analytics?: TaskRunSummary
  reportUrl?: string
}

export interface WorkSessionFailedNotification {
  notificationId: string
  session: {
    id: string
    targetRepo: string
    branch: string
  }
  currentTaskId: string | null
  failureStage: WorkSessionFailureStage
  failureCategory: WorkSessionFailureCategory
  safeReason: string
  activeElapsedMs?: number
  control: { localUrl?: string }
  analytics?: TaskRunSummary
  reportUrl?: string
}

export interface WorkSessionRecoveryRequiredNotification {
  notificationId: string
  session: {
    id: string
    targetRepo: string
    branch: string
  }
  currentTaskId: string | null
  stage: 'BRAIN_REVIEW' | 'FINAL_REVIEW'
  category: string
  safeMessage: string
  recommendation: string
  control: { localUrl?: string }
}

export interface WorkSessionNotifier {
  notifyHumanRequired(notification: HumanRequiredNotification): Promise<void>
  /** Additive so existing test/local notifiers remain compatible. Production SMTP implements it. */
  notifyCompleted?(notification: WorkSessionCompletedNotification): Promise<void>
  /** Additive FAILED terminal capability; production SMTP implements it. */
  notifyFailed?(notification: WorkSessionFailedNotification): Promise<void>
  /** Additive infrastructure-recovery capability; production SMTP implements it. */
  notifyRecoveryRequired?(notification: WorkSessionRecoveryRequiredNotification): Promise<void>
  /**
   * Additive per-channel delivery. A notifier that reports several channels
   * implements this so one failing channel can never overwrite another
   * channel's truth. Single-channel notifiers may omit it.
   */
  notifyChannels?(
    kind: WorkSessionNotificationKind,
    notification: WorkSessionNotificationPayload,
  ): Promise<readonly NotificationChannelResult[]>
  /** Additive: the channel this notifier reports as when `notifyChannels` is absent. */
  readonly notificationChannel?: NotificationChannel
  /**
   * Additive: the notification kinds this notifier actually delivers. A notifier
   * that implements `notifyHumanRequired` only as a deliberate no-op (the desktop
   * toast channel) declares its real kinds here so the runtime never schedules a
   * notification that cannot be delivered.
   */
  readonly notificationKinds?: readonly WorkSessionNotificationKind[]
}

export type NotificationDeliveryStatus = 'SENT' | 'FAILED'

/** A real delivery channel. A channel that is not applicable is SKIPPED, never FAILED. */
export type NotificationChannel = 'EMAIL' | 'DESKTOP'

export type NotificationChannelStatus = 'SENT' | 'FAILED' | 'SKIPPED'

/** One channel's own delivery truth; a failure here never rewrites another channel. */
export interface NotificationChannelResult {
  channel: NotificationChannel
  status: NotificationChannelStatus
  reason?: string
}

/** Aggregated outcome across channels. PARTIAL_SUCCESS must never render as "发送失败". */
export type NotificationOverallStatus = 'ALL_SUCCEEDED' | 'PARTIAL_SUCCESS' | 'ALL_FAILED'

export type WorkSessionNotificationKind = 'HUMAN_REQUIRED' | 'COMPLETED' | 'FAILED' | 'RECOVERY_REQUIRED'

export type WorkSessionNotificationPayload =
  | HumanRequiredNotification
  | WorkSessionCompletedNotification
  | WorkSessionFailedNotification
  | WorkSessionRecoveryRequiredNotification

/**
 * Aggregate per-channel truth. A channel that was skipped is neither a success
 * nor a failure, so it never turns a delivered notification into a failure.
 */
export function overallNotificationStatus(
  channels: readonly NotificationChannelResult[],
): NotificationOverallStatus {
  const failed = channels.filter((channel) => channel.status === 'FAILED').length
  const sent = channels.filter((channel) => channel.status === 'SENT').length
  if (failed === 0) return 'ALL_SUCCEEDED'
  return sent === 0 ? 'ALL_FAILED' : 'PARTIAL_SUCCESS'
}

/** Invoke the kind-specific delivery method, or `undefined` when unsupported. */
export function invokeNotificationDelivery(
  notifier: WorkSessionNotifier,
  kind: WorkSessionNotificationKind,
  notification: WorkSessionNotificationPayload,
): Promise<void> | undefined {
  if (kind === 'HUMAN_REQUIRED') return notifier.notifyHumanRequired(notification as HumanRequiredNotification)
  if (kind === 'COMPLETED') return notifier.notifyCompleted?.(notification as WorkSessionCompletedNotification)
  if (kind === 'FAILED') return notifier.notifyFailed?.(notification as WorkSessionFailedNotification)
  return notifier.notifyRecoveryRequired?.(notification as WorkSessionRecoveryRequiredNotification)
}

/** Whether the notifier can deliver this kind at all. */
export function supportsNotificationKind(
  notifier: WorkSessionNotifier,
  kind: WorkSessionNotificationKind,
): boolean {
  if (notifier.notificationKinds !== undefined) return notifier.notificationKinds.includes(kind)
  if (kind === 'HUMAN_REQUIRED') return true
  if (kind === 'COMPLETED') return notifier.notifyCompleted !== undefined
  if (kind === 'FAILED') return notifier.notifyFailed !== undefined
  return notifier.notifyRecoveryRequired !== undefined
}

/**
 * Deliver one notification to one notifier and report every channel it touches.
 * A single-channel notifier that omits `notifyChannels` is reported as one
 * channel, so its failure stays observable without inventing a channel name.
 */
export async function deliverNotificationToChannels(
  notifier: WorkSessionNotifier,
  kind: WorkSessionNotificationKind,
  notification: WorkSessionNotificationPayload,
): Promise<readonly NotificationChannelResult[]> {
  if (notifier.notifyChannels !== undefined) return await notifier.notifyChannels(kind, notification)
  const channel = notifier.notificationChannel ?? 'DESKTOP'
  try {
    const pending = invokeNotificationDelivery(notifier, kind, notification)
    if (pending === undefined) return [{ channel, status: 'SKIPPED', reason: '该渠道未实现此通知。' }]
    await pending
    return [{ channel, status: 'SENT' }]
  } catch {
    return [{ channel, status: 'FAILED', reason: NOTIFICATION_FAILURE_REASON }]
  }
}

/**
 * A transport error message can carry a credential, so the reason attached to a
 * failed channel is always this fixed safe label — never the raw error text.
 */
export const NOTIFICATION_FAILURE_REASON = '渠道投递失败。'

export interface NotificationDeliveryResult {
  status: NotificationDeliveryStatus
  notificationId: string
  taskId: string | null
  category: string
  kind?: 'HUMAN_REQUIRED' | 'COMPLETED' | 'FAILED' | 'RECOVERY_REQUIRED'
  /** Per-channel truth. Absent only for a legacy single-channel observer. */
  channels?: readonly NotificationChannelResult[]
  /** Aggregated outcome derived from `channels`. */
  overallStatus?: NotificationOverallStatus
}

export type NotificationDeliveryObserver = (
  result: NotificationDeliveryResult,
) => void

const RECOMMENDATIONS: Readonly<Record<string, string>> = {
  DECISION_REQUIRED:
    '打开本地 NovaWing Work Session 控制台查看决策，并选择预期选项。',
  PERMISSION_REQUIRED:
    '请先在本地更新受信任的项目能力或配置文件，再恢复任务。',
  CREDENTIAL_REQUIRED:
    '请在 NovaWing 外完成凭据或登录设置，然后在本地控制台确认并恢复。',
  ENVIRONMENT_REQUIRED:
    '请完成所需的外部运行环境操作，然后在本地恢复。',
  SAFETY_BLOCKED:
    '请人工审查被阻止的高风险操作。NovaWing 不会绕过安全策略。',
  REPO_DRIFT:
    '请检查 Repository 变更，并在适用时使用显式恢复或采纳路径。',
  STALLED:
    '请检查当前阻塞原因，并提供明确的后续决策。',
  BUDGET_EXHAUSTED:
    '请启动新的 Work Session，或明确批准新的限制后再继续。',
  REVIEWER_PROTOCOL_FAILURE:
    'Reviewer 在有限恢复后仍返回格式错误的协议数据。检查 Reviewer 服务后启动新的 Work Session。',
}

const DEFAULT_RECOMMENDATION =
  '请检查当前阻塞原因，并提供明确的后续决策。'

const HUMAN_REQUIRED_LABELS: Readonly<Record<string, string>> = {
  DECISION_REQUIRED: '需要人工决策',
  REPO_DRIFT: 'Repository 状态漂移',
  PERMISSION_REQUIRED: '需要授权',
  CREDENTIAL_REQUIRED: '需要完成凭据或登录设置',
  ENVIRONMENT_REQUIRED: '需要处理运行环境',
  SAFETY_BLOCKED: '被安全策略阻止',
  BUDGET_EXHAUSTED: 'Work Session 时间额度已耗尽',
  REVIEWER_PROTOCOL_FAILURE: 'Reviewer 协议失败',
  STALLED: '执行停滞',
}

export function recommendationForHumanRequired(category: string): string {
  return RECOMMENDATIONS[category] ?? DEFAULT_RECOMMENDATION
}

/** 仅供展示层使用；未知类别保留原始 enum，避免丢失诊断信息。 */
export function presentHumanRequiredCategory(category: string): string {
  return HUMAN_REQUIRED_LABELS[category] ?? category
}

export function notificationIdForHumanRequired(
  sessionId: string,
  currentTaskId: string | null,
  generation: number,
): string {
  return `${sessionId}:${currentTaskId ?? 'none'}:${generation}`
}

export function notificationIdForCompleted(sessionId: string): string {
  return `${sessionId}:completed`
}

export function notificationIdForFailed(sessionId: string): string {
  return `${sessionId}:failed`
}

export function notificationIdForRecoveryRequired(
  sessionId: string,
  currentTaskId: string | null,
  generation: number,
): string {
  return `${sessionId}:${currentTaskId ?? 'none'}:recovery:${generation}`
}

export function createWorkSessionRecoveryRequiredNotification(input: {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState
  generation: number
  localControlUrl?: string
}): WorkSessionRecoveryRequiredNotification {
  const failure = input.state.brainFailure
  if (
    input.state.state !== 'SUSPENDED' ||
    input.state.suspensionReason !== 'BRAIN_INFRASTRUCTURE_FAILED' ||
    failure === undefined
  ) {
    throw new Error('recovery notification requires Brain infrastructure suspension')
  }
  const localUrl = safeLocalControlUrl(input.localControlUrl)
  return {
    notificationId: notificationIdForRecoveryRequired(
      input.definition.id,
      input.state.currentTaskId,
      input.generation,
    ),
    session: {
      id: input.definition.id,
      targetRepo: input.definition.targetRepo,
      branch: input.definition.branch,
    },
    currentTaskId: input.state.currentTaskId,
    stage: failure.stage,
    category: failure.category,
    safeMessage: safeFailureMessage(
      failure.safeMessage ?? 'Brain 暂时不可用；当前 checkpoint 已保留。',
    ),
    recommendation: 'NovaWing 已保留 checkpoint。修复 Browser/Bridge 后打开本地控制台恢复。',
    control: { ...(localUrl === undefined ? {} : { localUrl }) },
  }
}

export function createWorkSessionCompletedNotification(input: {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState
  analytics?: TaskRunSummary
  reportUrl?: string
}): WorkSessionCompletedNotification {
  if (input.state.state !== 'COMPLETED' || input.state.completionReason !== 'ALL_TASKS_COMPLETED') {
    throw new Error('completion notification requires ALL_TASKS_COMPLETED state')
  }
  return {
    notificationId: notificationIdForCompleted(input.definition.id),
    session: {
      id: input.definition.id,
      targetRepo: input.definition.targetRepo,
      branch: input.definition.branch,
    },
    completedTaskIds: [...input.state.completedTaskIds],
    completionReason: 'ALL_TASKS_COMPLETED',
    ...(input.state.activeElapsedMs === undefined ? {} : { activeElapsedMs: input.state.activeElapsedMs }),
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
    ...(input.reportUrl === undefined ? {} : { reportUrl: input.reportUrl }),
  }
}

/** Backward-compatible name for the shared product-data safety boundary. */
export const safeNotificationReason = safeFailureMessage

export function createWorkSessionFailedNotification(input: {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState
  localControlUrl?: string
  analytics?: TaskRunSummary
  reportUrl?: string
}): WorkSessionFailedNotification {
  if (
    input.state.state !== 'FAILED' ||
    input.state.failureStage === undefined ||
    input.state.failureCategory === undefined
  ) {
    throw new Error('failure notification requires structured FAILED state')
  }
  const localUrl = safeLocalControlUrl(input.localControlUrl)
  return {
    notificationId: notificationIdForFailed(input.definition.id),
    session: {
      id: input.definition.id,
      targetRepo: input.definition.targetRepo,
      branch: input.definition.branch,
    },
    currentTaskId: input.state.currentTaskId,
    failureStage: input.state.failureStage,
    failureCategory: input.state.failureCategory,
    safeReason: safeFailureMessage(
      input.state.safeFailureMessage ?? input.state.failureReason,
    ),
    ...(input.state.activeElapsedMs === undefined
      ? {}
      : { activeElapsedMs: input.state.activeElapsedMs }),
    control: { ...(localUrl === undefined ? {} : { localUrl }) },
    ...(input.analytics === undefined ? {} : { analytics: input.analytics }),
    ...(input.reportUrl === undefined ? {} : { reportUrl: input.reportUrl }),
  }
}

export function createHumanRequiredNotification(input: {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState
  generation: number
  localControlUrl?: string
  forceSafeReason?: boolean
}): HumanRequiredNotification {
  const humanRequired = input.state.humanRequired
  if (input.state.state !== 'SUSPENDED' || humanRequired === undefined) {
    throw new Error('notification requires a true HUMAN_REQUIRED suspended state')
  }
  const localUrl = safeLocalControlUrl(input.localControlUrl)
  return {
    notificationId: notificationIdForHumanRequired(
      input.definition.id,
      input.state.currentTaskId,
      input.generation,
    ),
    session: {
      id: input.definition.id,
      targetRepo: input.definition.targetRepo,
      branch: input.definition.branch,
    },
    progress: {
      completedTaskIds: [...input.state.completedTaskIds],
      currentTaskId: input.state.currentTaskId,
    },
    humanRequired: {
      category: humanRequired.category,
      reason: input.forceSafeReason === true
        ? '需要补充信息。请检查本地诊断信息。'
        : safeNotificationReason(humanRequired.reason),
    },
    recommendation: recommendationForHumanRequired(humanRequired.category),
    control: {
      ...(localUrl === undefined ? {} : { localUrl }),
      instruction: '打开本地 NovaWing Work Session 控制台查看详情，并在确认后恢复任务。',
    },
  }
}

export function projectNameFromNotification(notification: {
  session: { targetRepo: string }
}): string {
  return basename(notification.session.targetRepo) || notification.session.targetRepo
}

function safeLocalControlUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined
    }
    return url.href.replace(/\/$/u, '')
  } catch {
    return undefined
  }
}
