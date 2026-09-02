import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DelegationPacket, ExecutionReport } from '../packages/development-guardian/model.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import { adoptLegacyRecoveryCheckpoint } from '../packages/development-guardian/work-session/legacy-recovery.js'
import { WorkSessionRuntime, type WorkSessionDefinition } from '../packages/development-guardian/work-session/index.js'
import { guardianShellTestCommand } from './guardian-shell-fixture.js'

test('failed transient Executor provider turn resumes the same session from a verified dirty checkpoint', async () => {
  const base = await mkdtemp(join(tmpdir(), 'novawing-executor-provider-recovery-'))
  const repoPath = join(base, 'repo')
  const storageUrl = `file:${join(base, 'session.db')}`
  await mkdir(join(repoPath, 'src'), { recursive: true })
  const gitRunner = async (command: string) => {
    const { spawn } = await import('node:child_process')
    return await new Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
      const shell = guardianShellTestCommand(command)
      const child = spawn(shell.executable, shell.args, { cwd: repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr }))
    })
  }
  await gitRunner('git init')
  await gitRunner('git config user.email test@example.com')
  await gitRunner('git config user.name Test')
  await writeFile(join(repoPath, 'README.md'), '# repo\n')
  await gitRunner('git add README.md')
  await gitRunner('git commit -m initial')
  await gitRunner('git checkout -b feat/recovery')

  const definition: WorkSessionDefinition = {
    id: 'executor-provider-recovery', targetRepo: repoPath, branch: 'feat/recovery',
    tasks: [{ id: 'T030', goal: 'finish existing edits' }],
    limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
  }
  const proceed: DelegationPacket = { verdict: 'proceed', goal: 'finish existing edits', instructions: ['continue'],
    constraints: [], verification: [], doNotDo: [], rationale: 'start' }
  const seedRunner = new GuardianWorkSessionTaskRunner({
    brain: { review: async () => proceed },
    createExecutor: () => ({ execute: async () => {
      await writeFile(join(repoPath, 'src/feature.ts'), 'export const value = 1\n')
      throw Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' })
    } }),
    repoPath, gitRunner,
  })
  const runtimeA = new WorkSessionRuntime({ definition, taskRunner: seedRunner, storageUrl })
  try {
    await assert.rejects(runtimeA.start(), /spawn ENAMETOOLONG/u)
  } finally { await runtimeA.close() }

  const checkpoint = await adoptLegacyRecoveryCheckpoint({
    task: { id: 'T030', goal: 'finish existing edits', allowedPaths: ['src/**'] }, repoPath, gitRunner,
  })
  assert.deepEqual(checkpoint.repo.changedFiles, ['src/feature.ts'])

  let reviews = 0
  let executions = 0
  const recoveryRunner = new GuardianWorkSessionTaskRunner({
    brain: { review: async (): Promise<DelegationPacket> => {
      reviews++
      return reviews === 1 ? { ...proceed, verdict: 'revise' } : { ...proceed, verdict: 'done' }
    } },
    createExecutor: () => ({ execute: async (): Promise<ExecutionReport> => {
      executions++
      await writeFile(join(repoPath, 'src/feature.ts'), 'export const value = 2\n')
      return { summary: 'recovered', changedFiles: ['src/feature.ts'], commandsRun: ['edit'],
        verificationResults: [{ name: 'git diff --check', status: 'passed' }], blockers: [] }
    }, captureProviderState: () => ({}) }),
    repoPath, gitRunner,
  })
  const runtimeB = new WorkSessionRuntime({ definition, taskRunner: recoveryRunner, storageUrl })
  try {
    const result = await runtimeB.recoverFailedExecutorWithCheckpoint({ sessionId: definition.id, checkpoint })
    assert.equal(result.state, 'COMPLETED')
    assert.deepEqual(result.completedTaskIds, ['T030'])
    assert.equal(executions, 1)
    assert.equal(reviews, 2)
  } finally {
    await runtimeB.close()
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
})

test('provider recovery accepts one intervening stale-ownership failure and invokes the recovery hook', async () => {
  const base = await mkdtemp(join(tmpdir(), 'novawing-executor-ownership-recovery-'))
  const repoPath = join(base, 'repo')
  const storageUrl = `file:${join(base, 'session.db')}`
  await mkdir(join(repoPath, 'src'), { recursive: true })
  const gitRunner = async (command: string) => {
    const { spawn } = await import('node:child_process')
    return await new Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
      const shell = guardianShellTestCommand(command)
      const child = spawn(shell.executable, shell.args, { cwd: repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.once('exit', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr }))
    })
  }
  await gitRunner('git init'); await gitRunner('git config user.email test@example.com')
  await gitRunner('git config user.name Test'); await writeFile(join(repoPath, 'README.md'), '# repo\n')
  await gitRunner('git add README.md'); await gitRunner('git commit -m initial'); await gitRunner('git checkout -b feat/recovery')
  const definition: WorkSessionDefinition = { id: 'ownership-recovery', targetRepo: repoPath, branch: 'feat/recovery',
    tasks: [{ id: 'T030', goal: 'finish edits' }], limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 } }
  for (const message of ['spawn ENAMETOOLONG', 'Executor ownership unavailable; confirm the previous local writer has stopped before recovery']) {
    const runner = { run: async () => {
      await writeFile(join(repoPath, 'src/feature.ts'), 'edit\n')
      return { status: 'FAILED' as const, error: message, failureStage: 'EXECUTOR' as const,
        failureCategory: 'PROVIDER_ERROR' as const }
    } }
    const runtime = new WorkSessionRuntime({ definition, taskRunner: runner, storageUrl })
    try {
      if (message.startsWith('spawn')) {
        await runtime.start().catch(() => undefined)
        assert.equal((await runtime.loadPersistedState())?.state, 'FAILED')
      }
      else {
        const checkpoint = await adoptLegacyRecoveryCheckpoint({ task: { id: 'T030', goal: 'finish edits', allowedPaths: ['src/**'] }, repoPath, gitRunner })
        const failed = await runtime.recoverFailedExecutorWithCheckpoint({ sessionId: definition.id, checkpoint })
        assert.equal(failed.state, 'FAILED')
        assert.match(failed.safeFailureMessage ?? '', /ownership unavailable/)
      }
    } finally { await runtime.close() }
  }
  const checkpoint = await adoptLegacyRecoveryCheckpoint({ task: { id: 'T030', goal: 'finish edits', allowedPaths: ['src/**'] }, repoPath, gitRunner })
  let recovered = 0
  const finalRunner = { run: async () => ({ status: 'COMPLETED' as const, summary: 'done' }) }
  const runtime = new WorkSessionRuntime({ definition, taskRunner: finalRunner, storageUrl,
    recoverExecutorOwnership: async () => { recovered++ } })
  try {
    const result = await runtime.recoverFailedExecutorWithCheckpoint({ sessionId: definition.id, checkpoint })
    assert.equal(result.state, 'COMPLETED'); assert.equal(recovered, 1)
  } finally { await runtime.close(); await rm(base, { recursive: true, force: true }).catch(() => {}) }
})
