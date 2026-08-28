import type {
  GuardianBrainFailure,
  GuardianBrainFailureCategory,
  GuardianBrainFailureType,
} from './model.js'

export type GuardianBrainRetryKind = 'timeout' | 'protocol' | 'transport'

export interface GuardianBrainErrorOptions {
  category?: GuardianBrainFailureCategory
  adapter?: string
  requestedModel?: string
  requestedReasoning?: string
  availableOptions?: readonly string[]
  retryable?: boolean
  degraded?: boolean
  fingerprint?: string
  rawError?: string
  failureType?: GuardianBrainFailureType
  safeMessage?: string
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(api[_-]?key|token|authorization|password)\s*[:=]\s*[^\s,;]+/giu, '$1=<redacted>')
    .replace(/bearer\s+[a-z0-9._~+\/-]+/giu, 'Bearer <redacted>')
    .trim()
}

function defaultFailureType(category: GuardianBrainFailureCategory): GuardianBrainFailureType {
  if (category === 'CONFIGURATION') return 'BRAIN_CONFIGURATION_FAILED'
  if (category === 'RESPONSE' || category === 'PROTOCOL') return 'BRAIN_RESPONSE_INVALID'
  return 'BRAIN_TRANSPORT_FAILED'
}

function defaultSafeMessage(failureType: GuardianBrainFailureType): string {
  if (failureType === 'BRAIN_AUTH_REQUIRED') return 'Brain 认证需要在 NovaWing 外完成；当前 checkpoint 已保留。'
  if (failureType === 'BRAIN_RATE_LIMITED') return 'Brain provider 当前受限；当前 checkpoint 已保留，可稍后 Resume。'
  if (failureType === 'BRAIN_CONFIGURATION_FAILED') return 'Brain 配置不可用；当前 checkpoint 已保留。'
  if (failureType === 'BRAIN_RESPONSE_INVALID') return 'Brain 返回了无效响应；当前 checkpoint 已保留。'
  return 'Brain transport 不可用；当前 checkpoint 已保留。'
}

function fingerprintPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, '<url>')
    .replace(/\d+/gu, '#')
    .replace(/[^a-z0-9<>]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120) || 'unknown'
}

export class GuardianBrainInfrastructureError extends Error {
  readonly failure: GuardianBrainFailure

  constructor(message: string, options: GuardianBrainErrorOptions = {}) {
    super(message)
    this.name = 'GuardianBrainInfrastructureError'
    const category = options.category ?? 'TRANSPORT'
    const rawError = options.rawError === undefined ? undefined : redactDiagnostic(options.rawError).slice(-4_000)
    const failureType = options.failureType ?? defaultFailureType(category)
    this.failure = {
      stage: 'BRAIN_REVIEW',
      failureType,
      safeMessage: options.safeMessage ?? defaultSafeMessage(failureType),
      category,
      rootCause: redactDiagnostic(message).slice(0, 1_000),
      adapter: options.adapter ?? 'guardian-brain',
      retryable: options.retryable ?? false,
      degraded: options.degraded ?? false,
      fingerprint: options.fingerprint ?? `brain-${category.toLowerCase()}:${fingerprintPart(message)}`,
      ...(options.requestedModel === undefined ? {} : { requestedModel: options.requestedModel }),
      ...(options.requestedReasoning === undefined
        ? {}
        : { requestedReasoning: options.requestedReasoning }),
      ...(options.availableOptions === undefined
        ? {}
        : { availableOptions: [...options.availableOptions].slice(0, 30) }),
      ...(rawError === undefined || rawError.length === 0 ? {} : { rawError }),
    }
  }
}

/**
 * Provider-neutral transient Brain failure that Guardian may retry within the
 * configured bounded review-operation budget.
 */
export class RetryableGuardianBrainError extends GuardianBrainInfrastructureError {
  constructor(
    message: string,
    public readonly kind: GuardianBrainRetryKind = 'timeout',
    options: GuardianBrainErrorOptions = {},
  ) {
    super(message, {
      ...options,
      category: options.category ?? (kind === 'protocol' ? 'PROTOCOL' : 'TRANSPORT'),
      retryable: true,
    })
    this.name = 'RetryableGuardianBrainError'
  }
}

export function guardianBrainFailureFrom(error: unknown): GuardianBrainFailure {
  if (error instanceof GuardianBrainInfrastructureError) {
    return error.failure
  }
  const message = error instanceof Error ? error.message : String(error)
  return new GuardianBrainInfrastructureError(message, {
    category: 'RESPONSE',
    adapter: 'guardian-brain',
  }).failure
}
