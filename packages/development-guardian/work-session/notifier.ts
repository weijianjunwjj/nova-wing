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

export interface WorkSessionNotifier {
  notifyHumanRequired(notification: HumanRequiredNotification): Promise<void>
}

export type NotificationDeliveryStatus = 'SENT' | 'FAILED'

export interface NotificationDeliveryResult {
  status: NotificationDeliveryStatus
  notificationId: string
  taskId: string | null
  category: string
}

export type NotificationDeliveryObserver = (
  result: NotificationDeliveryResult,
) => void

const RECOMMENDATIONS: Readonly<Record<string, string>> = {
  DECISION_REQUIRED:
    'Review the decision in the NovaWing control panel and choose the intended option.',
  PERMISSION_REQUIRED:
    'Update the trusted project capability/profile locally before resuming.',
  CREDENTIAL_REQUIRED:
    'Complete credential/login setup outside NovaWing, then acknowledge it in the local control panel.',
  ENVIRONMENT_REQUIRED:
    'Complete the required external environment action, then resume locally.',
  SAFETY_BLOCKED:
    'Review the blocked high-risk operation manually. NovaWing will not bypass the safety gate.',
  REPO_DRIFT:
    'Inspect the repository changes and use the explicit recovery/adoption path if appropriate.',
  STALLED:
    'Review the current blocker and provide a concrete continuation decision.',
  BUDGET_EXHAUSTED:
    'Start a new Session or explicitly approve new limits before continuing.',
}

const DEFAULT_RECOMMENDATION =
  'Review the current blocker and provide a concrete continuation decision.'

export function recommendationForHumanRequired(category: string): string {
  return RECOMMENDATIONS[category] ?? DEFAULT_RECOMMENDATION
}

export function notificationIdForHumanRequired(
  sessionId: string,
  currentTaskId: string | null,
  generation: number,
): string {
  return `${sessionId}:${currentTaskId ?? 'none'}:${generation}`
}

export function safeNotificationReason(reason: string): string {
  return reason
    .replace(/\bBearer\s+\S+/giu, '[REDACTED]')
    .replace(
      /\b(authorization|password|secret|token|api[_ -]?key)\s*[:=]\s*\S+/giu,
      '$1=[REDACTED]',
    )
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
        ? 'Additional input is required. Check local diagnostics.'
        : safeNotificationReason(humanRequired.reason),
    },
    recommendation: recommendationForHumanRequired(humanRequired.category),
    control: {
      ...(localUrl === undefined ? {} : { localUrl }),
      instruction: 'Open the local NovaWing control panel and resolve this item.',
    },
  }
}

export function projectNameFromNotification(notification: HumanRequiredNotification): string {
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
