import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import test from 'node:test'

import {
  DecisionShadowObserver,
  FileDecisionShadowStore,
  LayaClient,
  TASK_ACTIONS,
  buildDecisionShadowReport,
  buildDecisionShadowStateProjection,
  buildSystemOneRequest,
  createDecisionShadowObserverFromEnv,
  defaultDecisionShadowPath,
  parseChoiceResponse,
  readDecisionShadowRecords,
  type DecisionChoice,
  type DecisionClient,
  type DecisionClientOutcome,
  type DecisionShadowRecord,
  type DecisionShadowStateProjection,
  type DecisionShadowStore,
} from '../packages/development-guardian/decision-shadow/index.js'
import { createTaskStateV2, V2ControllerTaskRunner, type AgentCapabilityProfile } from '../packages/development-guardian/work-session/index.js'

const task = { id: 'T-sensitive', goal: 'SECRET_TASK_SOURCE_TEXT', constraints: ['PASSWORD_MARKER'], acceptanceCriteria: ['tests'],
  allowedPaths: ['/Users/private/source.ts'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] }

function projection(): DecisionShadowStateProjection {
  const state = createTaskStateV2({ id: 'S', branch: 'main' }, task)
  return buildDecisionShadowStateProjection({
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
  return { model: 'english', answers: { next_action: { type: 'choice', choice: action, confidence: 0.8, probabilities: probabilities(action) } }, usage: { input_tokens: 12, output_tokens: 3 } }
}

class MemoryStore implements DecisionShadowStore {
  readonly records: DecisionShadowRecord[] = []
  async append(record: DecisionShadowRecord): Promise<void> { this.records.push(structuredClone(record)) }
}

test('projection and request are scalar allowlists with no task text, paths, outputs, payloads, secrets, or authoritative-answer fields', () => {
  const projected = projection()
  assert.deepEqual(Object.keys(projected).sort(), [
    'acceptanceCriteriaCount', 'approval', 'blockerCount', 'evidence', 'reconciliationRequired', 'review', 'risk',
    'runtimeOnlyAcceptance', 'taskStatus', 'unmappedAcceptanceCriteriaCount', 'verification', 'verifyOnly',
  ])
  const request = buildSystemOneRequest('english', projected)
  assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state'])
  assert.deepEqual(Object.keys(request.questions), ['next_action'])
  assert.equal('reference' in request, false)
  assert.equal('reasonCode' in request, false)
  assert.equal('match' in request, false)
  assert.equal('model' in buildSystemOneRequest(undefined, projected), false)
  const serialized = JSON.stringify(request)
  for (const marker of ['SECRET_TASK_SOURCE_TEXT', 'PASSWORD_MARKER', '/Users/private/source.ts', 'RAW_OUTPUT_MARKER', 'RAW_PROVIDER_PAYLOAD', 'api key']) {
    assert.equal(serialized.includes(marker), false, marker)
  }
})

test('choice parser accepts the official shape and rejects unknown, missing, wrong-type, confidence, probability, and usage violations', () => {
  assert.equal(parseChoiceResponse(response())?.action, 'EXECUTE')
  const invalid: unknown[] = [
    { model: 'english', answers: { next_action: { type: 'choice', choice: 'LAUNCH', confidence: 0.8, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'english', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'english', answers: { next_action: { type: 'score', choice: 'EXECUTE', confidence: 0.8, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'english', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 2, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'english', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 0.8, probabilities: { ...probabilities('EXECUTE'), LAUNCH: 0 } } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'english', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 0.8, probabilities: { ...probabilities('EXECUTE'), EXECUTE: 1.2 } } }, usage: { input_tokens: 1, output_tokens: 1 } },
    { model: 'english', answers: { next_action: { type: 'choice', choice: 'EXECUTE', confidence: 0.8, probabilities: probabilities('EXECUTE') } }, usage: { input_tokens: -1, output_tokens: 1 } },
  ]
  for (const value of invalid) assert.equal(parseChoiceResponse(value), undefined)
})

test('Laya client sends only the independent unauthenticated request and classifies valid, HTTP, invalid JSON, timeout, and connection failures', async () => {
  let capturedBody = ''
  let capturedAuthorization = ''
  const validFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = String(init?.body)
    capturedAuthorization = new Headers(init?.headers).get('Authorization') ?? ''
    return new Response(JSON.stringify(response()), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const valid = await new LayaClient({ model: 'english', fetch: validFetch }).decide(projection())
  assert.equal(valid.status, 'ok')
  assert.equal(capturedAuthorization, '')
  assert.equal(capturedBody.includes('reference'), false)
  assert.equal(capturedBody.includes('reasonCode'), false)
  assert.equal(capturedBody.includes('match'), false)

  for (const status of [401, 403, 429, 500]) {
    const fake = (async () => new Response('provider body is never persisted', { status })) as typeof fetch
    assert.equal((await new LayaClient({ fetch: fake }).decide(projection())).status, 'http_error')
  }
  const badJson = (async () => new Response('{', { status: 200 })) as typeof fetch
  assert.equal((await new LayaClient({ fetch: badJson }).decide(projection())).status, 'invalid_response')

  const server = createServer((_request, _reply) => undefined)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  assert.equal((await new LayaClient({ baseUrl, timeoutMs: 20 }).decide(projection())).status, 'timeout')
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  assert.equal((await new LayaClient({ baseUrl, timeoutMs: 100 }).decide(projection())).status, 'exception')
})

test('disabled observers never call the client and Laya is enabled without an API key', async () => {
  let calls = 0
  const client: DecisionClient = { async decide() { calls++; return { status: 'exception', latencyMs: 0 } } }
  const input = { sessionId: 'S', taskId: 'T', projection: projection(), reference: { action: 'EXECUTE' as const, reasonCode: 'TASK_NOT_STARTED' as const } }
  const disabledStore = new MemoryStore()
  const disabled = new DecisionShadowObserver({ enabled: false, provider: 'laya', client, store: disabledStore })
  disabled.observe(input); await disabled.settled()
  assert.equal(calls, 0)
  assert.equal(disabledStore.records[0]?.shadow.status, 'disabled')
  assert.equal(createDecisionShadowObserverFromEnv({ env: { NOVAWING_DECISION_SHADOW: 'off' } }), undefined)
  const layaStore = new MemoryStore()
  const laya = createDecisionShadowObserverFromEnv({ env: { NOVAWING_DECISION_SHADOW: 'laya' }, store: layaStore, client })!
  laya.observe(input); await laya.settled()
  assert.equal(calls, 1)
  assert.equal(layaStore.records[0]?.shadow.provider, 'laya')
})

test('JSONL persistence round-trips records, excludes credentials, and resolves platform-safe data paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-decision-shadow-'))
  const path = join(root, 'nested', 'decision-shadow.jsonl')
  const store = new FileDecisionShadowStore(path)
  const observer = new DecisionShadowObserver({ enabled: true, provider: 'laya', store, client: {
    async decide(): Promise<DecisionClientOutcome> { return { status: 'ok', latencyMs: 11, decision: parseChoiceResponse(response())! } },
  } })
  observer.observe({ sessionId: 'S', taskId: 'T', projection: projection(), reference: { action: 'EXECUTE', reasonCode: 'TASK_NOT_STARTED' } })
  await observer.settled()
  const records = await readDecisionShadowRecords(path)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.match, true)
  assert.equal(records[0]?.shadow.provider, 'laya')
  assert.equal(defaultDecisionShadowPath({ platform: 'darwin', userHome: '/Users/test', env: {} }), '/Users/test/Library/Application Support/NovaWing/decision-shadow.jsonl')
  assert.equal(defaultDecisionShadowPath({ platform: 'win32', userHome: 'C:\\Users\\test', env: {} }), win32.join('C:\\Users\\test', 'AppData', 'Local', 'NovaWing', 'decision-shadow.jsonl'))
  await rm(root, { recursive: true, force: true })
})

