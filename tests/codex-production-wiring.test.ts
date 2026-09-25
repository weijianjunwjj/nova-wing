import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexTestRepo } from './codex-test-fixture.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'
import type { ExecutionReport } from '../packages/development-guardian/model.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import type { RouterCodexExecutor } from '../packages/development-guardian/executor-router.js'
import { ReviewerRuntimeRegistry } from '../packages/development-guardian/work-session/reviewer-runtime.js'
import type { RuntimeModelPolicy } from '../packages/development-guardian/runtime-config/model-policy.js'

for (const [mode, quota, active] of [
  ['auto', false, 'codex'], ['auto', true, 'deepseek'], ['codex', true, 'codex'], ['codex', false, 'codex'], ['deepseek', false, 'deepseek'],
] as const) test(`production Guardian/UI wiring: ${mode}, quota=${quota}, active=${active}`, async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-codex-production-'))
  let brainCalls = 0
  let codexCalls = 0
  let deepseekCalls = 0
  let runtime: WorkSessionRuntimeConfig | undefined
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  const evidence = (): ExecutionReport => ({ summary: 'Scoped change verified', changedFiles: [], commandsRun: ['git diff --check'],
    verificationResults: [{ name: 'git diff --check', status: 'passed' }], blockers: [] })
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'coding-production', targetRepo: root, branch: 'main', ...(mode === 'codex' ? { controlPlane: 'v1' } : {}), limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Make scoped change', guardian: { constraints: [], acceptanceCriteria: ['Verified'],
        doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
      executor: { defaultMode: mode, model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      gitCheckpoint: { autoCommit: false, autoPush: false }, notification: { email: { enabled: false } },
      storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    app = await createProductionWorkSessionUi(config, {
      env: { NOVAWING_DATA_DIR: data },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createBrain: () => ({ review: async ({ task }) => { brainCalls++; return { goal: task.goal,
        verdict: task.lastReport ? 'done' : 'proceed', instructions: ['Implement scoped change'], constraints: [], doNotDo: [], verification: [] } } }),
      createCodexExecutor(options) {
        assert.equal(options.codexModel, 'gpt-5.6-sol')
        assert.equal(options.reasoningEffort, 'medium')
        assert.equal(options.cwd, root)
        const executor: RouterCodexExecutor = { execute: async () => {
          assert.ok(brainCalls > 0, 'V1 review remains a precondition of execution')
          codexCalls++
          options.onThread?.('production-thread', false)
          executor.lastError = quota ? classifyCodexError({ code: 'quota_exhausted' }) : undefined
          return { ...evidence(), blockers: executor.lastError ? [executor.lastError.message] : [] }
        } }
        return executor
      },
      createExecutor(options) {
        if (quota) assert.match(options.additionalExecutionContext ?? '', /Codex quota handoff/)
        return { execute: async () => { deepseekCalls++; return evidence() } }
      },
    })
    assert.ok(runtime!.taskRunner instanceof GuardianWorkSessionTaskRunner)
    assert.equal(app.definition.controlPlane, mode === 'codex' ? 'v1' : undefined)
    const outcome = await runtime!.taskRunner.run(app.definition.tasks[0]!)
    assert.equal(outcome.status, mode === 'codex' && quota ? 'HUMAN_REQUIRED' : 'COMPLETED')
    assert.ok(brainCalls > 0)
    assert.equal(codexCalls, mode === 'deepseek' ? 0 : 1)
    assert.equal(deepseekCalls, active === 'deepseek' ? 1 : 0)
    const displayed = app.controller.getSnapshot().codingExecutions?.[0]
    assert.equal(displayed?.activeExecutor, active)
    assert.equal(displayed?.mode, mode)
    assert.equal(JSON.stringify(displayed).includes('production-thread'), false, 'UI never dumps provider thread state')
    if (mode === 'auto' && quota) assert.deepEqual(displayed?.history, ['codex', 'deepseek'])
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})

