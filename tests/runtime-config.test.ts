import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { RuntimeConfigClient } from '../packages/development-guardian/runtime-config/client.js'
import { validateRuntimeConfigV1 } from '../packages/development-guardian/runtime-config/contract.js'
import { resolveRuntimeModelPolicy } from '../packages/development-guardian/runtime-config/resolver.js'
import { RuntimeConfigStore, runtimeConfigSourceKey } from '../packages/development-guardian/runtime-config/store.js'

function payload(implementationModel = 'gpt-6-luna', implementationReasoning = 'high') {
  return {
    version: 1,
    models: [
      { provider: 'openai', model: implementationModel, displayName: implementationModel,
        supportsReasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningLevel: 'medium' },
      { provider: 'deepseek', model: 'sonnet', displayName: 'DeepSeek route alias: sonnet',
        supportsReasoning: false, reasoningLevels: [], defaultReasoningLevel: null },
    ],
    presets: {
      implementation: { model: implementationModel, reasoningLevel: implementationReasoning },
      review: { model: 'sonnet', reasoningLevel: null },
    },
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-runtime-config-'))
  const store = new RuntimeConfigStore(join(directory, 'coding-executors.sqlite'))
  return { directory, store }
}

test('valid remote configuration becomes the policy and last-known-good', async () => {
  const f = await fixture()
  try {
    const result = await resolveRuntimeModelPolicy({
      client: { baseUrl: 'https://desk.example', fetchConfig: async () => payload() },
      store: f.store,
      now: () => new Date('2026-09-25T00:00:00.000Z'),
    })
    assert.equal(result.source, 'remote')
    assert.deepEqual(result.policy, {
      implementation: { adapter: 'codex', model: 'gpt-6-luna', reasoningEffort: 'high' },
      review: { adapter: 'deepseek', model: 'sonnet' },
    })
    assert.equal(f.store.read(runtimeConfigSourceKey('https://desk.example'))?.contractVersion, 1)
    const db = new DatabaseSync(join(f.directory, 'coding-executors.sqlite'), { readOnly: true })
    try {
      assert.deepEqual(db.prepare('PRAGMA table_info(runtime_config_lkg)').all().map((row) => String(row.name)),
        ['source_key', 'contract_version', 'payload_json', 'payload_sha256', 'fetched_at', 'validated_at'])
    } finally { db.close() }
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('HTTP errors and malformed JSON are rejected by the client before validation', async () => {
  for (const status of [404, 500]) {
    const client = new RuntimeConfigClient({ baseUrl: 'https://desk.example', fetch: async () => new Response('{}', { status }) })
    await assert.rejects(client.fetchConfig(), new RegExp(`HTTP ${status}`))
  }
  const malformed = new RuntimeConfigClient({ baseUrl: 'https://desk.example', fetch: async () => new Response('{', { status: 200 }) })
  await assert.rejects(malformed.fetchConfig(), /malformed JSON/u)
})

for (const [name, failure] of [
  ['HTTP 500', new Error('HTTP 500')],
  ['malformed payload', { version: 1, models: 'invalid', presets: {} }],
  ['unsupported version', { ...payload(), version: 2 }],
  ['unsupported provider', { ...payload(), models: [{ ...payload().models[0], provider: 'unknown' }], presets: payload().presets }],
] as const) test(`${name} falls back to last-known-good without overwriting it`, async () => {
  const f = await fixture()
  const baseUrl = 'https://desk.example'
  const key = runtimeConfigSourceKey(baseUrl)
  try {
    const good = validateRuntimeConfigV1(payload()).config
    f.store.save(key, good, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:01.000Z')
    const before = f.store.read(key)
    const result = await resolveRuntimeModelPolicy({
      client: { baseUrl, fetchConfig: async () => { if (failure instanceof Error) throw failure; return failure } },
      store: f.store,
    })
    assert.equal(result.source, 'last-known-good')
    assert.equal(result.policy.implementation.model, 'gpt-6-luna')
    assert.deepEqual(f.store.read(key), before)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('timeout falls back to cache, and no cache falls back to builtin', async () => {
  const f = await fixture()
  const baseUrl = 'https://desk.example'
  try {
    const key = runtimeConfigSourceKey(baseUrl)
    f.store.save(key, validateRuntimeConfigV1(payload()).config, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:01.000Z')
    const client = new RuntimeConfigClient({
      baseUrl,
      timeoutMs: 5,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    assert.equal((await resolveRuntimeModelPolicy({ client, store: f.store })).source, 'last-known-good')

    const empty = new RuntimeConfigStore(join(f.directory, 'empty.sqlite'))
    const builtin = await resolveRuntimeModelPolicy({
      client: { baseUrl: 'https://offline.example', fetchConfig: async () => { throw new Error('offline') } },
      store: empty,
    })
    assert.equal(builtin.source, 'builtin')
    assert.equal(builtin.policy.implementation.model, 'gpt-5.6-terra')
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})

test('endpoint omission reuses the latest cache and GPT-6 compatibility excludes ultra', async () => {
  const f = await fixture()
  try {
    f.store.save(runtimeConfigSourceKey('https://desk.example'), validateRuntimeConfigV1(payload('gpt-6-sol', 'max')).config,
      '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:01.000Z')
    const cached = await resolveRuntimeModelPolicy({ env: {}, store: f.store })
    assert.equal(cached.source, 'last-known-good')
    assert.deepEqual(cached.policy.implementation, { adapter: 'codex', model: 'gpt-6-sol', reasoningEffort: 'max' })
    assert.throws(() => validateRuntimeConfigV1(payload('gpt-6-luna', 'ultra')), /unsupported reasoning/u)
  } finally { await rm(f.directory, { recursive: true, force: true }) }
})
