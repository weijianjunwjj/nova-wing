/**
 * Provider-neutral transient Brain failure that Guardian may retry within the
 * configured bounded review-operation budget.
 */
export class RetryableGuardianBrainError extends Error {
  readonly kind = 'timeout'

  constructor(message: string) {
    super(message)
    this.name = 'RetryableGuardianBrainError'
  }
}
