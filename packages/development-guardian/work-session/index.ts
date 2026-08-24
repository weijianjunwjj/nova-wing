/**
 * Work Session MVP - W001/W002/W003 Exports
 */

export * from './model.js'
export * from './task-runner.js'
export * from './fake-task-runner.js'
export * from './guardian-task-runner.js'
export * from './runtime.js'
export * from './checkpoint.js'
export * from './worktree-fingerprint.js'
export * from './legacy-recovery.js'
export * from './git-checkpoint.js'
export * from './failure-classification.js'
export * from './execution-ledger.js'
export * from './production.js'
export {
  defaultLocalSmtpSecretPath,
  loadLocalSmtpSecrets,
  resolveProductionSmtpEnvironment,
  saveLocalSmtpSecrets,
  smtpEnvironmentFrom,
  validateSmtpSecrets,
} from './local-smtp-secrets.js'
export type { SmtpSecretEnvironment, SmtpSecretKey } from './local-smtp-secrets.js'
export * from './production-legacy-adoption.js'
export type {
  HumanRequiredNotification,
  WorkSessionCompletedNotification,
  WorkSessionFailedNotification,
  WorkSessionNotifier,
  NotificationDeliveryStatus,
  NotificationDeliveryResult,
  NotificationDeliveryObserver,
} from './notifier.js'
export {
  SmtpWorkSessionNotifier,
  createSmtpWorkSessionNotifierFromEnv,
} from './smtp-notifier.js'
export * from './launchpad/server.js'
export * from './launchpad/browser-launcher.js'
export type {
  SmtpTransportConfig,
  SmtpMailOptions,
  SmtpMailTransport,
  SmtpWorkSessionNotifierOptions,
  SmtpNotifierEnvironmentOptions,
} from './smtp-notifier.js'
