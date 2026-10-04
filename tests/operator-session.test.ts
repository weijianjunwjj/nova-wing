import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import type { PlanningService } from '../packages/development-guardian/planning/service.js'
import { startServer } from './work-session-w005-a-helpers.js'

test('SIMPLIFY both UI surfaces: no-session HTML/API are closed; bootstrap single-use, expiry, cookie and origin checks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nw-operator-'))
  const launchpad = new NovaWingLaunchpad([], join(root, 'configs'), { deliveryDataRoot: join(root, 'delivery'),
    planningService: { list: async () => [] } as unknown as PlanningService })
  const address = await launchpad.start(), control = await startServer()
  try {
    for (const [server, url, paths] of [
      [launchpad, address.url, ['/', '/advanced', '/customer', '/api/planning/plans']],
      [control.server, control.address.url, ['/', '/api/status', '/api/events']],
    ] as const) {
      const bootstrap = server.mintBootstrapUrl()
      const code = new URL(bootstrap).searchParams.get('code')!
      for (const path of paths) {
        const response = await fetch(url + path)
        assert.equal(response.status, 403)
        assert.doesNotMatch(await response.text(), new RegExp(code))
      }
      const exchange = await fetch(bootstrap, { redirect: 'manual' })
      assert.equal(exchange.status, 302)
      assert.equal(exchange.headers.get('location'), '/')
      const cookieHeader = exchange.headers.get('set-cookie')!
      assert.match(cookieHeader, /HttpOnly; SameSite=Strict; Path=\//u)
      const cookie = cookieHeader.split(';')[0]!
      assert.equal((await fetch(bootstrap, { redirect: 'manual' })).status, 403)
      const html = await fetch(url, { headers: { Cookie: cookie } })
      assert.equal(html.status, 200)
      const text = await html.text()
      assert.doesNotMatch(text, /launchToken|controlToken|X-NovaWing-.+-Token/u)
      assert.ok(!text.includes(code) && !text.includes(cookie.split('=')[1]!))
      for (const Origin of [undefined, 'http://evil.example']) {
        const response = await fetch(`${url}/api/session/start`, { method: 'POST',
          headers: { Cookie: cookie, ...(Origin ? { Origin } : {}) } })
        assert.equal(response.status, 403)
      }
      const expired = server.mintBootstrapUrl(), now = Date.now()
      t.mock.method(Date, 'now', () => now + 60_001)
      assert.equal((await fetch(expired, { redirect: 'manual' })).status, 403)
      t.mock.restoreAll()
    }
    // The same Host's operator can follow the existing direct controlUrl link.
    const exchange = await fetch(launchpad.mintBootstrapUrl('/customer'), { redirect: 'manual' })
    assert.equal(exchange.headers.get('location'), '/customer')
    const Cookie = exchange.headers.get('set-cookie')!.split(';')[0]!
    assert.equal((await fetch(`${control.address.url}/api/status`, { headers: { Cookie } })).status, 200)
  } finally { t.mock.restoreAll(); await launchpad.close(); await control.server.close(); await rm(root, { recursive: true, force: true }) }
})
