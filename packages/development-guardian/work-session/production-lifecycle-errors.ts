/** Internal owner error; not part of the package's public runtime exports. */
export class ProductionWorkSessionInitializationError extends AggregateError {
  constructor(error: unknown, readonly cleanupErrors: readonly unknown[]) {
    super([error, ...cleanupErrors], 'Production Work Session initialization failed')
  }
}
