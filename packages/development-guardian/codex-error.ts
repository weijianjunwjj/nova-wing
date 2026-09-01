export type CodexErrorKind = 'quota_exhausted' | 'auth_required' | 'transient' |
  'configuration_error' | 'model_unavailable' | 'no_op_execution' | 'unknown'

export interface ClassifiedCodexError {
  kind: CodexErrorKind
  message: string
  blockedUntil?: string
}

const MESSAGES: Record<CodexErrorKind, string> = {
  quota_exhausted: 'Codex usage limit reached',
  auth_required: 'Codex Local requires ChatGPT sign-in',
  transient: 'Codex transient network/runtime error',
  configuration_error: 'Codex Local configuration error',
  model_unavailable: 'Requested Codex model unavailable',
  no_op_execution: 'Codex completed without credible workspace execution evidence',
  unknown: 'Codex Local execution failed',
}

/** SDK 0.151 ThreadError only exposes message. Keep that fallback here, never in routing. */
export function classifyCodexError(error: unknown, now = Date.now()): ClassifiedCodexError {
  const records: Record<string, unknown>[] = []
  const visited = new Set<unknown>()
  function collect(value: unknown, depth = 0): void {
    if (!value || typeof value !== 'object' || depth > 4 || visited.has(value)) return
    visited.add(value)
    const record = value as Record<string, unknown>
    records.push(record)
    for (const key of ['error', 'cause', 'metadata', 'response', 'data']) collect(record[key], depth + 1)
  }
  collect(error)
  const codes = records.flatMap((r) => [r.code, r.type]).filter((v): v is string => typeof v === 'string')
  const statuses = records.flatMap((r) => [r.status, r.statusCode])
  const has = (...values: string[]) => codes.some((code) => values.includes(code))
  let kind: CodexErrorKind = 'unknown'
  if (has('usage_limit_reached', 'quota_exhausted', 'insufficient_quota')) kind = 'quota_exhausted'
  else if (has('no_op_execution', 'workspace_inspection_missing')) kind = 'no_op_execution'
  else if (has('auth_required', 'unauthorized', 'token_expired', 'invalid_authentication') || statuses.includes(401)) kind = 'auth_required'
  else if (has('model_not_found', 'model_unavailable', 'unsupported_model')) kind = 'model_unavailable'
  else if (has('configuration_error', 'invalid_configuration', 'ENOENT')) kind = 'configuration_error'
  else if (has('rate_limit_exceeded', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED') ||
    statuses.some((s) => typeof s === 'number' && (s === 429 || s >= 500))) kind = 'transient'
  // Only use text if no structured category is known. An ordinary 429 is NOT quota.
  if (kind === 'unknown') {
    const message = (records.map((r) => r.message).find((v) => typeof v === 'string') ??
      (typeof error === 'string' ? error : '')) as string
    if (/\bYou(?:'|’)ve hit your usage limit\b|\busage limit (?:has been )?reached\b/iu.test(message)) kind = 'quota_exhausted'
    else if (/\b(?:not logged in|authentication required|sign in with ChatGPT|refresh token.*expired)\b/iu.test(message)) kind = 'auth_required'
    else if (/\bmodel\b.*\b(?:not supported|does not exist|not available|not found)\b/iu.test(message)) kind = 'model_unavailable'
    else if (/\b(?:error loading config|invalid configuration|failed to load bootstrap configuration|unknown variant)\b/iu.test(message)) kind = 'configuration_error'
    else if (/\b(?:connection reset|connection refused|stream disconnected|request timed out)\b/iu.test(message)) kind = 'transient'
  }
  let blockedUntil: string | undefined
  if (kind === 'quota_exhausted') {
    for (const r of records) {
      const at = r.reset_at ?? r.resetAt
      const retry = r.retry_after ?? r.retryAfter
      const ms = typeof at === 'string' ? Date.parse(at) : typeof at === 'number' ? at * 1000 :
        typeof retry === 'number' ? now + retry * 1000 : NaN
      if (Number.isFinite(ms) && ms > now && ms <= now + 366 * 24 * 60 * 60 * 1000) {
        blockedUntil = new Date(ms).toISOString()
        break
      }
    }
  }
  return { kind, message: MESSAGES[kind], ...(blockedUntil === undefined ? {} : { blockedUntil }) }
}
