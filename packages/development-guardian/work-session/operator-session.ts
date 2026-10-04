import { randomBytes, createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

// One local Host process owns both Launchpad and its control listeners. Cookies
// span loopback ports; no credentials enter HTML, API projections or durable state.
const sessions = new Map<string, number>()
const codes = new Map<string, { origin: string; path: string; expires: number }>()
const principals = new WeakSet<object>()
export function isOperatorSession(value: object): boolean { return principals.has(value) }
const cookieName = 'novawing_operator'
function prune(): void {
  for (const [id, expires] of sessions) if (expires <= Date.now()) sessions.delete(id)
  for (const [id, value] of codes) if (value.expires <= Date.now()) codes.delete(id)
}
export function mintOperatorBootstrap(origin: string, path = '/'): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/u.test(path) ||
    new URL(path, origin).origin !== origin || new URL(path, origin).pathname === '/bootstrap')
    throw new Error('Invalid operator landing page.')
  prune()
  const code = randomBytes(32).toString('hex')
  codes.set(code, { origin, path, expires: Date.now() + 60_000 })
  return `${origin}/bootstrap?code=${code}`
}
export function consumeOperatorBootstrap(req: IncomingMessage, res: ServerResponse, origin: string): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const code = new URL(req.url ?? '/', origin).searchParams.get('code') ?? ''
  const grant = codes.get(code)
  codes.delete(code)
  if (!grant || grant.origin !== origin || grant.expires <= Date.now()) {
    res.writeHead(403); res.end('Invalid or expired bootstrap code.'); return
  }
  prune()
  const sessionId = randomBytes(32).toString('hex')
  sessions.set(sessionId, Date.now() + 12 * 60 * 60_000)
  res.writeHead(302, { Location: grant.path,
    'Set-Cookie': `${cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/` })
  res.end()
}
export function operatorSession(req: IncomingMessage): { role: 'LOCAL_OPERATOR_UI';
  channel: 'LAUNCHPAD_SESSION'; sessionRef: string } | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${cookieName}=`))
  if (values.length !== 1) return undefined
  const id = values[0]!.slice(cookieName.length + 1)
  if ((sessions.get(id) ?? 0) <= Date.now()) return undefined
  const principal = { role: 'LOCAL_OPERATOR_UI' as const, channel: 'LAUNCHPAD_SESSION' as const,
    sessionRef: createHash('sha256').update(id).digest('hex') }
  principals.add(principal)
  return Object.freeze(principal)
}
