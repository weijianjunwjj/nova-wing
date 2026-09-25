import { defaultCodingExecutionStorePath } from '../work-session/coding-execution-store.js'
import { RuntimeConfigClient, normalizeDeskBaseUrl } from './client.js'
import { validateRuntimeConfigV1 } from './contract.js'
import {
  BUILTIN_RUNTIME_MODEL_POLICY,
  cloneRuntimeModelPolicy,
  type ResolvedRuntimeModelPolicy,
} from './model-policy.js'
import { RuntimeConfigStore, runtimeConfigSourceKey } from './store.js'

export interface ResolveRuntimeModelPolicyOptions {
  env?: NodeJS.ProcessEnv
  client?: Pick<RuntimeConfigClient, 'baseUrl' | 'fetchConfig'>
  store?: RuntimeConfigStore
  now?: () => Date
}

export async function resolveRuntimeModelPolicy(
  options: ResolveRuntimeModelPolicyOptions = {},
): Promise<ResolvedRuntimeModelPolicy> {
  const env = options.env ?? process.env
  const configuredUrl = env.NOVAWING_DESK_URL?.trim()
  let client = options.client
  if (client === undefined && configuredUrl) {
    try { client = new RuntimeConfigClient({ baseUrl: configuredUrl }) } catch { /* Invalid remote config is non-fatal. */ }
  }
  let store = options.store
  if (store === undefined) {
    try { store = new RuntimeConfigStore(defaultCodingExecutionStorePath(env)) } catch { /* Unavailable persistence falls through without making Desk mandatory. */ }
  }
  const now = options.now ?? (() => new Date())
  let sourceKey: string | undefined
  if (client !== undefined) {
    try { sourceKey = runtimeConfigSourceKey(normalizeDeskBaseUrl(client.baseUrl)) } catch { client = undefined }
  }

  if (client !== undefined && sourceKey !== undefined) {
    try {
      const fetchedAt = now().toISOString()
      const validated = validateRuntimeConfigV1(await client.fetchConfig())
      const validatedAt = now().toISOString()
      try { store?.save(sourceKey, validated.config, fetchedAt, validatedAt) } catch { /* Cache failure cannot make Desk a runtime dependency. */ }
      return { source: 'remote', policy: cloneRuntimeModelPolicy(validated.policy), contractVersion: 1, fetchedAt, validatedAt }
    } catch { /* Remote failure falls through to LKG. */ }
  }

  try {
    const cached = store?.read(sourceKey)
    if (cached !== undefined) {
      const validated = validateRuntimeConfigV1(cached.payload)
      return {
        source: 'last-known-good', policy: cloneRuntimeModelPolicy(validated.policy), contractVersion: 1,
        fetchedAt: cached.fetchedAt, validatedAt: cached.validatedAt,
      }
    }
  } catch { /* Corrupt/unavailable cache falls through to builtin. */ }

  return { source: 'builtin', policy: cloneRuntimeModelPolicy(BUILTIN_RUNTIME_MODEL_POLICY) }
}
