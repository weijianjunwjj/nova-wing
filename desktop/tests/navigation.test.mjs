import assert from 'node:assert/strict'
import test from 'node:test'
import { createNavigationRegistry } from '../main/navigation.mjs'

test('trust follows registered server origins across distinct Launchpad and Control ports', () => {
  const registry = createNavigationRegistry()
  const launchpad = {}
  const control = {}
  const launchpadUrl = 'http://127.0.0.1:43001'
  const controlUrl = 'http://127.0.0.1:43002'

  assert.equal(registry.allows(launchpadUrl), false)
  assert.equal(registry.register(launchpad, launchpadUrl), launchpadUrl)
  assert.equal(registry.allows(`${launchpadUrl}/?view=sessions#current`), true)
  assert.equal(registry.allows(controlUrl), false)

  registry.register(control, `${controlUrl}/`)
  assert.equal(registry.allows(`${controlUrl}/api/status`), true)
  assert.deepEqual(registry.origins(), [launchpadUrl, controlUrl])
  assert.equal(registry.allows('http://127.0.0.1:43003'), false)
  assert.equal(registry.allows('http://localhost:43002'), false)

  registry.unregister(control)
  assert.equal(registry.allows(controlUrl), false)
  assert.equal(registry.allows(launchpadUrl), true)
  registry.unregister(launchpad)
  assert.deepEqual(registry.origins(), [])
})

test('schemes, user information, lookalike hosts and malformed URLs cannot acquire trust', () => {
  const registry = createNavigationRegistry()
  const owner = {}
  const trusted = 'http://127.0.0.1:43001'
  registry.register(owner, trusted)
  for (const value of [
    'https://example.com',
    'https://127.0.0.1:43001',
    'file:///owned-resource',
    'javascript:globalThis.untrustedNavigationExecuted=true',
    'data:text/html,<h1>untrusted</h1>',
    'http://user@127.0.0.1:43001',
    'http://:password@127.0.0.1:43001',
    'http://user:password@127.0.0.1:43001',
    'http://127.0.0.1:43001@evil.example',
    'http://127.0.0.1.evil.example:43001',
    'http://localhost:43001',
    'http://[::1]:43001',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://127.0.0.1:65536',
    '//127.0.0.1:43001',
    '/api/status',
    '',
  ]) {
    assert.equal(registry.allows(value), false, value)
    assert.throws(() => registry.register(owner, value), /explicit HTTP loopback port/u, value)
    assert.equal(registry.allows(trusted), true, 'Invalid replacement must preserve the registered server')
  }
  assert.deepEqual(registry.origins(), [trusted])
})

test('revoking one owner does not remove another live owner and replacement revokes stale ports', () => {
  const registry = createNavigationRegistry()
  const first = {}
  const second = {}
  const oldOrigin = 'http://127.0.0.1:43001'
  const replacementOrigin = 'http://127.0.0.1:43002'
  registry.register(first, oldOrigin)
  registry.register(second, oldOrigin)
  assert.deepEqual(registry.origins(), [oldOrigin])

  registry.unregister(first)
  registry.unregister(first)
  assert.equal(registry.allows(oldOrigin), true)
  registry.register(second, replacementOrigin)
  assert.equal(registry.allows(oldOrigin), false)
  assert.equal(registry.allows(replacementOrigin), true)
  registry.unregister(second)
  assert.equal(registry.allows(replacementOrigin), false)
})

test('registry snapshots cannot grant trust and clear revokes every registered origin', () => {
  const registry = createNavigationRegistry()
  registry.register({}, 'http://127.0.0.1:43001')
  registry.register({}, 'http://127.0.0.1:43002')
  const snapshot = registry.origins()
  snapshot.push('http://127.0.0.1:43003')
  snapshot.splice(0, 1)
  assert.equal(registry.allows('http://127.0.0.1:43003'), false)
  assert.equal(registry.allows('http://127.0.0.1:43001'), true)

  registry.clear()
  assert.deepEqual(registry.origins(), [])
  assert.equal(registry.allows('http://127.0.0.1:43001'), false)
  assert.equal(registry.allows('http://127.0.0.1:43002'), false)
})
