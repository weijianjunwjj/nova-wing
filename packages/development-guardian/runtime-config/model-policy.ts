import {
  CODING_EXECUTOR_DEFAULTS,
  type CodexReasoningEffort,
} from '../coding-executor-config.js'

export type RuntimeModelAdapter = 'codex' | 'deepseek'
export type RuntimeModelPolicySource = 'remote' | 'last-known-good' | 'builtin'

export type RuntimeModelSelection = {
  adapter: 'codex'
  model: string
  reasoningEffort: CodexReasoningEffort
} | {
  adapter: 'deepseek'
  model: string
  reasoningEffort?: never
}

export interface RuntimeModelPolicy {
  implementation: RuntimeModelSelection
  review: RuntimeModelSelection
}

export interface ResolvedRuntimeModelPolicy {
  source: RuntimeModelPolicySource
  policy: RuntimeModelPolicy
  contractVersion?: 1
  fetchedAt?: string
  validatedAt?: string
}

export const BUILTIN_RUNTIME_MODEL_POLICY: RuntimeModelPolicy = {
  implementation: {
    adapter: 'codex',
    model: CODING_EXECUTOR_DEFAULTS.codex.model,
    reasoningEffort: CODING_EXECUTOR_DEFAULTS.codex.reasoningEffort,
  },
  review: {
    adapter: 'deepseek',
    model: 'sonnet',
  },
}

export function cloneRuntimeModelPolicy(policy: RuntimeModelPolicy): RuntimeModelPolicy {
  return {
    implementation: { ...policy.implementation },
    review: { ...policy.review },
  }
}
