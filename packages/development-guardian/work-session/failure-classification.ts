import { GitCheckpointError, GitPushError } from './git-checkpoint.js'

export type WorkSessionFailureStage =
  | 'REVIEWER'
  | 'EXECUTOR'
  | 'VERIFICATION'
  | 'FINAL_REVIEW'
  | 'GIT_COMMIT'
  | 'GIT_PUSH'
  | 'RUNTIME'
  | 'NOTIFICATION'
  | 'UNKNOWN'

export type WorkSessionFailureCategory =
  | 'PROVIDER_ERROR'
  | 'VERIFICATION_FAILED'
  | 'GIT_COMMIT_FAILED'
  | 'GIT_PUSH_FAILED'
  | 'REPO_DRIFT'
  | 'PERMISSION'
  | 'CREDENTIAL'
  | 'BUDGET'
  | 'PROTOCOL'
  | 'RUNTIME_ERROR'
  | 'UNKNOWN'

export interface StructuredWorkSessionFailure {
  failureStage: WorkSessionFailureStage
  failureCategory: WorkSessionFailureCategory
  safeMessage: string
}

export interface WorkSessionFailureHint {
  failureStage?: WorkSessionFailureStage
  failureCategory?: WorkSessionFailureCategory
}

const UNKNOWN_SAFE_MESSAGE = '发生未知错误。请在本地控制台查看安全诊断信息。'

/** Shared redaction boundary for summaries, durable verification logs and UI data. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(
      /(?<![A-Za-z0-9])((?:[A-Za-z][A-Za-z0-9-]*[_ -])*(?:authorization|password|secret|token|api[_ -]?key|credential|cookie|smtp[_ -]?pass))\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu,
      '$1=[REDACTED]',
    )
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
}

/**
 * The shared product-data boundary for failure text. Raw provider payloads,
 * credentials and authenticated remote URLs must never cross it.
 */
export function safeFailureMessage(reason: unknown): string {
  if (typeof reason !== 'string') return UNKNOWN_SAFE_MESSAGE
  const normalized = reason.trim()
  if (normalized.length === 0) return UNKNOWN_SAFE_MESSAGE
  if (/\b403\b.*\binsufficient balance\b|\binsufficient balance\b/iu.test(normalized)) {
    return 'Executor Provider 账户余额不足，无法继续调用模型。'
  }
  if (/\bDATABASE_URL\b.*\b(missing|not configured)\b|\bDATABASE_URL\b.*\b未配置\b/iu.test(normalized)) {
    return 'PostgreSQL DATABASE_URL 未配置，pytest 无法完成验证。'
  }
  const askBridgeTabFailure = /\bask(?:-| )?bridge\b/iu.test(normalized) &&
    /\bcould not identify (?:the )?newly opened tab\b|\berror opening (?:a )?chatgpt session\b|\btab identification failure\b|\btab\b.{0,80}\b(?:open(?:ing)?|identif(?:y|ication))\b.{0,80}\b(?:fail(?:ed|ure)?|error)\b|\b(?:fail(?:ed|ure)?|error)\b.{0,80}\b(?:open(?:ing)?|identif(?:y|ication))\b.{0,80}\btab\b/iu.test(normalized)
  if (askBridgeTabFailure) return 'Reviewer 浏览器会话打开失败。'

  // A serialized provider response has no stable product meaning and may
  // contain deeply nested secrets that key/value regexes cannot safely model.
  if (/^[{[]/u.test(normalized)) return UNKNOWN_SAFE_MESSAGE

  const withoutStructuredDetail = normalized
    .replace(/\{[\s\S]*$/u, '[REDACTED PROVIDER DETAIL]')
    .replace(/\[[\s\S]*$/u, '[REDACTED PROVIDER DETAIL]')
  const redacted = redactSensitiveText(withoutStructuredDetail)
    .replace(/\s+/gu, ' ')
    .trim()
  return redacted.length === 0 ? UNKNOWN_SAFE_MESSAGE : redacted.slice(0, 500)
}

/** Stable, deliberately small taxonomy. Structured error types win over text. */
export function classifyWorkSessionFailure(
  error: unknown,
  hint: WorkSessionFailureHint = {},
): StructuredWorkSessionFailure {
  if (error instanceof GitPushError) {
    return {
      failureStage: 'GIT_PUSH',
      failureCategory: 'GIT_PUSH_FAILED',
      safeMessage: safeFailureMessage(error.message),
    }
  }
  if (error instanceof GitCheckpointError) {
    return {
      failureStage: 'GIT_COMMIT',
      failureCategory: 'GIT_COMMIT_FAILED',
      safeMessage: safeFailureMessage(error.message),
    }
  }

  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  let failureStage = hint.failureStage
  let failureCategory = hint.failureCategory

  if (failureStage === undefined) {
    if (/final review|final reviewer/iu.test(message)) failureStage = 'FINAL_REVIEW'
    else if (/reviewer|brain review|ask[- ]?bridge/iu.test(message)) failureStage = 'REVIEWER'
    else if (/verification|typecheck|test failed|build failed/iu.test(message)) failureStage = 'VERIFICATION'
    else if (/executor|claude code|provider/iu.test(message)) failureStage = 'EXECUTOR'
    else failureStage = 'RUNTIME'
  }

  if (failureCategory === undefined) {
    if (/^REPO_DRIFT:/u.test(message)) {
      failureCategory = 'REPO_DRIFT'
    } else if (/credential|unauthorized|authentication|insufficient balance|api[_ -]?key/iu.test(message)) {
      failureCategory = 'CREDENTIAL'
    } else if (/budget|hard limit|max iterations/iu.test(message)) {
      failureCategory = 'BUDGET'
    } else if (/protocol|malformed|missing completion evidence/iu.test(message)) {
      failureCategory = 'PROTOCOL'
    } else if (failureStage === 'VERIFICATION') {
      failureCategory = 'VERIFICATION_FAILED'
    } else if (
      failureStage === 'REVIEWER' ||
      failureStage === 'EXECUTOR' ||
      lower.includes('provider')
    ) {
      failureCategory = 'PROVIDER_ERROR'
    } else {
      failureCategory = 'RUNTIME_ERROR'
    }
  }

  return { failureStage, failureCategory, safeMessage: safeFailureMessage(message) }
}
