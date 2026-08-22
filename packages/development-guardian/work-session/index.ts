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
export * from './production.js'
export type {
  HumanRequiredNotification,
  WorkSessionNotifier,
  NotificationDeliveryStatus,
  NotificationDeliveryResult,
  NotificationDeliveryObserver,
} from './notifier.js'
export {
  SmtpWorkSessionNotifier,
  createSmtpWorkSessionNotifierFromEnv,
} from './smtp-notifier.js'
export type {
  SmtpTransportConfig,
  SmtpMailOptions,
  SmtpMailTransport,
  SmtpWorkSessionNotifierOptions,
  SmtpNotifierEnvironmentOptions,
} from './smtp-notifier.js'
