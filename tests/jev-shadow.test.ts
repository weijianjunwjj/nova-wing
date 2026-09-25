import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import test from 'node:test'

import {
  FileJevShadowStore,
  JevClient,
  JevShadowObserver,
  TASK_ACTIONS,
  buildJevShadowReport,
  buildJevShadowStateProjection,
  buildJevSystemOneRequest,
  createJevShadowObserverFromEnv,
  defaultJevShadowDecisionPath,
  parseJevChoiceResponse,
  readJevShadowRecords,
  type JevChoiceDecision,
  type JevClientOutcome,
  type JevDecisionClient,
  type JevShadowRecord,
  type JevShadowStateProjection,
  type JevShadowStore,
} from '../packages/development-guardian/decision-shadow/index.js'
import { createTaskStateV2, V2ControllerTaskRunner, type AgentCapabilityProfile } from '../packages/development-guardian/work-session/index.js'

const task = { id: 'T-sensitive', goal: 'SECRET_TASK_SOURCE_TEXT', constraints: ['PASSWORD_MARKER'], acceptanceCriteria: ['tests'],
  allowedPaths: ['/Users/private/source.ts'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }

function projection(): JevShadowStateProjection {
  const state = createTaskStateV2({ id: 'S', branch: 'main' }, task)
  return buildJevShadowStateProjection({
    ...state,
    decisions: ['RAW_PROVIDER_PAYLOAD'],
    blockers: [],
    verificationState: { results: [{ name: 'RAW_OUTPUT_MARKER', status: 'failed', classification: 'CODE_FAILURE' }] },
  })
}

function probabilities(action: typeof TASK_ACTIONS[number]): Record<typeof TASK_ACTIONS[number], number> {
  return Object.fromEntries(TASK_ACTIONS.map((candidate) => [candidate, candidate === action ? 1 : 0])) as Record<typeof TASK_ACTIONS[number], number>
}

function response(action: typeof TASK_ACTIONS[number] = 'EXECUTE'): unknown {
  return { model: 'jev-test', answers: { next_action: { type: 'choice', choice: action, confidence: 0.8, probabilities: probabilities(action) } }, usage: { input_tokens: 12, output_tokens: 3 } }
}

class MemoryStore implements JevShadowStore {
  readonly records: JevShadowRecord[] = []
  async append(record: JevShadowRecord): Promise<void> { this.records.push(structuredClone(record)) }
}

test('projection and request are scalar allowlists with no task text, paths, outputs, payloads, secrets, or authoritative-answer fields', () => {
  const projected = projection()
  assert.deepEqual(Object.keys(projected).sort(), [
    'acceptanceCriteriaCount', 'approval', 'blockerCount', 'evidence', 'reconciliationRequired', 'review', 'risk',
    'runtimeOnlyAcceptance', 'taskStatus', 'unmappedAcceptanceCriteriaCount', 'verification', 'verifyOnly',
  ])
  const request = buildJevSystemOneRequest('jev-test', projected)
  assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state'])
  assert.deepEqual(Object.keys(request.questions), ['next_action'])
  assert.equal('reference' in request, false)
  assert.equal('reasonCode' in request, false)
  assert.equal('match' in request, false)
  const serialized = JSON.stringify(request)
  for (const marker of ['SECRET_TASK_SOURCE_TEXT', 'PASSWORD_MARKER', '/Users/private/source.ts', 'RAW_OUTPUT_MARKER', 'RAW_PROVIDER_PAYLOAD', 'api key']) {
    assert.equal(serialized.includes(marker), false, marker)
  }
})

test('choice parser accepts the official shape and rejects unknown, missing, wrong-type, confidence, probability, and usage violations', () => {
  assert.equal(parseJevChoiceResponse(response())?.action, 'EXECUTE')
  const invalid: unknown[] = [
    { model: 'jev', answers: { next_action: { type: 'choice', choice: 'LAUNCH', confidence: 0.8, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'jev', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'jev', answers: { next_action: { type: 'score', choice: 'EXECUTE', confidence: 0.8, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'jev', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 2, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'jev', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 0.8, probabilities: { ...probabilities('EXECUTE'), LAUNCH: 0 } } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'jev', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 0.8, probabilities: { ...probabilities('EXECUTE'), EXECUTE: 1.2 } } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'jev', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 0.8, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: -1, output_tokens: 1 } },
  ]
  for (const value of invalid) assert.equal(parseJevChoiceResponse(value), undefined)
})

test('client sends only the independent request and classifies valid, HTTP, invalid JSON, timeout, and connection failures without leaking its key', async () => {
  let capturedBody = ''
  let capturedAuthorization = ''
  const validFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body)
    capturedAuthorization = new Headers(init?.headers).get('Authorization') ?? ''
    return new Response(JSON.stringify(response()), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const valid = await new JevClient({ apiKey: 'TOP_SECRET_KEY', model: 'jev-test', fetch: validFetch }).decide(projection())
  assert.equal(valid.status, 'ok')
  assert.equal(capturedAuthorization, 'Bearer TOP_SECRET_KEY')
  assert.equal(capturedBody.includes('TOP_SECRET_KEY'), false)
  assert.equal(capturedBody.includes('reference'), false)
  assert.equal(capturedBody.includes('reasonCode'), false)
  assert.equal(capturedBody.includes('match'), false)

  for (const status of [401, 403, 429, 500]) {
    const fake = (async () => new Response('provider body is never persisted', { status })) as typeof fetch
    assert.equal((await new JevClient({ apiKey: 'secret', fetch: fake }).decide(projection())).status, 'http_error')
  }
  const badJson = (async () => new Response('{', { status: 200 })) as typeof fetch
  assert.equal((await new JevClient({ apiKey: 'secret', fetch: badJson }).decide(projection())).status, 'invalid_response')

  const server = createServer((_request, _reply) => undefined)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  assert.equal((await new JevClient({ apiKey: 'secret', baseUrl, timeoutMs: 20 }).decide(projection())).status, 'timeout')
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.equal((await new JevClient({ apiKey: 'secret', baseUrl, timeoutMs: 100 }).decide(projection())).status, 'exception')
})

test('disabled and missing-key observers never call the client and persist only safe status records', async () => {
  let calls = 0
  const client: JevDecisionClient = { async decide() { calls++; return { status: 'exception', latencyMs: 0 } } }
  const input = { sessionId: 'S', taskId: 'T', projection: projection(), reference: { action: 'EXECUTE' as const, reasonCode: 'TASK_NOT_STARTED' as const } }
  const disabledStore = new MemoryStore()
  const disabled = new JevShadowObserver({ enabled: false, apiKey: 'secret', client, store: disabledStore })
  disabled.observe(input); await disabled.settled()
  assert.equal(calls, 0)
  assert.equal(disabledStore.records[0]?.shadow.status, 'disabled')
  const missingStore = new MemoryStore()
  const missing = new JevShadowObserver({ enabled: true, store: missingStore })
  missing.observe(input); await missing.settled()
  assert.equal(calls, 0)
  assert.equal(missingStore.records[0]?.shadow.status, 'missing_api_key')
  assert.equal(JSON.stringify(missingStore.records).includes('secret'), false)
  assert.equal(createJevShadowObserverFromEnv({ env: { NOVAWING_JEV_SHADOW: '0' } }), undefined)
  const blankKeyStore = new MemoryStore()
  const blankKey = createJevShadowObserverFromEnv({ env: { NOVAWING_JEV_SHADOW: '1', TYPESAFE_API_KEY: '   ' }, store: blankKeyStore })!
  blankKey.observe(input); await blankKey.settled()
  assert.equal(blankKeyStore.records[0]?.shadow.status, 'missing_api_key')
})

test('JSONL persistence round-trips records, excludes credentials, and resolves platform-safe data paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-jev-shadow-'))
  const path = join(root, 'nested', 'jev.jsonl')
  const store = new FileJevShadowStore(path)
  const observer = new JevShadowObserver({ enabled: true, apiKey: 'NEVER_PERSIST_THIS', store, client: {
    async decide(): Promise<JevClientOutcome> { return { status: 'ok', latencyMs: 11, decision: parseJevChoiceResponse(response())! } },
  } })
  observer.observe({ sessionId: 'S', taskId: 'T', projection: projection(), reference: { action: 'EXECUTE', reasonCode: 'TASK_NOT_STARTED' } })
  await observer.settled()
  const records = await readJevShadowRecords(path)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.match, true)
  assert.equal(JSON.stringify(records).includes('NEVER_PERSIST_THIS'), false)
  assert.equal(defaultJevShadowDecisionPath({ platform: 'darwin', userHome: '/Users/test', env: {} }), '/Users/test/Library/Application Support/NovaWing/jev-shadow-decisions.jsonl')
  assert.equal(defaultJevShadowDecisionPath({ platform: 'win32', userHome: 'C:\\Users\\test', env: {} }), win32.join('C:\\Users\\test', 'AppData', 'Local', 'NovaWing', 'jev-shadow-decisions.jsonl'))
  await rm(root, { recursive: true, force: true })
})

