export type GuardianBrainRetryKind = 'timeout' | 'protocol'

/**
 * Provider-neutral transient Brain failure that Guardian may retry within the
 * configured bounded review-operation budget.
 */
export class RetryableGuardianBrainError extends Error {
  constructor(
    message: string,
    public readonly kind: GuardianBrainRetryKind = 'timeout',
  ) {
    super(message)
    this.name = 'RetryableGuardianBrainError'
  }
}
