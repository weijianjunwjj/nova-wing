import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'

test('production V2 composition root dispatches controller actions without Guardian orchestration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-production-v2-repo-'))
  const data = await mkdtemp(join(tmpdir(), 'novawing-production-v2-data-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  const actions: string[] = []
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'v2-production', targetRepo: root, branch: 'main', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Fix controller', guardian: { constraints: ['small'], acceptanceCriteria: ['verified'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: ['.env'] } }],
      executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false }, gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    const app = await createProductionWorkSessionUi(config, {
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      createV2Dispatcher: () => ({
        inspectRepository: async () => ({ branch: 'main', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
        dispatch: async ({ action }) => { actions.push(action); return action === 'VERIFY'
          ? { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }] }
          : { status: 'SUCCESS', changedFiles: [] } },
      }),
    })
    assert.ok(runtime!.taskRunner instanceof V2ControllerTaskRunner)
    const result = await runtime!.taskRunner.run(app.definition.tasks[0]!)
    assert.equal(result.status, 'COMPLETED')
    assert.deepEqual(actions, ['EXECUTE', 'VERIFY'])
    assert.deepEqual(app.definition.tasks[0]!.allowedPaths, ['src/**'])
    await app.close()
  } finally { await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})