function record(reference: typeof TASK_ACTIONS[number], shadow: typeof TASK_ACTIONS[number] | null, latency: number | null, confidence: number | null, input: number | null, output: number | null): DecisionShadowRecord {
  return {
    schemaVersion: 1, timestamp: '2026-09-25T00:00:00.000Z', sessionId: 'S', taskId: 'T', decisionPoint: 'task-controller.next-action',
    reference: { action: reference, reasonCode: 'TASK_NOT_STARTED' }, projection: projection(), match: shadow === null ? null : shadow === reference,
    shadow: { status: shadow === null ? 'timeout' : 'ok', provider: 'laya', model: 'english', action: shadow, confidence, probabilities: shadow === null ? null : probabilities(shadow), latencyMs: latency, inputTokens: input, outputTokens: output },
  }
}

test('report computes matches, per-action rates, confusion, percentiles, confidence splits, and token totals', () => {
  const report = buildDecisionShadowReport([
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
  const cases: Array<DecisionClient | 'sync-throw'> = [
    { async decide() { return { status: 'ok', latencyMs: 1, decision: { model: 'english', action: 'EXECUTE', confidence: 1, probabilities: probabilities('EXECUTE'), inputTokens: 1, outputTokens: 1 } satisfies DecisionChoice } } },
    { async decide() { return { status: 'ok', latencyMs: 1, decision: { model: 'english', action: 'COMPLETE', confidence: 1, probabilities: probabilities('COMPLETE'), inputTokens: 1, outputTokens: 1 } satisfies DecisionChoice } } },
    { async decide() { return { status: 'timeout', latencyMs: 2 } } },
    { async decide() { throw new Error('shadow failure') } },
    'sync-throw',
  ]
  for (const client of cases) {
    const actions: string[] = []
    const store = new MemoryStore()
    const observer = client === 'sync-throw' ? { observe() { throw new Error('observer failure') } }
      : new DecisionShadowObserver({ enabled: true, provider: 'laya', client, store })
    const runner = new V2ControllerTaskRunner({ sessionId: 'S', branch: 'main', agents: [agent], shadowDecisionObserver: observer, dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => { actions.push(action); return { status: 'BLOCKED', blockers: ['stop after authoritative dispatch'] } },
    } })
    const result = await runner.run({ id: 'T', goal: 'fix', acceptanceCriteria: ['tests'], acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['test'] }] })
    assert.deepEqual(actions, ['EXECUTE'])
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(result.taskStateV2?.currentAction, 'EXECUTE')
    if (observer instanceof DecisionShadowObserver) await observer.settled()
  }
})
