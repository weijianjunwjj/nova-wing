/**
 * Work Session MVP - W001/W002/W003 Exports
 */

export * from './model.js'
export * from './recoverability.js'
export * from './task-runner.js'
export * from './fake-task-runner.js'
export * from './guardian-task-runner.js'
export * from './runtime.js'
export * from './checkpoint.js'
export * from './worktree-fingerprint.js'
export * from './task-state-v2.js'
export * from './task-controller.js'
export * from './task-observability.js'
export * from './task-run-analytics.js'
export * from './task-run-notifier.js'
export * from './reconciliation.js'
export * from './v2-controller-task-runner.js'
export * from './verification-planner.js'
export * from './direct-path.js'
export * from './golden-path.js'
// Completion gate stays internal to TaskController; expose evidence vocabulary only.
export { assessRisk, evidenceIsStale } from './risk-evidence.js'
export type { AcceptanceEvidenceBinding, ApprovalEvidence, EvidenceV2, ReviewEvidence, RiskAssessment, RiskLevel } from './risk-evidence.js'
export * from './legacy-recovery.js'
export * from './git-checkpoint.js'
export * from './failure-classification.js'
export * from './execution-ledger.js'
export * from './dependency-health.js'
export * from './production.js'
export type { WorkSessionActivityEvent, WorkSessionActivityObserver, WorkSessionActivityOperation } from './activity.js'
export * from './controlled-quota-injection.js'
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
  WorkSessionRecoveryRequiredNotification,
  WorkSessionNotifier,
  WorkSessionNotificationKind,
  WorkSessionNotificationPayload,
  NotificationDeliveryStatus,
  NotificationDeliveryResult,
  NotificationDeliveryObserver,
  NotificationChannel,
  NotificationChannelStatus,
  NotificationChannelResult,
  NotificationOverallStatus,
} from './notifier.js'
export {
  deliverNotificationToChannels,
  invokeNotificationDelivery,
  NOTIFICATION_FAILURE_REASON,
  overallNotificationStatus,
  supportsNotificationKind,
} from './notifier.js'
export {
  SmtpWorkSessionNotifier,
  createSmtpWorkSessionNotifierFromEnv,
} from './smtp-notifier.js'
export * from './launchpad/server.js'
export * from './launchpad/task-brief.js'
export * from './launchpad/browser-launcher.js'
export * from './launchpad/repair.js'
export * from './launchpad/repair-agent.js'
export * from './launchpad/repair-agent-llm.js'
export * from './launchpad/repair-model.js'
export * from './launchpad/repair-audit.js'
export * from './launchpad/repair-notifier.js'
export * from './runtime-repair.js'
export * from './runtime-repair-engine.js'
export * from './runtime-repair-audit.js'
export * from './runtime-repair-notifier.js'
export * from './reviewer-runtime.js'
export * from './review-dispatcher.js'
export {
  REVIEW_DEFAULT_TIMEOUT_MS, REVIEW_DEFAULT_MODEL, REVIEW_DEFAULT_MAX_TURNS,
  REVIEWER_ALLOWED_TOOLS, REVIEWER_SYSTEM_PROMPT, parseReviewVerdict, buildReviewPrompt,
  classifyReviewerProviderFailure, createDeepSeekReviewerRuntime, createClaudeReviewerRuntime,
  createCodexReviewerRuntime,
} from './reviewer-adapters.js'
export type { ReviewVerdict, DeepSeekReviewerRuntimeOptions, CodexReviewerRuntimeOptions } from './reviewer-adapters.js'
export type {
  SmtpTransportConfig,
  SmtpMailOptions,
  SmtpMailTransport,
  SmtpWorkSessionNotifierOptions,
  SmtpNotifierEnvironmentOptions,
} from './smtp-notifier.js'

export { TASK_RETRY_REASON, taskRetryRequestSchema } from './task-retry.js'
export type { TaskRetryRequest, TaskRetryReceipt, TaskRetryAuthority } from './task-retry.js'
