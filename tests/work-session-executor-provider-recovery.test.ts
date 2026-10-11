import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptLegacyRecoveryCheckpoint } from '../packages/development-guardian/work-session/legacy-recovery.js'
import { WorkSessionRuntime, type WorkSessionDefinition } from '../packages/development-guardian/work-session/index.js'
import { guardianShellTestCommand } from './guardian-shell-fixture.js'

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
