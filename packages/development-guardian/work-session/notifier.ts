import { basename } from 'node:path'

import type { HumanRequired, WorkSessionDefinition, WorkSessionDurableState } from './model.js'

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
}

export interface WorkSessionNotifier {
  notifyHumanRequired(notification: HumanRequiredNotification): Promise<void>
  /** Additive so existing test/local notifiers remain compatible. Production SMTP implements it. */
  notifyCompleted?(notification: WorkSessionCompletedNotification): Promise<void>
}

export type NotificationDeliveryStatus = 'SENT' | 'FAILED'

export interface NotificationDeliveryResult {
  status: NotificationDeliveryStatus
  notificationId: string
  taskId: string | null
  category: string
  kind?: 'HUMAN_REQUIRED' | 'COMPLETED'
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

export function createWorkSessionCompletedNotification(input: {
  definition: WorkSessionDefinition
  state: WorkSessionDurableState
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
  }
}

export function safeNotificationReason(reason: string): string {
  const normalized = reason.trim()
  if (/\b403\b.*\binsufficient balance\b|\binsufficient balance\b/iu.test(normalized)) {
    return 'Executor Provider 账户余额不足，无法继续调用模型。'
  }
  if (/\bDATABASE_URL\b.*\b(missing|not configured)\b|\bDATABASE_URL\b.*\b未配置\b/iu.test(normalized)) {
    return 'PostgreSQL DATABASE_URL 未配置，pytest 无法完成验证。'
  }
  if (/\bAskBridge\b.*\b(tab identification failure|tab.*(?:open|identification).*fail)/iu.test(normalized)) {
    return 'Reviewer 浏览器会话打开失败。'
  }
  // Provider 原始 JSON 或异常对象缺乏稳定的用户语义，也可能携带敏感信息。
  if (/^[{[]/u.test(normalized)) {
    return '发生未知错误。请在本地控制台查看安全诊断信息。'
  }
  const redacted = normalized
    .replace(/\bBearer\s+\S+/giu, '[REDACTED]')
    .replace(
      /\b(authorization|password|secret|token|api[_ -]?key|credential|cookie|smtp[_ -]?pass)\s*[:=]\s*\S+/giu,
      '$1=[REDACTED]',
    )
    .replace(/\s+/gu, ' ')
    .trim()
  if (redacted.length === 0) return '发生未知错误。请在本地控制台查看安全诊断信息。'
  return redacted.slice(0, 500)
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
