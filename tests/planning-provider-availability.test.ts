import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Codex, Thread, ThreadEvent } from '@openai/codex-sdk'

import { planDraftSchema, type PlanDraft } from '../packages/development-guardian/planning/model.js'
import { createCodexPlanningProvider } from '../packages/development-guardian/planning/provider.js'
import { PlanningService, PlanningStore } from '../packages/development-guardian/planning/service.js'
import { PlanningEventStore } from '../packages/development-guardian/planning/telemetry.js'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { createCodexRepairModelRunner, RepairProviderUnavailableError,
  type RepairModelRunner } from '../packages/development-guardian/work-session/launchpad/repair-model.js'

const requirement = 'Build a local task list Web app. Users can add a task and see it after restart.'
const draft: PlanDraft = {
  clauses: [{ id: 'R1', statement: 'Users can add a task and see it after restart.', type: 'functional', priority: 'must',
    source: { excerpt: 'Users can add a task and see it after restart.', location: 'requirement', origin: 'customer_requirement' },
    ambiguity: { ambiguous: false, note: '' } }],
  analysis: { productGoal: 'A persistent local task list', summary: 'Add and reload tasks',
    userRoles: [{ id: 'U1', name: 'User', goals: ['Keep tasks'] }],
    businessFlows: [{ id: 'F1', title: 'Add and reload', steps: ['Add a task', 'Restart and reload'], requirementIds: ['R1'] }] },
  productScope: { inScope: ['Local tasks'], outOfScope: ['Cloud sync'] },
  architecture: { summary: 'A local Web app with persistent storage', components: ['Web UI', 'task store'], decisions: ['Save tasks locally'] },
  tasks: [{ id: 'T1', title: 'Persistent task creation', objective: 'Add and reload tasks', requirementIds: ['R1'],
    outputs: ['Task UI and persistent store'], dependencyIds: [], acceptanceCriterionIds: ['A1'], complexity: 'small' }],
  acceptancePlan: { strategy: 'Exercise the UI across restart', criteria: [{ id: 'A1', requirementIds: ['R1'],
    description: 'Added task survives restart', level: 'ui', expectedEvidence: 'Before and after task list', blocking: true,
    assertions: [{ id: 'AS1', requirementId: 'R1', observableBehavior: 'Add a task and restart the app',
      expectedOutcome: 'The same task appears after restart', expectedEvidence: 'UI task list before and after restart', blocking: true }] }] },
  risks: [], assumptions: [], customerQuestions: [],
}

function scriptedRunner(events: ThreadEvent[]): RepairModelRunner {
  return createCodexRepairModelRunner({ executable: '/test/codex', env: { HOME: '/test' },
    createCodex: () => ({ startThread: () => ({ runStreamed: async () => ({
      events: (async function* () { for (const event of events) yield event })(),
    }) }) as unknown as Thread }) as Pick<Codex, 'startThread'> })
}

test('Planning provider accepts a recovered Codex turn and returns a schema-valid draft', async () => {
  const output = JSON.stringify(draft)
  const events = [
    { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion)' },
    { type: 'item.completed', item: { id: 'plan', type: 'agent_message', text: output } },
    { type: 'turn.completed', usage: {} },
  ] as ThreadEvent[]
  const requests: Array<{ model: string; reasoningEffort: string; targetRepo: string; system: string }> = []
  const run = scriptedRunner(events)
  const provider = createCodexPlanningProvider({ runner: async (request) => {
    requests.push({ model: request.model, reasoningEffort: request.reasoningEffort, targetRepo: request.targetRepo, system: request.system })
    return run(request)
  } })
  const response = await provider({ requirement })
  assert.equal(response.provider, 'codex')
  assert.equal(response.model, 'gpt-6-sol')
  assert.deepEqual(requests.map(({ system: _system, ...request }) => request),
    [{ model: 'gpt-6-sol', reasoningEffort: 'medium', targetRepo: process.cwd() }])
  assert.match(requests[0]!.system, /foundation task must not be its sole owner when the behavior needs later UI/u)
  assert.match(requests[0]!.system, /do not combine the integration stage with final acceptance/u)
  assert.match(requests[0]!.system, /final end-to-end scenario criteria/u)
  const parsed = planDraftSchema.safeParse(JSON.parse(response.text))
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues))
})

test('a completed turn is required; structured terminal failures keep a useful safe reason', async () => {
  const run = scriptedRunner([
    { type: 'error', message: 'Reconnecting... 5/5' },
    { type: 'turn.failed', error: { message: 'stream disconnected before completion' } },
  ] as ThreadEvent[])
  await assert.rejects(run({ system: 'system', user: 'user', targetRepo: process.cwd(), model: 'gpt-6-sol',
    reasoningEffort: 'medium', timeoutMs: 1000 }), (error: unknown) => {
    assert.ok(error instanceof RepairProviderUnavailableError)
    assert.match(error.safeReason, /stream disconnected before completion/u)
    assert.doesNotMatch(error.safeReason, /\[object Object\]/u)
    return true
  })
})

test('Planning API distinguishes generator, semantic reviewer and other failures without leaking private text or starting Runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nw-planning-availability-'))
  const events = new PlanningEventStore(join(directory, 'events.jsonl'))
  let mode: 'provider' | 'other' | 'reviewer' = 'provider'
  let runtimeCalls = 0
  const service = new PlanningService(async () => {
    if (mode === 'provider') throw new RepairProviderUnavailableError('private prompt and credential', 'private credential')
    if (mode === 'other') throw new Error('private response and credential')
    return { text: JSON.stringify(draft), provider: 'fixture', model: 'fixture-model' }
  }, new PlanningStore(join(directory, 'plans')), events, async () => { throw new Error('private review and credential') })
  const launchpad = await createNovaWingLaunchpad({ configDirectory: join(directory, 'configs'), dependencies: {
    planningService: service,
    createWorkSession: async () => { runtimeCalls++; throw new Error('Runtime boundary crossed') },
  } })
  try {
    const address = await launchpad.start()
    const post = () => fetch(`${address.url}/api/planning/generate`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: address.url,
        'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest() },
      body: JSON.stringify({ requirement }) })
    const unavailable = await post()
    assert.equal(unavailable.status, 503)
    const providerBody = await unavailable.text()
    assert.equal(JSON.parse(providerBody).code, 'PLANNING_PROVIDER_UNAVAILABLE')
    mode = 'other'
    const other = await post()
    assert.equal(other.status, 503)
    const otherBody = await other.text()
    assert.equal(JSON.parse(otherBody).code, 'PLANNING_GENERATION_FAILURE')
    mode = 'reviewer'
    const reviewed = await post()
    assert.equal(reviewed.status, 200)
    const reviewBody = await reviewed.text()
    const result = JSON.parse(reviewBody) as { plan: { status: string; semanticReview: { issues: Array<{ code: string }> } } }
    assert.equal(result.plan.status, 'planning_failed')
    assert.equal(result.plan.semanticReview.issues[0]?.code, 'REVIEW_UNAVAILABLE')
    assert.equal(runtimeCalls, 0)
    const telemetry = await readFile(events.path, 'utf8')
    for (const value of ['private prompt', 'private response', 'private review', 'private credential']) {
      assert.ok(![providerBody, otherBody, reviewBody, telemetry].some((body) => body.includes(value)))
    }
    assert.ok(![providerBody, otherBody, telemetry].some((body) => body.includes(requirement)))
  } finally { await launchpad.close() }
})
