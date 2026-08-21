/**
 * W003 FINAL F: WorkSessionRuntime 正式 Legacy Recovery API 集成测试
 *
 * 正例：
 * - Legacy adoption → GuardianTaskRecoveryCheckpoint
 * - 使用正式 WorkSessionRuntime.resumeFromRecoveryCheckpoint
 * - runtime 重建（模拟 process/runtime recreation）
 * - 最终 Task COMPLETED + currentTaskCheckpoint cleared
 *
 * 负例：
 * - checkpoint task T1，session currentTask T2
 * - resumeFromRecoveryCheckpoint 必须 fail closed（抛错）
 * - provider invocation = 0
 *
 * 断言测试代码不直接操作 Mastra raw snapshot（不 import workflows storage domain）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptLegacyRecoveryCheckpoint } from '../packages/development-guardian/work-session/legacy-recovery.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import {
  WorkSessionRuntime,
  type WorkSessionDefinition,
} from '../packages/development-guardian/work-session/index.js'
import type {
  DelegationPacket,
  ExecutionReport,
} from 'nova-wing/development-guardian'

// ============ Git Test Helper ============

type GitRunResult = {
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function setupTestGitRepo(baseDir: string): Promise<{
  repoPath: string
  gitRunner: (cmd: string) => Promise<GitRunResult>
}> {
  const repoPath = join(baseDir, 'test-repo')
  await mkdir(repoPath, { recursive: true })

  const gitRunner = async (cmd: string) => {
    const { spawn } = await import('node:child_process')
    return new Promise<GitRunResult>((resolve) => {
      const child = spawn('bash', ['-lc', cmd], {
        cwd: repoPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('exit', (exitCode, signal) => {
        resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr })
      })
    })
  }

  await gitRunner('git init')
  await gitRunner('git config user.email "test@example.com"')
  await gitRunner('git config user.name "Test User"')
  await writeFile(join(repoPath, 'README.md'), '# Test Repo')
  await gitRunner('git add README.md')
  await gitRunner('git commit -m "Initial commit"')
  await gitRunner('git checkout -b feat/t')
  await mkdir(join(repoPath, 'src'), { recursive: true })

  return { repoPath, gitRunner }
}

function makeDefinition(id: string, repoPath: string, taskId: string): WorkSessionDefinition {
  return {
    id,
    targetRepo: repoPath,
    branch: 'feat/t',
    tasks: [{ id: taskId, goal: `${taskId} 的任务` }],
    limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
  }
}

// ============ Test Case: 正例（正式 recovery API → COMPLETED） ============

await test('W003 FINAL F: resumeFromRecoveryCheckpoint completes task and clears checkpoint', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-runtime-recovery-'))
  const storageUrl = `file:${join(tempBase, 'recovery.db')}`
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // dirty legacy worktree
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // legacy partial\n')
    await writeFile(join(repoPath, 'src/untracked-notes.md'), '# manual notes\n')

    // ===== Legacy adoption =====
    const adopted = await adoptLegacyRecoveryCheckpoint({
      task: {
        id: 'T002',
        goal: 'T002 的任务',
        constraints: ['只允许修改 src/**'],
        acceptanceCriteria: ['npm run typecheck 通过'],
        doNotDo: ['不要 git commit'],
        allowedPaths: ['src/**'],
      },
      repoPath,
      gitRunner,
    })
    assert.strictEqual(adopted.task.id, 'T002')
    assert.strictEqual(Object.keys(adopted.provider).length, 0, 'provider must be empty')

    const definition = makeDefinition('recovery-api-positive', repoPath, 'T002')

    // ===== Seed run：fake provider → SUSPENDED snapshot（不用 raw snapshot 操作） =====
    const seedBrain = {
      review: async (): Promise<DelegationPacket> => ({
        verdict: 'blocked',
        goal: 'T002 的任务',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
        rationale: 'seed run',
      }),
      captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
    }
    const seedExecutor = {
      execute: async (): Promise<ExecutionReport> => ({
        summary: 'seed noop',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [],
        blockers: [],
      }),
      captureProviderState: () => ({}),
    }
    const seedRunner = new GuardianWorkSessionTaskRunner({
      brain: seedBrain,
      createExecutor: () => seedExecutor,
      repoPath,
      gitRunner,
    })
    const runtimeA = new WorkSessionRuntime({ definition, taskRunner: seedRunner, storageUrl })
    const seedState = await runtimeA.start()
    assert.strictEqual(seedState.state, 'SUSPENDED', 'seed run must suspend')
    await runtimeA.close()

    // ===== Runtime recreation → 正式 recovery API =====
    const reviewCalls: string[] = []
    const realBrain = {
      review: async (): Promise<DelegationPacket> => {
        reviewCalls.push('review')
        if (reviewCalls.length === 1) {
          return {
            verdict: 'revise',
            goal: 'T002 的任务',
            instructions: ['继续实现 src/feature.ts'],
            constraints: [],
            verification: ['git diff --check'],
            doNotDo: [],
            rationale: '继续既有进度',
          }
        }
        return {
          verdict: 'done',
          goal: 'T002 的任务',
          instructions: [],
          constraints: [],
          verification: ['git diff --check'],
          doNotDo: [],
          rationale: '验收条件满足',
        }
      },
      captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
    }
    const realExecutor = {
      execute: async (): Promise<ExecutionReport> => {
        await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 3 // completed\n')
        return {
          summary: 'T002 completed',
          changedFiles: ['src/feature.ts'],
          commandsRun: ['claude -p --output-format json'],
          verificationResults: [{ name: 'git diff --check', status: 'passed' }],
          blockers: [],
        }
      },
      captureProviderState: () => ({}),
    }
    const realRunner = new GuardianWorkSessionTaskRunner({
      brain: realBrain,
      createExecutor: () => realExecutor,
      repoPath,
      gitRunner,
    })
    const runtimeB = new WorkSessionRuntime({ definition, taskRunner: realRunner, storageUrl })

    const result = await runtimeB.resumeFromRecoveryCheckpoint({
      sessionId: definition.id,
      checkpoint: adopted,
    })

    // ===== WorkSession 结果 =====
    assert.strictEqual(result.state, 'COMPLETED', 'recovery API must complete the task')
    assert.ok(result.completedTaskIds.includes('T002'), 'T002 must be completed')
    assert.strictEqual(
      result.currentTaskCheckpoint,
      undefined,
      'currentTaskCheckpoint must be cleared after completion',
    )

    await runtimeB.close()
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Test Case: 负例（identity mismatch → fail closed） ============

await test('W003 FINAL F: checkpoint task mismatch fails closed with zero provider invocations', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-runtime-recovery-neg-'))
  const storageUrl = `file:${join(tempBase, 'recovery-neg.db')}`
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // legacy partial\n')

    // checkpoint 属于 T1
    const adoptedT1 = await adoptLegacyRecoveryCheckpoint({
      task: { id: 'T1', goal: 'T1 的任务' },
      repoPath,
      gitRunner,
    })

    // session 的 currentTask 是 T2
    const definition = makeDefinition('recovery-api-negative', repoPath, 'T2')

    const seedBrain = {
      review: async (): Promise<DelegationPacket> => ({
        verdict: 'blocked',
        goal: 'T2 的任务',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
        rationale: 'seed run',
      }),
      captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
    }
    const seedExecutor = {
      execute: async (): Promise<ExecutionReport> => ({
        summary: 'seed noop',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [],
        blockers: [],
      }),
      captureProviderState: () => ({}),
    }
    const seedRunner = new GuardianWorkSessionTaskRunner({
      brain: seedBrain,
      createExecutor: () => seedExecutor,
      repoPath,
      gitRunner,
    })
    const runtimeA = new WorkSessionRuntime({ definition, taskRunner: seedRunner, storageUrl })
    const seedState = await runtimeA.start()
    assert.strictEqual(seedState.state, 'SUSPENDED', 'seed run must suspend')
    await runtimeA.close()

    // 负例 runner：记录 provider invocation
    let reviewCalls = 0
    let executeCalls = 0
    const countingBrain = {
      review: async (): Promise<DelegationPacket> => {
        reviewCalls += 1
        return {
          verdict: 'blocked',
          goal: 'T2 的任务',
          instructions: [],
          constraints: [],
          verification: [],
          doNotDo: [],
          rationale: 'should not be reached',
        }
      },
      captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
    }
    const countingExecutor = {
      execute: async (): Promise<ExecutionReport> => {
        executeCalls += 1
        return {
          summary: 'should not be reached',
          changedFiles: [],
          commandsRun: [],
          verificationResults: [],
          blockers: [],
        }
      },
      captureProviderState: () => ({}),
    }
    const countingRunner = new GuardianWorkSessionTaskRunner({
      brain: countingBrain,
      createExecutor: () => countingExecutor,
      repoPath,
      gitRunner,
    })
    const runtimeB = new WorkSessionRuntime({ definition, taskRunner: countingRunner, storageUrl })

    await assert.rejects(
      runtimeB.resumeFromRecoveryCheckpoint({
        sessionId: definition.id,
        checkpoint: adoptedT1,
      }),
      /does not match session current task/,
      'T1 checkpoint must fail against T2 session',
    )

    assert.strictEqual(reviewCalls, 0, 'AskBridge must NOT be invoked on identity mismatch')
    assert.strictEqual(executeCalls, 0, 'Executor must NOT be invoked on identity mismatch')

    await runtimeB.close()
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
