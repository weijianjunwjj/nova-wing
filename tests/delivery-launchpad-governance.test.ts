import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PlanningService, PlanningStore } from '../packages/development-guardian/planning/service.js'
import { PlanningEventStore } from '../packages/development-guardian/planning/telemetry.js'
import { createNovaWingLaunchpad } from '../packages/development-guardian/work-session/launchpad/server.js'
import { createProductionWorkSessionUi, type ProductionWorkSessionUi } from '../packages/development-guardian/work-session/production.js'
import { ReviewerRuntimeRegistry } from '../packages/development-guardian/work-session/reviewer-runtime.js'
import { BUILTIN_RUNTIME_MODEL_POLICY, cloneRuntimeModelPolicy } from '../packages/development-guardian/runtime-config/model-policy.js'
import { DEFAULT_WORKSPACE_FORBIDDEN_PATHS } from '../packages/development-guardian/workspace-scope.js'
import { governanceDraft, governanceRequirement } from './fixtures/governance-customer.js'
import { codexTestRepo } from './codex-test-fixture.js'

test('Launchpad production delivery assembly reaches the mock Executor and blocks exact permission drift before it', async (t) => {
  for (const mode of ['normal', 'remove-default', 'add-forbidden', 'change-allowed'] as const) await t.test(mode, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nw-launchpad-permissions-'))
    const repo = await codexTestRepo()
    const env = { NOVAWING_DATA_DIR: join(root, 'data'), NOVAWING_CONFIG_DIR: join(root, 'configs'),
      CLAUDE_CONFIG_DIR: join(root, 'empty-claude') }
    const planning = new PlanningService(async () => ({ text: JSON.stringify(governanceDraft()), provider: 'codex' }),
      new PlanningStore(join(env.NOVAWING_DATA_DIR, 'planning', 'plans')),
      new PlanningEventStore(join(env.NOVAWING_DATA_DIR, 'planning', 'events.jsonl')),
      async () => ({ review: { verdict: 'PASS', issues: [] }, provider: 'deepseek', model: 'fixture-only' }))
    const { plan } = await planning.generate(governanceRequirement)
    await planning.approve(plan.id, plan.version)
    const snapshot = (await planning.getSnapshot(plan.id, plan.version))!
    let app: ProductionWorkSessionUi | undefined
    let executorCalls = 0
    const actions: string[] = []
    const blockers: string[] = []
    const launchpad = await createNovaWingLaunchpad({ env, dependencies: {
      planningService: planning,
      resolveEnvironment: async () => env,
      resolveReviewerRouteAvailable: async () => true,
      resolveReviewerProvider: async () => 'deepseek',
      readCodexAvailability: () => ({ state: 'available' }),
      createWorkSession: async (config, options) => {
        // Keep the real Launchpad config, production task mapping, Controller,
        // WorkSessionRuntime, delivery decorator and default ExecutorRouter.
        // Only model transports and host availability probes are fixtures.
        assert.ok(options.createV2Dispatcher)
        assert.deepEqual(config.tasks[0]!.guardian.forbiddenPaths, [...DEFAULT_WORKSPACE_FORBIDDEN_PATHS])
        app = await createProductionWorkSessionUi(config, {
          ...options, desktopNotifier: null,
          resolveRuntimeModelPolicy: async () => ({ source: 'builtin', policy: cloneRuntimeModelPolicy(BUILTIN_RUNTIME_MODEL_POLICY) }),
          createReviewerRegistry: () => new ReviewerRuntimeRegistry([]),
          createExecutor: () => { throw new Error('No DeepSeek transport permitted') },
          createBrain: () => { throw new Error('No Brain transport permitted') },
          createCodexExecutor: () => ({ execute: async ({ task, packet }) => {
            executorCalls++
            assert.equal(packet.instructions[0], 'EXECUTE')
            assert.deepEqual(task.allowedPaths, ['.'])
            assert.deepEqual(task.forbiddenPaths, [...DEFAULT_WORKSPACE_FORBIDDEN_PATHS])
            return { summary: 'Mock Executor reached; stop before verification or review', changedFiles: [], commandsRun: [],
              verificationResults: [], blockers: ['fixture stop after EXECUTE'] }
          } }),
          createV2Dispatcher: (context) => {
            const governed = options.createV2Dispatcher!(context)
            return { ...governed, dispatch: async (input) => {
              actions.push(input.action)
              const permissions = { ...input.task.permissions }
              if (mode === 'remove-default') permissions.forbiddenPaths = permissions.forbiddenPaths.filter(path => path !== '.env')
              if (mode === 'add-forbidden') permissions.forbiddenPaths = [...permissions.forbiddenPaths, 'src/**']
              if (mode === 'change-allowed') permissions.allowedPaths = ['src/**']
              const result = await governed.dispatch({ ...input, task: { ...input.task, permissions } })
              blockers.push(...(result.blockers ?? []))
              return result
            } }
          },
        })
        return app
      },
    } })
    try {
      const address = await launchpad.start()
      const post = async (path: string, body: unknown) => {
        const response = await fetch(address.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
          Origin: address.url, 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest() }, body: JSON.stringify(body) })
        const result = await response.json()
        assert.ok(response.ok, JSON.stringify(result))
        return result
      }
      const prepared = await post('/api/delivery/prepare', { planId: plan.id, version: plan.version,
        snapshotId: snapshot.id, repositoryRoot: repo })
      assert.equal(prepared.admission.status, 'READY')
      const started = await post('/api/delivery/start', { planId: plan.id, version: plan.version,
        snapshotId: snapshot.id, sourcePlanHash: snapshot.planHash.value, runtimePlanId: prepared.runtimePlanId,
        runtimePlanHash: prepared.runtimePlanHash, targetBindingId: prepared.targetBindingId })
      assert.equal(started.status, 'STARTED')
      assert.ok(app)
      for (let attempt = 0; attempt < 200 && app.hasActiveSession(); attempt++) await delay(25)
      assert.equal(app.hasActiveSession(), false, 'production runtime must settle within the test budget')
      assert.equal(app.runtime.getDurableState()?.state, 'SUSPENDED')
      assert.deepEqual(actions, ['EXECUTE'])
      assert.equal(executorCalls, mode === 'normal' ? 1 : 0)
      assert.ok(blockers.some(value => value.startsWith(mode === 'normal' ? 'fixture stop' : 'GOVERNANCE_DRIFT:')))
      t.diagnostic(JSON.stringify({ root, repo, mode, actions, executorCalls, realModelCalls: 0, blockers }))
    } finally { await launchpad.close() }
  })
})
