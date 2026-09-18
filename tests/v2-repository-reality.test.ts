import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import { finalizeCompletedTask } from '../packages/development-guardian/work-session/git-checkpoint.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'
import type { V2ActionDispatcher } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'

const exec = promisify(execFile)
test('production repository truth binds binary bytes, staged content, literal filenames, and Git completion transport', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'novawing-v2-reality-')))
  const data = await mkdtemp(join(tmpdir(), 'novawing-v2-reality-data-'))
  const git = (...args: string[]) => exec('git', args, { cwd: root, windowsHide: true })
  await mkdir(join(root, 'src'))
  await git('init', '-b', 'feat/test')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.invalid')
  const path = join(root, 'src', 'space name.bin')
  await writeFile(path, Buffer.from([0]))
  await git('add', '.')
  await git('commit', '-m', 'baseline')
  const config = await validateTrustedWorkSessionConfig({
    session: { id: 'v2-reality', targetRepo: root, branch: 'feat/test', controlPlane: 'v2', limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
    tasks: [{ id: 'T1', goal: 'verify', guardian: { constraints: [], acceptanceCriteria: ['tests'], doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] }, acceptanceEvidenceBindings: [{ criterion: 'tests', requiredEvidence: ['npm test'] }] }],
    executor: { model: 'test', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false }, gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
  })
  let runtime: WorkSessionRuntimeConfig | undefined
  const app = await createProductionWorkSessionUi(config, { env: { ...process.env, NOVAWING_DATA_DIR: data },
    createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
  })
  try {
    const dispatcher = (runtime!.taskRunner as unknown as { options: { dispatcher: V2ActionDispatcher } }).options.dispatcher
    await writeFile(path, Buffer.from([0x80]))
    const a = await dispatcher.inspectRepository()
    await writeFile(path, Buffer.from([0x81]))
    const b = await dispatcher.inspectRepository()
    assert.notEqual(a.worktreeFingerprint, b.worktreeFingerprint, 'invalid UTF-8 bytes must not collapse to the same evidence identity')
    assert.deepEqual(b.changedFiles, ['src/space name.bin'])
    await git('add', '.')
    await writeFile(path, Buffer.from([0x82]))
    const stagedA = await dispatcher.inspectRepository()
    await git('add', '.')
    await writeFile(path, Buffer.from([0x83]))
    await git('add', '.')
    await writeFile(path, Buffer.from([0x82]))
    const stagedB = await dispatcher.inspectRepository()
    assert.notEqual(stagedA.worktreeFingerprint, stagedB.worktreeFingerprint, 'same worktree with different index must invalidate evidence')
    await git('reset', '--mixed', 'HEAD')
    const approved = await dispatcher.inspectRepository()
    await writeFile(path, Buffer.from([0x84]))
    await assert.rejects(finalizeCompletedTask({ repoPath: root, expectedBranch: 'feat/test', task: app.definition.tasks[0]!, policy: { autoCommit: true, autoPush: false },
      completionEvidence: { repositoryReality: approved, changedFiles: approved.changedFiles, verificationResults: [{ name: 'npm test', status: 'passed' }], requiredVerification: ['npm test'], blockers: [], finalReviewerVerdict: 'done' },
    }), /Controller completion authorization/)
    assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), approved.headSha)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true, maxRetries: 3 }) }
})
