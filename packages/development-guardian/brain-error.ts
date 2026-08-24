import type {
  GuardianBrainFailure,
  GuardianBrainFailureCategory,
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
    const rawError = options.rawError?.trim().slice(-4_000)
    this.failure = {
      stage: 'BRAIN_REVIEW',
      category,
      rootCause: message.trim().slice(0, 1_000),
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
