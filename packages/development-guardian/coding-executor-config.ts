/** One source for new-task defaults. Legacy DeepSeek model aliases stay separate. */
export const CODING_EXECUTOR_DEFAULTS = {
  defaultMode: 'auto',
  codex: {
    enabled: true,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    quotaProbeCooldownMs: 15 * 60 * 1000,
    transientRetries: 1,
  },
} as const

export type ExecutorMode = 'auto' | 'codex' | 'deepseek'
export type CodingExecutorName = 'codex' | 'deepseek'

export interface CodingExecutionMetadata {
  mode: ExecutorMode
  activeExecutor: CodingExecutorName
  history: CodingExecutorName[]
  codexThreadId?: string
  model?: string
  reasoningEffort?: string
  failoverReason?: 'codex_quota_exhausted'
  lastError?: string
  lastErrorKind?: import('./codex-error.js').CodexErrorKind
}
