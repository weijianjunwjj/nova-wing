import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProviderHealthRegistry,
  TaskEventLogV2,
  deriveProviderSwitches,
  providerOf,
  providerSwitchReasonCode,
  selectionReasonCode,
  type ProviderHealthObservation,
} from '../packages/development-guardian/work-session/task-observability.js'

function observation(provider: string, status: ProviderHealthObservation['status'], observedAt: string): ProviderHealthObservation {
  return { provider, status, observedAt, source: 'runtime' }
}

test('Task Event Log is append-only with monotonic restart-safe event ids', () => {
  const log = new TaskEventLogV2()
  const first = log.append({ taskId: 'T1', sessionId: 'S', type: 'TASK_CREATED', timestamp: 't1' })
  const second = log.append({ taskId: 'T1', sessionId: 'S', type: 'CONTROLLER_DECIDED', action: 'EXECUTE', timestamp: 't2' })
  assert.equal(first.eventId, '1')
  assert.equal(second.eventId, '2')
  assert.equal(log.has('TASK_CREATED'), true)
  assert.equal(log.count('TASK_CREATED'), 1)
  assert.equal(log.last('CONTROLLER_DECIDED')?.eventId, '2')

  // Restart: rebuild from persisted events, ids continue without collision.
  const reopened = new TaskEventLogV2(log.events)
  const third = reopened.append({ taskId: 'T1', sessionId: 'S', type: 'TASK_COMPLETED' })
  assert.equal(third.eventId, '3')
  const ids = reopened.events.map((event) => event.eventId)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(reopened.events.map((event) => event.type), ['TASK_CREATED', 'CONTROLLER_DECIDED', 'TASK_COMPLETED'])
})

test('Provider Health registry: real observations override persisted last-known only when newer', () => {
  const registry = new ProviderHealthRegistry({ codex: observation('codex', 'QUOTA_EXHAUSTED', '2026-09-01T00:00:00.000Z') })
  // An older AVAILABLE observation must not downgrade a newer quota fact.
  const rejected = registry.record(observation('codex', 'AVAILABLE', '2026-08-31T00:00:00.000Z'))
  assert.equal(rejected.status, 'QUOTA_EXHAUSTED')
  assert.equal(registry.get('codex')?.status, 'QUOTA_EXHAUSTED')
  // A newer real observation wins.
  registry.record(observation('codex', 'AVAILABLE', '2026-09-02T00:00:00.000Z'))
  assert.equal(registry.get('codex')?.status, 'AVAILABLE')
})

test('provider profile seeding never overrides an existing persisted health fact', () => {
  const registry = new ProviderHealthRegistry({ codex: observation('codex', 'QUOTA_EXHAUSTED', '2026-09-01T00:00:00.000Z') })
  registry.seedFromProfiles([{ id: 'codex', available: true, quotaExhausted: false, degraded: false }], '2026-09-03T00:00:00.000Z')
  assert.equal(registry.get('codex')?.status, 'QUOTA_EXHAUSTED')
  // An absent provider is seeded from the controller profile snapshot.
  registry.seedFromProfiles([{ id: 'deepseek', available: true, quotaExhausted: false, degraded: false }], '2026-09-03T00:00:00.000Z')
  assert.equal(registry.get('deepseek')?.status, 'AVAILABLE')
})

test('deriveProviderSwitches records only real provider changes, never equal-adjacency noise', () => {
  assert.deepEqual(deriveProviderSwitches(['codex'], ['codex', 'codex']), [])
  assert.deepEqual(deriveProviderSwitches([], ['codex']), [])
  assert.deepEqual(deriveProviderSwitches([], ['codex', 'deepseek']), [['codex', 'deepseek']])
  assert.deepEqual(deriveProviderSwitches(['codex'], ['codex', 'deepseek']), [['codex', 'deepseek']])
  assert.deepEqual(deriveProviderSwitches(['codex', 'deepseek'], ['codex', 'deepseek']), [])
})

test('provider switch reason derives from the switched-away provider health, not narrative', () => {
  assert.equal(providerSwitchReasonCode(observation('codex', 'QUOTA_EXHAUSTED', 't')), 'PROVIDER_QUOTA_EXHAUSTED')
  assert.equal(providerSwitchReasonCode(observation('codex', 'OFFLINE', 't')), 'PROVIDER_UNAVAILABLE')
  assert.equal(providerSwitchReasonCode(observation('codex', 'AVAILABLE', 't')), 'CAPABILITY_MISMATCH')
  assert.equal(providerSwitchReasonCode(undefined), 'CAPABILITY_MISMATCH')
})

test('selection reason code is deterministic for continuity, review and capability', () => {
  assert.equal(providerOf({ id: 'executor-router', identity: { provider: 'codex-or-deepseek' } }), 'codex-or-deepseek')
  assert.equal(providerOf({ id: 'codex' }), 'codex')
  const usable = { id: 'codex', available: true, quotaExhausted: false, degraded: false }
  assert.equal(selectionReasonCode({ action: 'EXECUTE', selected: usable, previousAgent: 'codex', previousProfile: usable }), 'CONTINUE_CURRENT_AGENT')
  assert.equal(selectionReasonCode({ action: 'REVIEW', selected: usable, previousAgent: 'codex' }), 'INDEPENDENT_REVIEW_REQUIRED')
  assert.equal(selectionReasonCode({ action: 'EXECUTE', selected: { id: 'deepseek' }, previousAgent: 'codex', previousProfile: { available: false, quotaExhausted: true, degraded: false } }), 'PROVIDER_QUOTA_EXHAUSTED')
  assert.equal(selectionReasonCode({ action: 'EXECUTE', selected: { id: 'deepseek' }, previousAgent: 'codex', previousProfile: { available: false, quotaExhausted: false, degraded: true } }), 'PROVIDER_UNAVAILABLE')
  assert.equal(selectionReasonCode({ action: 'EXECUTE', selected: { id: 'deepseek' }, previousAgent: 'codex', previousProfile: usable }), 'CAPABILITY_MISMATCH')
  assert.equal(selectionReasonCode({ action: 'EXECUTE' }), 'NO_AVAILABLE_AGENT')
})
