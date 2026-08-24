import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  type DelegationPacket,
  type ExecutionReport,
  type GuardianBrain,
  type GuardianCommandRequest,
  type GuardianTask,
} from 'nova-wing/development-guardian'
import { guardianShellTestCommand, isClaudeShellRequest, isGuardianShellRequest } from './guardian-shell-fixture.js'
import type {
  GuardianTaskRecoveryCheckpoint,
  ProviderSessionState,
  RepositoryCheckpoint,
} from '../packages/development-guardian/work-session/checkpoint.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import {
  computeWorktreeFingerprint,
  parseGitStatus,
} from '../packages/development-guardian/work-session/worktree-fingerprint.js'

type GitRunResult = {
  exitCode: number
  stdout: string
  stderr: string
  signal: NodeJS.Signals | null
}

type GitRunner = (command: string) => Promise<GitRunResult>

async function setupRepository(): Promise<{
  tempDir: string
  repoPath: string
  gitRunner: GitRunner
}> {
  const tempDir = await mkdtemp(join(tmpdir(), 'canary-finding-9-'))
  const repoPath = join(tempDir, 'repo')
  await mkdir(join(repoPath, 'src'), { recursive: true })

  const gitRunner: GitRunner = async (command) =>
    new Promise((resolve) => {
      const shell = guardianShellTestCommand(command)
      const child = spawn(shell.executable, shell.args, {
        cwd: repoPath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
      child.once('exit', (exitCode, signal) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr, signal })
      })
    })

  await gitRunner('git init')
  await gitRunner('git config user.email "finding-9@example.com"')
  await gitRunner('git config user.name "Finding Nine"')
  await writeFile(join(repoPath, 'src/feature.ts'), 'export const value = 1\n')
  await gitRunner('git add src/feature.ts')
  await gitRunner('git commit -m "initial"')
  await writeFile(join(repoPath, 'src/feature.ts'), 'export const value = 2 // preserved checkpoint work\n')

  return { tempDir, repoPath, gitRunner }
}

async function captureRepositoryCheckpoint(
  repoPath: string,
  gitRunner: GitRunner,
): Promise<RepositoryCheckpoint> {
  const branch = await gitRunner('git branch --show-current')
  const head = await gitRunner('git rev-parse HEAD')
  const status = await gitRunner('git status --porcelain --untracked-files=all')
  const entries = parseGitStatus(status.stdout)
  return {
    repoPath,
    branch: branch.stdout.trim(),
    headSha: head.stdout.trim(),
    changedFiles: entries.map((entry) => entry.path),
    worktreeFingerprint: await computeWorktreeFingerprint(repoPath, entries),
  }
}

function recoveryTask(
  stopReason: string,
  reportOverrides: Partial<ExecutionReport> = {},
): GuardianTask {
  return {
    id: 'T1',
    goal: 'continue the partially implemented task',
    state: 'HUMAN_REQUIRED',
    iteration: 1,
    maxIterations: 10,
    stopReason,
    lastPacket: {
      verdict: 'revise',
      goal: 'continue the partially implemented task',
      instructions: ['preserve existing work and continue'],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: ['do not restart the task'],
    },
    lastReport: {
      summary: 'partial implementation is preserved in the dirty worktree',
      changedFiles: ['src/feature.ts'],
      commandsRun: ['claude'],
      verificationResults: [{ name: 'git diff --check', status: 'passed' }],
      blockers: [],
      ...reportOverrides,
    },
  }
}

function checkpoint(
  task: GuardianTask,
  repo: RepositoryCheckpoint,
  provider: ProviderSessionState,
): GuardianTaskRecoveryCheckpoint {
  return {
    version: 1,
    task,
    provider,
    repo,
    capturedAt: new Date().toISOString(),
  }
}

function revisePacket(): DelegationPacket {
  return {
    verdict: 'revise',
    goal: 'continue the partially implemented task',
    instructions: ['continue on top of the verified dirty worktree'],
    constraints: [],
    verification: ['git diff --check'],
    doNotDo: ['do not restart the task'],
  }
}

function terminalPacket(verdict: 'blocked' | 'done'): DelegationPacket {
  return {
    verdict,
    goal: 'continue the partially implemented task',
    instructions: [],
    constraints: [],
    verification: ['git diff --check'],
    doNotDo: [],
    ...(verdict === 'blocked' ? { rationale: 'a separate product decision is required' } : {}),
  }
}

