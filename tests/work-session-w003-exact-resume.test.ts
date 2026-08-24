/**
 * W003 Integration Test: Exact Resume
 * 验证 provider session 持续性和 checkpoint 恢复
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  GuardianBrain,
  GuardianExecutor,
  GuardianTask,
  DelegationPacket,
  ExecutionReport,
} from '../packages/development-guardian/index.js'
import {
  WorkSessionRuntime,
  type WorkSessionDefinition,
  type GuardianTaskRecoveryCheckpoint,
} from '../packages/development-guardian/work-session/index.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import { guardianShellTestCommand } from './guardian-shell-fixture.js'

// ============ Test Doubles ============

interface TestBrainState {
  conversationUrl?: string
  reviewCount: number
  isResumed: boolean
}

class TestBrain implements GuardianBrain {
  state: TestBrainState = { reviewCount: 0, isResumed: false }

  captureProviderState(): { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] } {
    return {
      taskConversationUrls: this.state.conversationUrl !== undefined ? { 'T1': this.state.conversationUrl } : {},
      reviewedTaskIds: this.state.conversationUrl !== undefined ? ['T1'] : [],
    }
  }

  restoreProviderState(state: { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] }): void {
    const url = state.taskConversationUrls['T1']
    if (url !== undefined) {
      this.state.conversationUrl = url
      this.state.isResumed = true
    }
  }

  async review(_input: { task: GuardianTask; report: ExecutionReport }): Promise<DelegationPacket> {
    this.state.reviewCount++

    // PROCESS 2 逻辑（从 checkpoint 恢复）
    if (this.state.isResumed) {
      if (this.state.reviewCount === 1) {
        return {
          verdict: 'revise',
          goal: 'Test task continued',
          instructions: ['Continue from checkpoint'],
          constraints: [],
          verification: ['git diff --check'],
          doNotDo: [],
        }
      }
      if (this.state.reviewCount === 2) {
        return {
          verdict: 'done',
          goal: 'Test task continued',
          instructions: [],
          constraints: [],
          verification: ['git diff --check'],
          doNotDo: [],
        }
      }
    }

    // PROCESS 1 逻辑（初次执行）
    // 第一次 review：设置 conversation URL，返回 revise 触发 Executor 执行
    if (this.state.reviewCount === 1) {
      this.state.conversationUrl = 'https://chatgpt.com/c/test-exact-resume'
      return {
        verdict: 'revise',
        goal: 'Test task - first execution',
        instructions: ['Create test file'],
        constraints: [],
        verification: ['git diff --check'],
        doNotDo: [],
      }
    }

    // 第二次 review（Executor 执行后）：返回 blocked 触发 HUMAN_REQUIRED
    if (this.state.reviewCount === 2) {
      return {
        verdict: 'blocked',
        goal: 'Test task',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
      }
    }

    throw new Error(`Unexpected review count: ${this.state.reviewCount}`)
  }
}

interface TestExecutorState {
  sessionId?: string
  executeCount: number
  cleanStartCheckCount: number
  allowedCheckpoint?: {
    taskId: string
    branch: string
    headSha: string
    worktreeFingerprint: string
  }
}

class TestExecutor implements GuardianExecutor {
  state: TestExecutorState = { executeCount: 0, cleanStartCheckCount: 0 }
  options: {
    allowedWorktreeCheckpoint?: {
      taskId: string
      branch: string
      headSha: string
      worktreeFingerprint: string
    }
  } = {}
  private gitRunner: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>

  constructor(
    gitRunner: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
    private readonly repoPath: string,
  ) {
    this.gitRunner = gitRunner
  }

  captureProviderState(): { claudeSessionId?: string } {
    return {
      ...(this.state.sessionId !== undefined ? { claudeSessionId: this.state.sessionId } : {}),
    }
  }

  restoreProviderState(state: { claudeSessionId?: string }): void {
    if (state.claudeSessionId !== undefined) {
      this.state.sessionId = state.claudeSessionId
      // 恢复 executeCount，防止重复执行第一次逻辑
      this.state.executeCount = 1
    }
  }

  setRecoveryCheckpoint(checkpoint: { repoPath: string; branch: string; headSha: string; worktreeFingerprint: string; changedFiles: readonly string[] }): void {
    this.options.allowedWorktreeCheckpoint = {
      taskId: 'T1',
      branch: checkpoint.branch,
      headSha: checkpoint.headSha,
      worktreeFingerprint: checkpoint.worktreeFingerprint,
    }
  }

  async execute(_input: { task: GuardianTask; packet: DelegationPacket }): Promise<ExecutionReport> {
    this.state.executeCount++

    // 验证 clean start（如果有 allowedCheckpoint，应该通过验证）
    this.state.cleanStartCheckCount++
    const statusResult = await this.gitRunner('git status --porcelain')
    const hasDirty = statusResult.stdout.trim().length > 0

    const allowedCheckpoint = this.options.allowedWorktreeCheckpoint

    if (hasDirty && allowedCheckpoint === undefined) {
      return {
        summary: 'Blocked: dirty worktree without checkpoint',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [],
        blockers: ['dirty worktree requires checkpoint validation'],
      }
    }

    if (hasDirty && allowedCheckpoint !== undefined) {
      // 验证 checkpoint
      const branchResult = await this.gitRunner('git branch --show-current')
      const headResult = await this.gitRunner('git rev-parse HEAD')
      const fullStatusResult = await this.gitRunner('git status --porcelain --untracked-files=all')

      const { parseGitStatus, computeWorktreeFingerprint } = await import(
        '../packages/development-guardian/work-session/worktree-fingerprint.js'
      )
      const entries = parseGitStatus(fullStatusResult.stdout)
      const fingerprint = await computeWorktreeFingerprint(this.repoPath, entries)

      if (
        branchResult.stdout.trim() !== allowedCheckpoint.branch ||
        headResult.stdout.trim() !== allowedCheckpoint.headSha ||
        fingerprint !== allowedCheckpoint.worktreeFingerprint
      ) {
        return {
          summary: 'Blocked: checkpoint validation failed',
          changedFiles: [],
          commandsRun: [],
          verificationResults: [],
          blockers: ['REPO_DRIFT: worktree does not match checkpoint'],
        }
      }
    }

    // PROCESS 1 第一次执行：executeCount 从 0 → 1
    if (this.state.executeCount === 1) {
      this.state.sessionId = 'claude-exact-resume-session'

      // 创建 dirty file
      await writeFile(join(await this.gitRunner('git rev-parse --show-toplevel').then(r => r.stdout.trim()), 'test-dirty.txt'), 'first execution')

      return {
        summary: 'First execution completed, needs Brain review',
        changedFiles: ['test-dirty.txt'],
        commandsRun: ['claude -p ...'],
        verificationResults: [{ name: 'git diff --check', status: 'passed' }],
        blockers: [],
      }
    }

    // PROCESS 2 resume 后的执行：executeCount 从 1 → 2
    assert.strictEqual(this.state.sessionId, 'claude-exact-resume-session', 'session ID must be preserved')

    return {
      summary: 'Task completed after resume',
      changedFiles: ['test-dirty.txt'],
      commandsRun: ['claude -p ... --resume claude-exact-resume-session'],
      verificationResults: [{ name: 'git diff --check', status: 'passed' }],
      blockers: [],
    }
  }
}

// ============ Git Test Helper ============

async function setupTestGitRepo(baseDir: string): Promise<{
  repoPath: string
  gitRunner: (cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}> {
  const repoPath = join(baseDir, 'test-repo')
  await mkdir(repoPath, { recursive: true })

  const gitRunner = async (cmd: string) => {
    const { spawn } = await import('node:child_process')
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const shell = guardianShellTestCommand(cmd)
      const child = spawn(shell.executable, shell.args, {
        cwd: repoPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('exit', (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr })
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

// ============ Test Case ============

await test('W003 Exact Resume: provider sessions preserved across process restart', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-exact-resume-'))
  const storageUrl = `file:${join(tempBase, 'test.db')}`

  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // ========== PROCESS 1: Initial run until HUMAN_REQUIRED ==========
    const brain1 = new TestBrain()
    const executor1 = new TestExecutor(gitRunner, repoPath)

    const definition: WorkSessionDefinition = {
      id: 'exact-resume-session',
      targetRepo: repoPath,
      branch: 'main',
      tasks: [
        { id: 'T1', goal: 'Test exact resume' },
      ],
      limits: {
        softMinutes: 10,
        hardMinutes: 20,
        maxTasks: 1,
      },
    }

    const taskRunner1 = new GuardianWorkSessionTaskRunner({
      brain: brain1,
      createExecutor: () => executor1,
      repoPath,
      gitRunner,
    })

    const runtime1 = new WorkSessionRuntime({
      definition,
      taskRunner: taskRunner1,
      storageUrl,
    })

    const state1 = await runtime1.start()

    // 验证 PROCESS 1 结果
    assert.strictEqual(state1.state, 'SUSPENDED', 'Process 1 must suspend')
    assert.strictEqual(state1.humanRequired?.category, 'DECISION_REQUIRED', 'Must require human decision')
    assert.ok(state1.currentTaskCheckpoint !== undefined, 'Checkpoint must be captured')

    const checkpoint1 = state1.currentTaskCheckpoint as GuardianTaskRecoveryCheckpoint
    assert.strictEqual(checkpoint1.version, 1, 'Checkpoint version must be 1')
    assert.strictEqual(checkpoint1.provider.chatgptConversationUrl, 'https://chatgpt.com/c/test-exact-resume', 'ChatGPT URL must be captured')
    assert.strictEqual(checkpoint1.provider.claudeSessionId, 'claude-exact-resume-session', 'Claude session ID must be captured')
    assert.ok(checkpoint1.repo.branch.length > 0, 'Branch must be captured')
    assert.ok(checkpoint1.repo.headSha.length === 40, 'HEAD SHA must be captured')
    assert.ok(checkpoint1.repo.worktreeFingerprint.length === 64, 'Worktree fingerprint must be captured')
    assert.strictEqual(checkpoint1.repo.changedFiles.length, 1, 'Must have one changed file')
    assert.strictEqual(checkpoint1.repo.changedFiles[0], 'test-dirty.txt', 'Changed file must be test-dirty.txt')

    assert.strictEqual(brain1.state.reviewCount, 2, 'Brain must have reviewed twice in Process 1 (revise -> blocked)')
    assert.strictEqual(executor1.state.executeCount, 1, 'Executor must have executed once in Process 1')

    await runtime1.close()

    // ========== PROCESS 2: Resume with new instances ==========
    const brain2 = new TestBrain()
    const executor2 = new TestExecutor(gitRunner, repoPath)

    // 验证 Process 2 初始状态为空
    assert.strictEqual(brain2.state.conversationUrl, undefined, 'Brain 2 should start with no conversation URL')
    assert.strictEqual(executor2.state.sessionId, undefined, 'Executor 2 should start with no session ID')

    const taskRunner2 = new GuardianWorkSessionTaskRunner({
      brain: brain2,
      createExecutor: () => executor2,
      repoPath,
      gitRunner,
    })

    const runtime2 = new WorkSessionRuntime({
      definition,
      taskRunner: taskRunner2,
      storageUrl,
    })

    const state2 = await runtime2.resume({ approval: true })

    // 验证 PROCESS 2 结果
    assert.strictEqual(state2.state, 'COMPLETED', 'Process 2 must complete')
    assert.strictEqual(state2.completedTaskIds.length, 1, 'Must have completed one task')
    assert.strictEqual(state2.completedTaskIds[0], 'T1', 'Must have completed T1')
    assert.strictEqual(state2.currentTaskCheckpoint, undefined, 'Checkpoint must be cleared after completion')

    // 验证 provider state 恢复
    assert.strictEqual(brain2.state.conversationUrl, 'https://chatgpt.com/c/test-exact-resume', 'Brain must have restored ChatGPT URL')
    assert.strictEqual(brain2.state.reviewCount, 2, 'Brain must have reviewed twice after resume (revise -> execute -> done)')

    assert.strictEqual(executor2.state.sessionId, 'claude-exact-resume-session', 'Executor must have restored Claude session ID')
    assert.strictEqual(executor2.state.executeCount, 2, 'Executor must have executed twice total (1 in P1, 1 in P2)')
    assert.strictEqual(executor2.state.cleanStartCheckCount, 1, 'Clean start check must run once and pass with checkpoint')

    await runtime2.close()
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
