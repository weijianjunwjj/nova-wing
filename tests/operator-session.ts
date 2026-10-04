import type { IncomingMessage, ServerResponse } from 'node:http'
import { mintOperatorBootstrap, consumeOperatorBootstrap, operatorSession } from '../packages/development-guardian/work-session/operator-session.js'

const cookies = new Map<string, string>()
/** Test-only mint helper; no production server test accessor or HTTP bypass. */
function mintLocalSession(server: { mintBootstrapUrl(): string }): string {
  const url = new URL(server.mintBootstrapUrl())
  let cookie = ''
  const response = { setHeader() {}, writeHead(status: number, headers?: Record<string, string>) {
    if (status !== 302) throw new Error('Test session bootstrap rejected')
    cookie = headers?.['Set-Cookie']?.split(';')[0] ?? ''
  }, end() {} }
  consumeOperatorBootstrap({ url: url.pathname + url.search } as IncomingMessage,
    response as unknown as ServerResponse, url.origin)
  cookies.set(url.origin, cookie)
  return cookie
}
export async function mintSession(server: { mintBootstrapUrl(): string }): Promise<string> {
  const url = server.mintBootstrapUrl()
  const response = await globalThis.fetch(url, { redirect: 'manual' })
  if (response.status !== 302) throw new Error('Test session bootstrap rejected')
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Test session cookie missing')
  cookies.set(new URL(url).origin, cookie)
  return cookie
}
export function testOperator() {
  const cookie = mintLocalSession({ mintBootstrapUrl: () => mintOperatorBootstrap('http://127.0.0.1:1') })
  return operatorSession({ headers: { cookie } } as IncomingMessage)!
}
export async function startOperator<T extends { url: string }>(host: { start(): Promise<T>;
}): Promise<T> {
  const address = await host.start()
  const candidate = host as unknown as { mintBootstrapUrl?: () => string; server?: { mintBootstrapUrl?: () => string } }
  const server = candidate.mintBootstrapUrl ? candidate : candidate.server
  if (server?.mintBootstrapUrl) await mintSession(server as { mintBootstrapUrl(): string })
  return address
}
/** Existing read/SSE tests now use the authenticated operator context explicitly. */
export function sessionFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input)
  const headers = new Headers(init?.headers)
  if ((!init?.method || init.method === 'GET') && !headers.has('Cookie')) {
    const cookie = cookies.get(new URL(url).origin)
    if (cookie) headers.set('Cookie', cookie)
  }
  return globalThis.fetch(input, { ...init, headers })
}
