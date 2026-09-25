import type { DecisionClient } from './client.js'
import { DecisionShadowObserver } from './observer.js'
import { LayaClient } from './providers/laya-client.js'
import type { DecisionShadowStore } from './store.js'

export function createDecisionShadowObserverFromEnv(options: {
  env?: NodeJS.ProcessEnv
  store?: DecisionShadowStore
  client?: DecisionClient
} = {}): DecisionShadowObserver | undefined {
  const env = options.env ?? process.env
  const provider = env.NOVAWING_DECISION_SHADOW?.trim().toLowerCase()
  if (provider !== 'laya') return undefined
  const configuredModel = env.NOVAWING_LAYA_MODEL?.trim() || undefined
  const client = options.client ?? new LayaClient({
    ...(configuredModel === undefined ? {} : { model: configuredModel }),
    baseUrl: env.NOVAWING_LAYA_BASE_URL?.trim() || 'http://127.0.0.1:8000',
  })
  return new DecisionShadowObserver({
    enabled: true,
    provider,
    model: configuredModel ?? 'router',
    client,
    ...(options.store === undefined ? {} : { store: options.store }),
  })
}
