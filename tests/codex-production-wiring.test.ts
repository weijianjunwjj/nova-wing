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
import type { RouterCodexExecutor } from '../packages/development-guardian/executor-router.js'

for (const [mode, quota, active] of [
  ['auto', false, 'codex'], ['auto', true, 'deepseek'], ['codex', true, 'codex'], ['deepseek', false, 'deepseek'],
] as const) test(`production Guardian/UI wiring: ${mode}, quota=${quota}, active=${active}`, async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-codex-production-'))
  let codexCalls = 0
  let deepseekCalls = 0
  let runtime: WorkSessionRuntimeConfig | undefined
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  const evidence = (): ExecutionReport => ({ summary: 'Scoped change verified', changedFiles: [], commandsRun: ['git diff --check'],
    verificationResults: [{ name: 'git diff --check', status: 'passed' }], blockers: [] })
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'coding-production', targetRepo: root, branch: 'main', limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Make scoped change', guardian: { constraints: [], acceptanceCriteria: ['Verified'],
        doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
      executor: { defaultMode: mode, model: 'sonnet', maxTurns: 10, allowNpmInstall: false, allowPythonBootstrap: false },
      gitCheckpoint: { autoCommit: false, autoPush: false }, notification: { email: { enabled: false } },
      storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    app = await createProductionWorkSessionUi(config, {
      env: { LOCALAPPDATA: data },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createBrain: () => ({ review: async ({ task }) => ({ goal: task.goal,
        verdict: task.lastReport ? 'done' : 'proceed', instructions: ['Implement scoped change'], constraints: [], doNotDo: [], verification: [] }) }),
      createCodexExecutor(options) {
        assert.equal(options.codexModel, 'gpt-5.6-sol')
        assert.equal(options.reasoningEffort, 'medium')
        assert.equal(options.cwd, root)
        const executor: RouterCodexExecutor = { execute: async () => {
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
    const outcome = await runtime!.taskRunner.run(app.definition.tasks[0]!)
    assert.equal(outcome.status, mode === 'codex' && quota ? 'HUMAN_REQUIRED' : 'COMPLETED')
    assert.equal(codexCalls, mode === 'deepseek' ? 0 : 1)
    assert.equal(deepseekCalls, active === 'deepseek' ? 1 : 0)
    const displayed = app.controller.getSnapshot().codingExecutions?.[0]
    assert.equal(displayed?.activeExecutor, active)
    assert.equal(displayed?.mode, mode)
    assert.equal(JSON.stringify(displayed).includes('production-thread'), false, 'UI never dumps provider thread state')
    if (mode === 'auto' && quota) assert.deepEqual(displayed?.history, ['codex', 'deepseek'])
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})