class RecordingBrain implements GuardianBrain {
  conversationUrl: string | undefined
  restoreCalls = 0
  readonly reviewedTasks: GuardianTask[] = []

  constructor(private readonly packets: readonly DelegationPacket[]) {}

  captureProviderState(): { taskConversationUrls: Record<string, string>; reviewedTaskIds: string[] } {
    return {
      taskConversationUrls: this.conversationUrl === undefined ? {} : { T1: this.conversationUrl },
      reviewedTaskIds: this.conversationUrl === undefined ? [] : ['T1'],
    }
  }

  restoreProviderState(state: { taskConversationUrls: Record<string, string> }): void {
    this.restoreCalls += 1
    this.conversationUrl = state.taskConversationUrls.T1
  }

  async review(input: { task: GuardianTask }): Promise<DelegationPacket> {
    this.reviewedTasks.push(input.task)
    const packet = this.packets[this.reviewedTasks.length - 1]
    assert.ok(packet !== undefined, `unexpected Brain review #${this.reviewedTasks.length}`)
    return packet
  }
}

function createExecutorFixture(
  repoPath: string,
  gitRunner: GitRunner,
  newSessionId?: string,
): { executor: ClaudeCodeExecutor; claudeRequests: GuardianCommandRequest[] } {
  const claudeRequests: GuardianCommandRequest[] = []
  const executor = new ClaudeCodeExecutor({
    cwd: repoPath,
    maxTurns: 4,
    timeoutMs: 10_000,
    commandRunner: async (request) => {
      if (isClaudeShellRequest(request) && request.args[1] === 'exec claude "$@"') {
        claudeRequests.push(request)
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            type: 'success',
            result: 'continued existing task',
            ...(newSessionId === undefined ? {} : { session_id: newSessionId }),
          }),
          stderr: '',
        }
      }
      if (isGuardianShellRequest(request) && request.args[1] !== undefined) {
        return gitRunner(request.args[1])
      }
      return { exitCode: 1, signal: null, stdout: '', stderr: 'unexpected command' }
    },
  })
  return { executor, claudeRequests }
}

function claudeArguments(request: GuardianCommandRequest): readonly string[] {
  const separator = request.args.indexOf('--')
  assert.ok(separator >= 0, 'Claude command must include an argument separator')
  return request.args.slice(separator + 1)
}

