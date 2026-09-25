const DEFAULT_TIMEOUT_MS = 2_500
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024

export interface RuntimeConfigClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
}

export class RuntimeConfigClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'RuntimeConfigClientError'
  }
}

export function normalizeDeskBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new RuntimeConfigClientError('NOVAWING_DESK_URL is not a valid URL') }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new RuntimeConfigClientError('NOVAWING_DESK_URL must be a non-credentialed HTTP(S) base URL')
  }
  return url.href.replace(/\/$/u, '')
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximum) throw new RuntimeConfigClientError('Runtime config response is too large', response.status)
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > maximum) throw new RuntimeConfigClientError('Runtime config response is too large', response.status)
      chunks.push(result.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export class RuntimeConfigClient {
  readonly baseUrl: string
  constructor(private readonly options: RuntimeConfigClientOptions) {
    this.baseUrl = normalizeDeskBaseUrl(options.baseUrl)
  }

  async fetchConfig(): Promise<unknown> {
    const abort = new AbortController()
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    timer.unref()
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}/api/v1/runtime-config`, {
        method: 'GET', headers: { Accept: 'application/json' }, signal: abort.signal,
      })
      if (!response.ok) throw new RuntimeConfigClientError(`Runtime config request failed with HTTP ${response.status}`, response.status)
      const text = await boundedResponseText(response, this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)
      try { return JSON.parse(text) as unknown } catch { throw new RuntimeConfigClientError('Runtime config response is malformed JSON', response.status) }
    } catch (error) {
      if (abort.signal.aborted) throw new RuntimeConfigClientError(`Runtime config request timed out after ${timeoutMs}ms`)
      throw error
    } finally { clearTimeout(timer) }
  }
}