test('Desk-managed implementation policy reaches execution and remains sticky across runtime recreation', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-managed-production-'))
  const observed: Array<{ model: string | undefined; reasoning: string | undefined }> = []
  const apps: Array<Awaited<ReturnType<typeof createProductionWorkSessionUi>>> = []
  const evidence = (): ExecutionReport => ({ summary: 'Scoped change verified', changedFiles: [], commandsRun: ['git diff --check'],
    verificationResults: [{ name: 'git diff --check', status: 'passed' }], blockers: [] })
  try {
    const makeConfig = async (storageName: string) => validateTrustedWorkSessionConfig({
      session: { id: 'managed-production', targetRepo: root, branch: 'main', controlPlane: 'v1', limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Make scoped change', guardian: { constraints: [], acceptanceCriteria: ['Verified'],
        doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
      runtimeConfig: { managed: true },
      executor: { defaultMode: 'deepseek', model: 'legacy-sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      gitCheckpoint: { autoCommit: false, autoPush: false }, notification: { email: { enabled: false } },
      storageUrl: pathToFileURL(join(data, storageName)).href,
    })
    const run = async (model: 'gpt-6-luna' | 'gpt-6-sol', reasoningEffort: 'high' | 'max', storageName: string) => {
      let runtime: WorkSessionRuntimeConfig | undefined
      const app = await createProductionWorkSessionUi(await makeConfig(storageName), {
        env: { NOVAWING_DATA_DIR: data },
        resolveRuntimeModelPolicy: async () => ({ source: 'remote', contractVersion: 1, policy: {
          implementation: { adapter: 'codex', model, reasoningEffort },
          review: { adapter: 'deepseek', model: 'sonnet' },
        } }),
        createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
        createBrain: () => ({ review: async ({ task }) => ({ goal: task.goal, verdict: task.lastReport ? 'done' : 'proceed',
          instructions: ['Implement'], constraints: [], doNotDo: [], verification: [] }) }),
        createCodexExecutor(options) {
          observed.push({ model: options.codexModel, reasoning: options.reasoningEffort })
          return { execute: async () => evidence() }
        },
        createExecutor: () => ({ execute: async () => { throw new Error('managed Codex policy must override the legacy default mode') } }),
      })
      apps.push(app)
      assert.equal((await runtime!.taskRunner.run(app.definition.tasks[0]!)).status, 'COMPLETED')
    }

    await run('gpt-6-luna', 'high', 'first.db')
    await apps.pop()!.close()
    await run('gpt-6-sol', 'max', 'second.db')
    assert.deepEqual(observed, [
      { model: 'gpt-6-luna', reasoning: 'high' },
      { model: 'gpt-6-luna', reasoning: 'high' },
    ], 'persisted task identity wins over a changed remote policy after resume')
  } finally {
    await Promise.all(apps.map((app) => app.close()))
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
})

test('Desk resolver failure cannot prevent managed Runtime creation or execution', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-managed-offline-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'managed-offline', targetRepo: root, branch: 'main', controlPlane: 'v1', limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Work offline', guardian: { constraints: [], acceptanceCriteria: ['Verified'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
      runtimeConfig: { managed: true },
      executor: { model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      gitCheckpoint: { autoCommit: false, autoPush: false },
      storageUrl: pathToFileURL(join(data, 'offline.db')).href,
    })
    app = await createProductionWorkSessionUi(config, {
      env: { NOVAWING_DATA_DIR: data },
      resolveRuntimeModelPolicy: async () => { throw new Error('Desk offline') },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createBrain: () => ({ review: async ({ task }) => ({ goal: task.goal, verdict: task.lastReport ? 'done' : 'proceed', instructions: ['Implement'], constraints: [], doNotDo: [], verification: [] }) }),
      createCodexExecutor(options) {
        assert.equal(options.codexModel, 'gpt-5.6-terra')
        assert.equal(options.reasoningEffort, 'high')
        return { execute: async () => ({ summary: 'offline success', changedFiles: [], commandsRun: ['git diff --check'], verificationResults: [{ name: 'git diff --check', status: 'passed' }], blockers: [] }) }
      },
    })
    assert.equal((await runtime!.taskRunner.run(app.definition.tasks[0]!)).status, 'COMPLETED')
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})

test('Desk-managed review policy reaches the production reviewer composition root', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-managed-review-'))
  let observed: RuntimeModelPolicy | undefined
  let resolves = 0
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'managed-review', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Review work', guardian: { constraints: [], acceptanceCriteria: ['Verified'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
      runtimeConfig: { managed: true },
      executor: { model: 'legacy-sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      gitCheckpoint: { autoCommit: false, autoPush: false },
      storageUrl: pathToFileURL(join(data, 'review.db')).href,
    })
    app = await createProductionWorkSessionUi(config, {
      env: { NOVAWING_DATA_DIR: data },
      resolveRuntimeModelPolicy: async () => {
        resolves++
        return { source: 'remote', contractVersion: 1, policy: {
          implementation: { adapter: 'codex', model: 'gpt-6-luna', reasoningEffort: 'high' },
          review: { adapter: 'deepseek', model: 'sonnet' },
        } }
      },
      createReviewerRegistry({ policy }) { observed = policy; return new ReviewerRuntimeRegistry([]) },
      createRuntime(input) { return new FakeRuntime(input.definition) },
    })
    assert.equal(resolves, 1)
    assert.deepEqual(observed?.review, { adapter: 'deepseek', model: 'sonnet' })
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})