test('Finding #9: ordinary, Brain-only, and non-credential recovery keep Executor Exact Resume', async () => {
  const { tempDir, repoPath, gitRunner } = await setupRepository()
  try {
    const repo = await captureRepositoryCheckpoint(repoPath, gitRunner)
    const cases = [
      'a product architecture decision is required',
      'ask-bridge authentication required',
      'checkout rejected because customer has insufficient balance',
      'verification requires approval for an additional command',
      'max iterations reached: 10',
      'REPO_DRIFT was resolved and the checkpoint now matches',
    ]

    for (const stopReason of cases) {
      const brain = new RecordingBrain([revisePacket(), terminalPacket('done')])
      const fixture = createExecutorFixture(repoPath, gitRunner)
      const runner = new GuardianWorkSessionTaskRunner({
        brain,
        createExecutor: () => fixture.executor,
        repoPath,
        gitRunner,
      })

      const result = await runner.run(
        { id: 'T1', goal: 'continue the partially implemented task' },
        undefined,
        checkpoint(recoveryTask(stopReason), repo, {
          chatgptConversationUrl: 'https://chatgpt.com/c/existing-reviewer',
          claudeSessionId: 'healthy-executor-session',
        }),
      )

      assert.equal(result.status, 'COMPLETED', stopReason)
      assert.equal(fixture.claudeRequests.length, 1, stopReason)
      const args = claudeArguments(fixture.claudeRequests[0]!)
      const resumeIndex = args.indexOf('--resume')
      assert.ok(resumeIndex >= 0, stopReason)
      assert.equal(args[resumeIndex + 1], 'healthy-executor-session', stopReason)
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Finding #9: Executor credential recovery keeps Reviewer and repository continuation but replaces stale Claude session', async () => {
  const { tempDir, repoPath, gitRunner } = await setupRepository()
  try {
    const repo = await captureRepositoryCheckpoint(repoPath, gitRunner)
    const brain = new RecordingBrain([revisePacket(), terminalPacket('blocked')])
    const fixture = createExecutorFixture(repoPath, gitRunner, 'new-provider-session')
    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => fixture.executor,
      repoPath,
      gitRunner,
    })

    const result = await runner.run(
      { id: 'T1', goal: 'continue the partially implemented task' },
      { approval: true },
      checkpoint(
        recoveryTask('Claude Code failed with 403 Insufficient account balance'),
        repo,
        {
          chatgptConversationUrl: 'https://chatgpt.com/c/existing-reviewer',
          claudeSessionId: 'stale-executor-session',
        },
      ),
    )

    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(brain.restoreCalls, 1)
    assert.equal(brain.conversationUrl, 'https://chatgpt.com/c/existing-reviewer')
    assert.equal(brain.reviewedTasks[0]?.recoveryContinuation, true)
    assert.deepEqual(brain.reviewedTasks[0]?.resumeInput, { approval: true })

    assert.equal(fixture.claudeRequests.length, 1)
    const args = claudeArguments(fixture.claudeRequests[0]!)
    assert.equal(args.includes('--resume'), false)
    assert.equal(args.includes('stale-executor-session'), false)
    const promptIndex = args.indexOf('-p')
    assert.ok(promptIndex >= 0)
    const prompt = args[promptIndex + 1] ?? ''
    assert.match(prompt, /继续当前任务/u)
    assert.match(prompt, /保留当前工作区修改/u)
    assert.match(prompt, /不要从头重新实现/u)

    assert.equal(result.checkpoint?.provider.chatgptConversationUrl, 'https://chatgpt.com/c/existing-reviewer')
    assert.equal(result.checkpoint?.provider.claudeSessionId, 'new-provider-session')
    assert.deepEqual(fixture.executor.captureProviderState(), {
      claudeSessionId: 'new-provider-session',
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Finding #9: Executor credential recovery without an old Claude session remains valid Recovery Resume', async () => {
  const { tempDir, repoPath, gitRunner } = await setupRepository()
  try {
    const repo = await captureRepositoryCheckpoint(repoPath, gitRunner)
    const brain = new RecordingBrain([revisePacket(), terminalPacket('done')])
    const fixture = createExecutorFixture(repoPath, gitRunner)
    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => fixture.executor,
      repoPath,
      gitRunner,
    })

    const result = await runner.run(
      { id: 'T1', goal: 'continue the partially implemented task' },
      undefined,
      checkpoint(
        recoveryTask('Executor Provider credentials required'),
        repo,
        { chatgptConversationUrl: 'https://chatgpt.com/c/existing-reviewer' },
      ),
    )

    assert.equal(result.status, 'COMPLETED')
    const args = claudeArguments(fixture.claudeRequests[0]!)
    assert.equal(args.includes('--resume'), false)
    const promptIndex = args.indexOf('-p')
    assert.match(args[promptIndex + 1] ?? '', /继续当前任务/u)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('Finding #9: repository drift fails closed before Brain or Executor provider restoration', async () => {
  const { tempDir, repoPath, gitRunner } = await setupRepository()
  try {
    const repo = await captureRepositoryCheckpoint(repoPath, gitRunner)
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const value = 3 // external drift\n')

    const brain = new RecordingBrain([revisePacket()])
    const fixture = createExecutorFixture(repoPath, gitRunner)
    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => fixture.executor,
      repoPath,
      gitRunner,
    })

    const result = await runner.run(
      { id: 'T1', goal: 'continue the partially implemented task' },
      undefined,
      checkpoint(
        recoveryTask('Claude Code failed with 403 Insufficient account balance'),
        repo,
        {
          chatgptConversationUrl: 'https://chatgpt.com/c/existing-reviewer',
          claudeSessionId: 'stale-executor-session',
        },
      ),
    )

    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
    assert.equal(brain.restoreCalls, 0)
    assert.equal(brain.reviewedTasks.length, 0)
    assert.equal(fixture.claudeRequests.length, 0)
    assert.deepEqual(fixture.executor.captureProviderState(), {})
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
