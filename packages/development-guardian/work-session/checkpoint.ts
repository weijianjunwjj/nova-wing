/**
 * W003 Recovery Checkpoint
 * 最小可序列化恢复点，支持 Exact Resume 和 Recovery Resume
 */

import type { GuardianTask } from '../model.js'

export interface ChatGptProviderConfigurationState {
  requestedModel?: string
  actualModel?: string
  requestedReasoning?: 'auto' | 'instant' | 'medium' | 'high'
  actualReasoning?: 'auto' | 'instant' | 'medium' | 'high' | 'unknown'
  configuredAt?: string
  degraded: boolean
}

/**
 * Provider Session State
 * 用于 Exact Resume（优化路径）
 *
 * 仅包含 provider-owned durable state（如 sessionId）。
 * 不包含 executor-instance ephemeral binding（如 activeTaskId）。
 */
export interface ProviderSessionState {
  /** ChatGPT conversation URL（如果可用） */
  chatgptConversationUrl?: string
  /** The previous Reviewer conversation is known stale and must not be restored. */
  chatgptConversationStale?: true
  /** Last verified non-secret Browser/provider configuration evidence. */
  chatgptConfiguration?: ChatGptProviderConfigurationState
  /** Claude session_id（如果可用） */
  claudeSessionId?: string
}

/**
 * Repository Checkpoint
 * 用于验证 resume 时 repo 状态是否 drift
 */
export interface RepositoryCheckpoint {
  repoPath: string
  branch: string
  headSha: string
  /** 已更改文件列表（包括 untracked） */
  changedFiles: readonly string[]
  /** worktree fingerprint（SHA-256） */
  worktreeFingerprint: string
}

/**
 * Guardian Task Recovery Checkpoint
 * 最小恢复上下文
 */
export interface GuardianTaskRecoveryCheckpoint {
  version: 1

  /** Guardian Task 当前状态 */
  task: GuardianTask

  /** Provider session state（可选，用于 Exact Resume） */
  provider: ProviderSessionState

  /** Repository checkpoint */
  repo: RepositoryCheckpoint

  /** 捕获时间 */
  capturedAt: string
}