function record(reference: typeof TASK_ACTIONS[number], shadow: typeof TASK_ACTIONS[number] | null, latency: number | null, confidence: number | null, input: number | null, output: number | null): JevShadowRecord {
  return {
    schemaVersion: 1, timestamp: '2026-09-25T00:00:00.000Z', sessionId: 'S', taskId: 'T', decisionPoint: 'task-controller.next-action',
    reference: { action: reference, reasonCode: 'TASK_NOT_STARTED' }, projection: projection(), match: shadow === null ? null : shadow === reference,
    shadow: { status: shadow === null ? 'timeout' : 'ok', model: 'jev', action: shadow, confidence, probabilities: shadow === null ? null : probabilities(shadow), latencyMs: latency, inputTokens: input, outputTokens: output },
  }
}

test('report computes matches, per-action rates, confusion, percentiles, confidence splits, and token totals', () => {
  const report = buildJevShadowReport([
    record('EXECUTE', 'EXECUTE', 10, 0.9, 10, 1),
    record('EXECUTE', 'VERIFY', 20, 0.6, 20, 2),
    record('VERIFY', 'VERIFY', 30, 0.8, 30, 3),
    record('VERIFY', null, 40, null, null, null),
  ])
  assert.equal(report.samples, 4)
  assert.equal(report.successful, 3)
  assert.equal(report.errors, 1)
  assert.equal(report.exact_match_rate, 2 / 3)
  assert.deepEqual(report.by_reference_action.EXECUTE, { samples: 2, successful: 2, matches: 1, match_rate: 0.5 })
  assert.deepEqual(report.by_reference_action.VERIFY, { samples: 2, successful: 1, matches: 1, match_rate: 1 })
  assert.equal(report.confusion_matrix.EXECUTE.EXECUTE, 1)
  assert.equal(report.confusion_matrix.EXECUTE.VERIFY, 1)
  assert.equal(report.latency_p50, 20)
  assert.equal(report.latency_p95, 30)
  assert.equal(report.confidence_avg, (0.9 + 0.6 + 0.8) / 3)
  assert.ok(Math.abs(report.confidence_match_avg! - 0.85) < Number.EPSILON)
  assert.equal(report.confidence_mismatch_avg, 0.6)
  assert.equal(report.input_tokens_total, 60)
  assert.equal(report.output_tokens_total, 6)
})

