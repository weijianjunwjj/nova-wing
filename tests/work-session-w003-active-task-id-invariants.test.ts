/**
 * W003 activeTaskId Invariants Test
 *
 * 验证三个核心不变量：
 * 1. SAME EXECUTOR / SAME TASK / REVISE - 允许 dirty worktree
 * 2. NEW EXECUTOR / NO CHECKPOINT - 必须 fail closed
 * 3. NEW EXECUTOR / VALID CHECKPOINT - 验证后才能继续
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeCodeExecutor,
  type GuardianTask,
  type DelegationPacket,
} from 'nova-wing/development-guardian'

// 内部类型需要直接 import
import type { RepositoryCheckpoint } from '../packages/development-guardian/work-session/checkpoint.js'

// ============ Test Helpers ============

async function setupTestGitRepo(baseDir: string): Promise<{
  repoPath: string
  gitRunner: (cmd: string) => Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
}> {
  const repoPath = join(baseDir, 'test-repo')
  await mkdir(repoPath, { recursive: true })

  const gitRunner = async (cmd: string) => {
    const { spawn } = await import('node:child_process')
    return new Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
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

  // 初始化 git repo
  await gitRunner('git init')
  await gitRunner('git config user.email "test@example.com"')
  await gitRunner('git config user.name "Test User"')
  await writeFile(join(repoPath, 'README.md'), '# Test Repo')
  await gitRunner('git add README.md')
  await gitRunner('git commit -m "Initial commit"')

  return { repoPath, gitRunner }
}

async function captureRepositoryCheckpoint(
  repoPath: string,
  gitRunner: (cmd: string) => Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout: string; stderr: string }>
): Promise<RepositoryCheckpoint> {
  const branchResult = await gitRunner('git branch --show-current')
  const headResult = await gitRunner('git rev-parse HEAD')
  const statusResult = await gitRunner('git status --porcelain --untracked-files=all')

  const { parseGitStatus, computeWorktreeFingerprint } = await import(
    '../packages/development-guardian/work-session/worktree-fingerprint.js'
  )
  const entries = parseGitStatus(statusResult.stdout)
  const fingerprint = await computeWorktreeFingerprint(repoPath, entries)

  const changedFiles = statusResult.stdout
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.slice(3).trim())

  return {
    repoPath,
    branch: branchResult.stdout.trim(),
    headSha: headResult.stdout.trim(),
    changedFiles,
    worktreeFingerprint: fingerprint,
  }
}

// ============ TEST 1: Same Executor Revise ============

await test('W003 Invariant 1: same executor revise allows dirty worktree', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-invariant1-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    let claudeInvocationCount = 0

    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令 - 格式: bash -lc "exec claude ..."
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          // 第一次执行：创建 dirty file
          if (claudeInvocationCount === 1) {
            await writeFile(join(repoPath, 'test-dirty.txt'), 'first execution')
            return {
              exitCode: 0,
              signal: null,
              stdout: JSON.stringify({
                type: 'success',
                result: 'First execution done',
                session_id: 'claude-session-1',
              }),
              stderr: '',
            }
          }
          // 第二次执行 (revise)：继续
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Revise execution done',
              session_id: 'claude-session-1',
            }),
            stderr: '',
          }
        }
        // Git 命令 - 格式: bash -lc "<git command>"
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    const task: GuardianTask = {
      id: 'T1',
      goal: 'Test same executor revise',
      iteration: 1,
      state: 'READY',
      maxIterations: 3,
    }

    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'Test task',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    // 第一次执行：clean worktree
    const report1 = await executor.execute({ task, packet })
    assert.strictEqual(report1.blockers.length, 0, 'First execution must succeed')
    assert.strictEqual(report1.changedFiles.length, 1, 'Must have one changed file')
    assert.strictEqual(claudeInvocationCount, 1, 'Claude must have been invoked once')

    // 验证产生 dirty worktree
    const statusAfterFirst = await gitRunner('git status --porcelain')
    assert.ok(statusAfterFirst.stdout.trim().length > 0, 'Must have dirty worktree after first execution')

    // 第二次执行 (same executor, same task)：允许 dirty worktree
    const report2 = await executor.execute({ task, packet })
    assert.strictEqual(report2.blockers.length, 0, 'Second execution (revise) must succeed')
    assert.strictEqual(claudeInvocationCount, 2, 'Claude must have been invoked twice')

    // 验证 activeTaskId 的作用：同一个 executor 可以继续
    // 没有 "pre-existing dirty blocker"
    assert.ok(
      !report2.blockers.some(b => b.includes('pre-existing')),
      'Must not have pre-existing dirty blocker for same executor revise'
    )
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ TEST 2: New Executor + No Checkpoint ============

await test('W003 Invariant 2: NEW executor + restored sessionId + NO checkpoint must fail closed', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-invariant2-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // executor1 执行产生 dirty worktree
    let claudeInvocationCount = 0
    const executor1 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          await writeFile(join(repoPath, 'test-dirty.txt'), 'execution 1')
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Execution 1 done',
              session_id: 'claude-session',
            }),
            stderr: '',
          }
        }
        // Git 命令
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    const task: GuardianTask = {
      id: 'T1',
      goal: 'Test task',
      iteration: 1,
      state: 'READY',
      maxIterations: 3,
    }

    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'Test task',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    const report1 = await executor1.execute({ task, packet })
    assert.strictEqual(report1.blockers.length, 0, 'Executor 1 must succeed')
    assert.strictEqual(claudeInvocationCount, 1, 'Claude must have been invoked once by executor 1')

    // 捕获 provider state
    const providerState = executor1.captureProviderState()
    assert.strictEqual(providerState.claudeSessionId, 'claude-session', 'Must capture sessionId')
    // activeTaskId 不应该在 ProviderSessionState 中
    assert.strictEqual(
      'activeTaskId' in providerState,
      false,
      'activeTaskId must NOT be in ProviderSessionState'
    )

    // executor1 销毁（模拟 process exit）
    // executor2 = NEW Executor
    claudeInvocationCount = 0  // 重置计数器
    const executor2 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Should not execute',
            }),
            stderr: '',
          }
        }
        // Git 命令
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    // 恢复 provider state（sessionId only）
    executor2.restoreProviderState(providerState)

    // 没有 setRecoveryCheckpoint
    // 执行必须 fail closed
    const report2 = await executor2.execute({ task, packet })

    // 关键断言：必须 FAIL
    assert.ok(report2.blockers.length >= 1, 'Must have at least one blocker')
    const preExistingBlocker = report2.blockers.find(b => b.includes('pre-existing'))
    assert.ok(
      preExistingBlocker !== undefined,
      `Must have pre-existing dirty worktree blocker, got blockers: ${report2.blockers.join(', ')}`
    )
    assert.strictEqual(claudeInvocationCount, 0, 'Claude invocation must be 0 (blocked before Claude)')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ TEST 3: New Executor + Valid Checkpoint ============

await test('W003 Invariant 3: NEW executor + valid checkpoint must verify then continue', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-invariant3-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // executor1 执行产生 dirty worktree
    let claudeInvocationCount = 0
    const executor1 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          await writeFile(join(repoPath, 'test-dirty.txt'), 'execution 1')
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Execution 1 done',
              session_id: 'claude-session',
            }),
            stderr: '',
          }
        }
        // Git 命令
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    const task: GuardianTask = {
      id: 'T1',
      goal: 'Test task',
      iteration: 1,
      state: 'READY',
      maxIterations: 3,
    }

    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'Test task',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    const report1 = await executor1.execute({ task, packet })
    assert.strictEqual(report1.blockers.length, 0, 'Executor 1 must succeed')
    assert.strictEqual(claudeInvocationCount, 1, 'Claude invoked once by executor 1')

    // 捕获 checkpoint（外层责任）
    const checkpoint = await captureRepositoryCheckpoint(repoPath, gitRunner)
    assert.ok(checkpoint.worktreeFingerprint.length === 64, 'Must have valid fingerprint')

    // 捕获 provider state
    const providerState = executor1.captureProviderState()

    // executor2 = NEW Executor
    claudeInvocationCount = 0
    let usedResumeFlag = false
    let capturedPrompt = ''
    let capturedMaxTurns = ''
    const executor2 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          // 检查是否使用了 --resume（可能在任何 arg 中）
          if (req.args.some(arg => arg === '--resume')) {
            usedResumeFlag = true
            const resumeIdx = req.args.indexOf('--resume')
            const sessionArg = req.args[resumeIdx + 1]
            assert.strictEqual(sessionArg, 'claude-session', 'Must use correct session ID')
          }
          // 捕获 prompt（-p 参数后的值）
          const promptIdx = req.args.indexOf('-p')
          if (promptIdx >= 0) {
            capturedPrompt = req.args[promptIdx + 1] ?? ''
          }
          // 捕获 --max-turns
          const maxTurnsIdx = req.args.indexOf('--max-turns')
          if (maxTurnsIdx >= 0) {
            capturedMaxTurns = req.args[maxTurnsIdx + 1] ?? ''
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Recovery execution done',
              session_id: 'claude-session',
            }),
            stderr: '',
          }
        }
        // Git 命令
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    // 恢复 provider state
    executor2.restoreProviderState(providerState)

    // 设置 recovery checkpoint（外层调用）
    executor2.setRecoveryCheckpoint(checkpoint)

    // 执行必须成功
    const report2 = await executor2.execute({ task, packet })

    assert.strictEqual(report2.blockers.length, 0, 'Must succeed with valid checkpoint')
    assert.strictEqual(claudeInvocationCount, 1, 'Claude must have been invoked once')
    // Exact Resume：必须使用 --resume
    assert.strictEqual(usedResumeFlag, true, 'Must use --resume with sessionId')
    // Exact Resume：prompt 是 continuation prompt（不是 max_turn recovery prompt）
    assert.ok(capturedPrompt.includes('继续当前任务'), 'Exact Resume must use continuation prompt')
    assert.ok(
      capturedPrompt.includes('保留当前工作区修改'),
      'Continuation prompt must mention keeping workspace changes'
    )
    // Exact Resume：maxTurns 是普通 task budget，不是自动变成 6 turns
    assert.strictEqual(capturedMaxTurns, '2', 'Exact Resume must keep normal maxTurns, not 6')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ TEST 4: NEW Executor + Valid Checkpoint + NO sessionId ============

await test('W003 Invariant 4: NEW executor + valid checkpoint + NO sessionId uses continuation prompt without resume', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-invariant4-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // executor1 执行产生 dirty worktree，但不产生 sessionId
    let claudeInvocationCount = 0
    const executor1 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          await writeFile(join(repoPath, 'test-dirty.txt'), 'execution 1')
          // 故意不返回 session_id：模拟 NO sessionId 场景（Recovery Resume）
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Execution 1 done',
            }),
            stderr: '',
          }
        }
        // Git 命令
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    const task: GuardianTask = {
      id: 'T1',
      goal: 'Test task',
      iteration: 1,
      state: 'READY',
      maxIterations: 3,
    }

    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'Test task',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    const report1 = await executor1.execute({ task, packet })
    assert.strictEqual(report1.blockers.length, 0, 'Executor 1 must succeed')

    // 捕获 checkpoint
    const checkpoint = await captureRepositoryCheckpoint(repoPath, gitRunner)
    assert.ok(checkpoint.worktreeFingerprint.length === 64, 'Must have valid fingerprint')

    // provider state 不应有 sessionId
    const providerState = executor1.captureProviderState()
    assert.strictEqual(providerState.claudeSessionId, undefined, 'Must NOT have sessionId')

    // executor2 = NEW Executor
    claudeInvocationCount = 0
    let usedResumeFlag = false
    let capturedPrompt = ''
    const executor2 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        // Claude 命令
        if (req.executable === 'bash' && req.args.length > 1 && req.args[1]?.includes('claude')) {
          claudeInvocationCount++
          if (req.args.some(arg => arg === '--resume')) {
            usedResumeFlag = true
          }
          // 捕获 prompt
          const promptIdx = req.args.indexOf('-p')
          if (promptIdx >= 0) {
            capturedPrompt = req.args[promptIdx + 1] ?? ''
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              type: 'success',
              result: 'Recovery execution done',
              session_id: 'claude-session',
            }),
            stderr: '',
          }
        }
        // Git 命令
        if (req.executable === 'bash' && req.args[0] === '-lc' && req.args[1] !== undefined) {
          return gitRunner(req.args[1])
        }
        // 其他命令
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: 'Unexpected command',
        }
      },
    })

    // 恢复 provider state（无 sessionId）
    executor2.restoreProviderState(providerState)

    // 设置 recovery checkpoint（外层调用）
    executor2.setRecoveryCheckpoint(checkpoint)

    const report2 = await executor2.execute({ task, packet })

    // Recovery Resume：验证通过后执行
    assert.strictEqual(report2.blockers.length, 0, 'Must succeed with valid checkpoint')
    assert.strictEqual(claudeInvocationCount, 1, 'Claude must have been invoked once')
    // Recovery Resume：无 sessionId → 不带 --resume
    assert.strictEqual(usedResumeFlag, false, 'Must NOT use --resume (no sessionId)')
    // Recovery Resume：prompt 仍是 continuation/recovery prompt
    assert.ok(capturedPrompt.includes('继续当前任务'), 'Recovery Resume must use continuation prompt')
    assert.ok(
      capturedPrompt.includes('保留当前工作区修改'),
      'Continuation prompt must mention keeping workspace changes'
    )
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})








