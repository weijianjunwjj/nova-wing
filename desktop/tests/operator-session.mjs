// Test-only Node HTTP client. Renderer fetch/EventSource use HttpOnly cookies automatically.
let cookie
export async function mintSession(serverOrUrl) {
  const url = typeof serverOrUrl === 'string' ? serverOrUrl : serverOrUrl.mintBootstrapUrl()
  const response = await globalThis.fetch(url, { redirect: 'manual' })
  if (response.status !== 302) throw new Error('Operator bootstrap rejected')
  cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing operator cookie')
  return cookie
}
export function sessionFetch(input, init = {}) {
  const headers = new Headers(init.headers)
  if ((!init.method || init.method === 'GET') && cookie && !headers.has('Cookie')) headers.set('Cookie', cookie)
  return globalThis.fetch(input, { ...init, headers })
}