test('shadow outcomes and observer exceptions cannot change the authoritative dispatch action', async () => {
  const agent: AgentCapabilityProfile = { id: 'coder', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }
  const cases: Array<JevDecisionClient | 'sync-throw'> = [
    { async decide() { return { status: 'ok', latencyMs: 1, decision: { model: 'jev', action: 'EXECUTE', confidence: 1, probabilities: probabilities('EXECUTE'), inputTokens: 1, outputTokens: 1 } satisfies JevChoiceDecision } } },
    { async decide() { return { status: 'ok', latencyMs: 1, decision: { model: 'jev', action: 'COMPLETE', confidence: 1, probabilities: probabilities('COMPLETE'), inputTokens: 1, outputTokens: 1 } satisfies JevChoiceDecision } } },
    { async decide() { return { status: 'timeout', latencyMs: 2 } } },
    { async decide() { throw new Error('shadow failure') } },
    'sync-throw',
  ]
  for (const client of cases) {
    const actions: string[] = []
    const store = new MemoryStore()
    const observer = client === 'sync-throw' ? { observe() { throw new Error('observer failure') } }
      : new JevShadowObserver({ enabled: true, apiKey: 'secret', client, store })
    const runner = new V2ControllerTaskRunner({ sessionId: 'S', branch: 'main', agents: [agent], shadowDecisionObserver: observer, dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => { actions.push(action); return { status: 'BLOCKED', blockers: ['stop after authoritative dispatch'] } },
    } })
    const result = await runner.run({ id: 'T', goal: 'fix', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] })
    assert.deepEqual(actions, ['EXECUTE'])
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(result.taskStateV2?.currentAction, 'EXECUTE')
    if (observer instanceof JevShadowObserver) await observer.settled()
  }
})
