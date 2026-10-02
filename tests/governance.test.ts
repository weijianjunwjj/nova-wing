import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EscalationService, type EscalationPacket } from '../packages/development-guardian/escalation/index.js'
import { createAdvisoryRunner } from '../packages/development-guardian/advisory-model.js'
import { createDeepSeekPlanningSemanticReviewer } from '../packages/development-guardian/planning/semantic-reviewer.js'
import { TaskController } from '../packages/development-guardian/work-session/task-controller.js'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'

const packet: EscalationPacket = { schemaVersion: 1, planId: '00000000-0000-0000-0000-000000000001',
  planVersion: 1, reason: 'Plan conflicts with the original requirement.',
  plan: { requirement: 'Deliver the requested product.', must: ['preserve acceptance'] }, evidence: { missing: ['fresh tests'] } }
const verdict = { verdict: 'NEEDS_EVIDENCE', rootCause: 'No fresh test evidence.',
  keep: ['Frozen acceptance'], remove: [], change: [], nextAction: ['Collect scoped evidence.'], acceptanceCriteria: [] }

test('manual adjudication makes exactly one tool-free advisory call and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-adjudication-'))
  let calls = 0
  const service = new EscalationService(directory, async (prompt) => {
    calls++; assert.ok(prompt.includes('original user requirement'))
    return { text: JSON.stringify(verdict), provider: 'configured-fixture', model: 'fixture-model' }
  })
  const record = await service.escalate(packet)
  assert.equal(calls, 1); assert.equal(record.status, 'DECIDED'); assert.equal(record.decision?.advisory, true)
  const restarted = new EscalationService(directory, async () => { throw new Error('must not call') })
  assert.deepEqual(await restarted.get(record.id), record)
  assert.deepEqual(record.packet, packet)
})

test('invalid or unavailable adjudicator cannot approve, resume, retry or overwrite a verdict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-adjudication-fail-'))
  let calls = 0
  const service = new EscalationService(directory, async () => {
    calls++; return { text: '{"verdict":"PASS","execute":true}', provider: 'fixture', model: 'fixture' }
  })
  const record = await service.escalate(packet)
  assert.equal(calls, 1); assert.equal(record.status, 'FAILED'); assert.equal(record.decision, undefined)
  assert.equal((await service.get(record.id)).status, 'FAILED')
  const path = join(directory, `${record.id}.request.json`)
  const tampered = JSON.parse(await readFile(path, 'utf8')) as { packet: { planVersion: number } }
  tampered.packet.planVersion++
  await writeFile(path, JSON.stringify(tampered))
  await assert.rejects(service.get(record.id), /integrity/u)
})

test('simultaneous manual requests for the same plan cannot multiply model spend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-adjudication-concurrent-'))
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  const service = new EscalationService(directory, async () => {
    await wait; return { text: JSON.stringify(verdict), provider: 'fixture', model: 'fixture' }
  })
  const first = service.escalate(packet)
  await assert.rejects(service.escalate(packet), /already running/u)
  release(); assert.equal((await first).status, 'DECIDED')
})

test('adjudicator without an explicitly selected model fails before spawning a paid provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-adjudication-route-'))
  const run = createAdvisoryRunner('ADJUDICATOR', { cwd: directory, env: { CLAUDE_CONFIG_DIR: directory } })
  await assert.rejects(run('packet'), /explicit adjudicator/u)
})

test('planning auditor rejects a provider masquerading as DeepSeek', async () => {
  const reviewer = createDeepSeekPlanningSemanticReviewer({ runner: async () => ({
    text: '{"verdict":"PASS","issues":[]}', provider: 'codex', model: 'fixture',
  }) })
  await assert.rejects(reviewer({ requirement: 'original', plan: {} as never }), /independent DeepSeek/u)
})

test('alternate model endpoint cannot inherit the previous provider credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-adjudication-key-'))
  const run = createAdvisoryRunner('ADJUDICATOR', { cwd: directory, env: {
    CLAUDE_CONFIG_DIR: directory, ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_API_KEY: 'fixture-only-key', NOVAWING_ADJUDICATOR_BASE_URL: 'https://api.anthropic.com',
    NOVAWING_ADJUDICATOR_MODEL: 'claude-fixture',
  } })
  await assert.rejects(run('packet'), /own role credential/u)
})

test('semantic drift stops before automatic execution, including after a resume decision', async () => {
  const task = { id: 't', goal: 'deliver requested feature', acceptanceCriteria: ['proof'],
    acceptanceEvidenceBindings: [{ criterion: 'proof', requiredEvidence: ['test'] }] }
  const initial = createTaskStateV2({ id: 's', branch: 'main' }, task)
  const identity = { agent: 'codex', provider: 'codex', runtimeIdentity: 'executor' }
  const state = { ...initial, status: 'ACTIVE' as const, implementer: identity,
    gitState: { repositoryIdentity: 'repo', branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' },
    completion: { ...initial.completion, review: { passed: false, findings: [], severity: 'HIGH' as const,
      blockingFindings: ['GOVERNANCE_DRIFT: removed a frozen user requirement'],
      reviewer: { agent: 'ds', provider: 'deepseek', runtimeIdentity: 'auditor' }, implementer: identity,
      reviewedFiles: [], timestamp: new Date().toISOString() } } }
  assert.equal(new TaskController().decide(state).action, 'SUSPEND')
  let dispatches = 0
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'main', agents: [
    { id: 'codex', available: true, degraded: false, quotaExhausted: false, capabilities: { coding: true, reasoning: true, verification: true } },
  ], dispatcher: {
    inspectRepository: async () => state.gitState as never,
    dispatch: async () => { dispatches++; return { status: 'SUCCESS' } },
  } })
  const result = await runner.run(task, { decision: 'continue' }, undefined, { taskStateV2: state })
  assert.equal(dispatches, 0)
  assert.equal(result.status, 'HUMAN_REQUIRED')
  assert.match(result.humanRequired?.reason ?? '', /GOVERNANCE_DRIFT/u)
})
