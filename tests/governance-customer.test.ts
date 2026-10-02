import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformPaths } from '../packages/development-guardian/platform/paths.js'
import { PlanningService, PlanningStore } from '../packages/development-guardian/planning/service.js'
import { PlanningEventStore } from '../packages/development-guardian/planning/telemetry.js'
import { createDeepSeekPlanningSemanticReviewer } from '../packages/development-guardian/planning/semantic-reviewer.js'
import { EscalationService } from '../packages/development-guardian/escalation/index.js'
import { DeliveryService, DeliveryStore, DeliveryEventStore } from '../packages/development-guardian/delivery/service.js'
import { conservativeCapabilityResolver } from '../packages/development-guardian/delivery/runtime-plan.js'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { governanceDraft, governanceRequirement } from './fixtures/governance-customer.js'

test('isolated Customer Mode binds receipts and evidence, preserves snapshots and re-reviews adopted advice without execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nw-governance-customer-'))
  const env = { ...process.env, NOVAWING_DATA_DIR: join(root, 'data'), NOVAWING_CONFIG_DIR: join(root, 'configs') }
  const paths = platformPaths({ env })
  assert.equal(paths.data, env.NOVAWING_DATA_DIR)
  const repo = join(root, 'repo')
  await mkdir(repo)
  const run = promisify(execFile)
  const git = (...args: string[]) => run('git', args, { cwd: repo })
  await git('init', '-qb', 'codex/isolated-governance')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repo, 'README.md'), 'isolated governance acceptance\n')
  await git('add', '.')
  await git('commit', '-qm', 'isolated baseline')
  const baseline = (await git('rev-parse', 'HEAD')).stdout
  const store = new PlanningStore(join(paths.data, 'planning', 'plans'))
  const events = new PlanningEventStore(join(paths.data, 'planning', 'events.jsonl'))
  let plannerCalls = 0; let auditorCalls = 0; let adjudicatorCalls = 0; let runtimeCalls = 0
  const service = new PlanningService(async () => {
    plannerCalls++; return { text: JSON.stringify(governanceDraft()), provider: 'codex', model: 'fixture-only' }
  }, store, events, createDeepSeekPlanningSemanticReviewer({ runner: async () => {
    auditorCalls++; return { text: '{"verdict":"PASS","issues":[]}', provider: 'deepseek', model: 'fixture-only' }
  } }))
  let mode: 'FAILED' | 'NEEDS_EVIDENCE' | 'REVISE' = 'FAILED'
  const escalation = new EscalationService(join(paths.data, 'delivery', 'escalations'), async () => {
    adjudicatorCalls++
    return { provider: 'claude-configured-route', model: 'claude-fixture-only', text: mode === 'FAILED' ? '{}' :
      JSON.stringify({ verdict: mode, rootCause: '订单行为必须保留', keep: ['持久化及重读'], remove: ['无关扩展'],
        change: ['重新规划实现步骤'], nextAction: ['重新独立审查并由客户批准'], acceptanceCriteria: ['同一订单重读状态相同'] }) }
  })
  const deliveryStore = new DeliveryStore(join(paths.data, 'delivery'))
  const delivery = new DeliveryService(deliveryStore, new DeliveryEventStore(join(paths.data, 'delivery', 'events.jsonl')),
    { configured: async () => true, executorAvailable: async () => true, reviewerAvailable: async () => true,
      createAndStart: async () => { runtimeCalls++; throw new Error('No automatic execution permitted') } }, conservativeCapabilityResolver, 'fixture-policy')
  const launchpad = await createNovaWingLaunchpad({ env, dependencies: {
    planningService: service, escalationService: escalation, deliveryService: delivery,
    createWorkSession: async () => { runtimeCalls++; throw new Error('No automatic execution permitted') },
  } })
  try {
    const address = await launchpad.start()
    const post = async (path: string, body: unknown) => {
      const response = await fetch(address.url + path, { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: address.url, 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest(),
      }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    const generated = await post('/api/planning/generate', { requirement: governanceRequirement })
    assert.equal(generated.status, 200)
    const initial = generated.body.plan
    assert.equal(initial.status, 'ready_for_approval')
    const changed = (await store.get(initial.id))!
    changed.tasks[0]!.objective += ' drift'
    await store.save(changed)
    assert.equal((await post('/api/planning/approve', { planId: initial.id, version: 1 })).status, 409)
    const revised = await post('/api/planning/generate', { requirement: governanceRequirement, planId: initial.id,
      expectedVersion: 1, feedback: '保留订单持久化及重读行为，重新审查方案。' })
    assert.equal(revised.body.plan.version, 2)
    assert.equal(revised.body.plan.semanticReviewBinding.planVersion, 2)
    assert.equal((await post('/api/planning/approve', { planId: initial.id, version: 2 })).body.status, 'frozen')
    const frozen = (await service.getSnapshot(initial.id, 2))!
    const snapshotPath = join(store.directory, `${initial.id}.v2.snapshot.json`)
    const snapshotBytes = await readFile(snapshotPath, 'utf8')
    const prepared = await post('/api/delivery/prepare', { planId: initial.id, version: 2,
      snapshotId: frozen.id, repositoryRoot: repo })
    assert.equal(prepared.status, 200)
    assert.equal(prepared.body.admission.status, 'READY')
    const request = { planId: initial.id, version: 2, reason: '复核方向', runtimePlanId: prepared.body.runtimePlanId }
    assert.equal((await post('/api/governance/escalate', { ...request, version: 1 })).status, 409)
    assert.equal((await post('/api/governance/escalate', { ...request, runtimePlanId: 'unknown' })).status, 409)
    assert.equal(adjudicatorCalls, 0)
    const failed = await post('/api/governance/escalate', request)
    assert.equal(failed.status, 503)
    assert.equal((await escalation.get(failed.body.id)).status, 'FAILED')
    mode = 'NEEDS_EVIDENCE'
    const missing = await post('/api/governance/escalate', request)
    assert.equal(missing.body.decision.verdict.verdict, 'NEEDS_EVIDENCE')
    const packet = (await escalation.get(missing.body.id)).packet as { evidence: { missing: string[] } }
    assert.ok(packet.evidence.missing.some((item) => item.includes('Fresh deterministic')))
    assert.equal((await service.get(initial.id))!.version, 2)
    assert.equal(runtimeCalls, 0)
    mode = 'REVISE'
    const advice = await post('/api/governance/escalate', request)
    assert.equal(advice.body.decision.advisory, true)
    const notes = advice.body.decision.verdict.change.join('\n')
    const change = await post('/api/planning/change-requests', { planId: initial.id, version: 2,
      reason: '按独立纠偏建议重新规划', requestedChange: notes })
    const adopted = await post('/api/planning/generate', { requirement: governanceRequirement, planId: initial.id,
      expectedVersion: 2, feedback: notes, changeRequestId: change.body.id })
    assert.equal(adopted.body.plan.version, 3)
    assert.equal(adopted.body.plan.status, 'ready_for_approval')
    assert.equal(adopted.body.plan.semanticReviewBinding.planVersion, 3)
    assert.equal(adopted.body.plan.approval, undefined)
    assert.equal(await service.getSnapshot(initial.id, 3), undefined)
    assert.equal(await readFile(snapshotPath, 'utf8'), snapshotBytes)
    assert.equal((await post('/api/governance/escalate', request)).status, 409)
    assert.equal((await post('/api/planning/approve', { planId: initial.id, version: 2 })).status, 409)
    assert.equal((await post('/api/planning/approve', { planId: initial.id, version: 3 })).body.status, 'frozen')
    assert.equal((await new PlanningStore(store.directory).getSnapshot(initial.id, 3))!.supersedesSnapshotId, frozen.id)
    assert.equal(await readFile(snapshotPath, 'utf8'), snapshotBytes)
    assert.equal(runtimeCalls, 0)
    assert.equal((await git('rev-parse', 'HEAD')).stdout, baseline)
    assert.equal((await git('status', '--porcelain')).stdout, '')
    assert.deepEqual([plannerCalls, auditorCalls, adjudicatorCalls], [3, 3, 3])
    t.diagnostic(JSON.stringify({ root, realModelCalls: 0, fixtureCalls: { plannerCalls, auditorCalls, adjudicatorCalls },
      runtimeCalls, snapshotId: frozen.id, runtimePlanId: prepared.body.runtimePlanId, result: 'PASS' }))
  } finally { await launchpad.close() }
})
