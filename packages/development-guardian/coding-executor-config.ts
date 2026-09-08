import type { ThreadOptions } from '@openai/codex-sdk'

export type CodexReasoningEffort = NonNullable<ThreadOptions['modelReasoningEffort']>

export interface CodexModelOption {
  id: string
  label: string
  supportedReasoningEfforts: readonly CodexReasoningEffort[]
}

/**
 * The model IDs are the values accepted by the installed Codex SDK/CLI.  Keep
 * labels separate so persisted runtime configuration never depends on UI copy.
 */
export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', label: 'GPT-5.5', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
] as const

export const LEGACY_CODEX_DEFAULTS = {
  model: 'gpt-5.6-sol',
  reasoningEffort: 'medium',
} as const

/** One source for new-task defaults. Legacy DeepSeek model aliases stay separate. */
export const CODING_EXECUTOR_DEFAULTS = {
  defaultMode: 'codex',
  codex: {
    enabled: true,
    model: 'gpt-5.6-terra',
    reasoningEffort: 'high',
    quotaProbeCooldownMs: 15 * 60 * 1000,
    transientRetries: 1,
  },
} as const

export function codexModelOption(model: string): CodexModelOption | undefined {
  return CODEX_MODEL_OPTIONS.find((option) => option.id === model)
}

export function isSupportedCodexConfiguration(model: string, reasoningEffort: string): reasoningEffort is CodexReasoningEffort {
  return codexModelOption(model)?.supportedReasoningEfforts.includes(reasoningEffort as CodexReasoningEffort) === true
}

/**
 * A missing Codex block identifies a pre-selector Work Session.  Its behavior
 * must stay Sol/Medium even after new task defaults changed to Terra/High.
 */
export function resolvePersistedCodexConfiguration(config?: {
  model?: string | undefined
  reasoningEffort?: string | undefined
}): { model: string; reasoningEffort: CodexReasoningEffort } {
  const model = config?.model ?? LEGACY_CODEX_DEFAULTS.model
  const reasoningEffort = config?.reasoningEffort ?? LEGACY_CODEX_DEFAULTS.reasoningEffort
  if (!isSupportedCodexConfiguration(model, reasoningEffort)) {
    throw new Error(`Unsupported Codex model/reasoning configuration: ${model}/${reasoningEffort}`)
  }
  return { model, reasoningEffort }
}

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
