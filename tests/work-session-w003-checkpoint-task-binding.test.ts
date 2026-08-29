/**
 * W003 REMOTE REVIEW CLOSURE: checkpoint task 绑定与 fail-closed 验证
 *
 * 回归 1：captureProviderSessionState 必须显式绑定当前 taskId。
 * 同一 Brain 持有 T1 → URL-1、T2 → URL-2 时，T2 HUMAN_REQUIRED 捕获的
 * checkpoint.provider.chatgptConversationUrl 必须是 URL-2，不能是 first key。
 * 恢复 T2 时 AskBridge 必须使用 --session-url URL-2。
 *
 * 回归 2：repo verification 能力缺失（repoPath/gitRunner 未配置）时，
 * checkpoint 恢复必须 fail closed：不 restoreProviderState、不启动
 * Brain/Executor、provider invocation = 0，reason 明确 checkpoint verification unavailable。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AskBridgeBrain,
  type AskBridgeCommandRequest,
  type AskBridgeCommandRunner,
  type DelegationPacket,
  type ExecutionReport,
} from 'nova-wing/development-guardian'
import type { GuardianTaskRecoveryCheckpoint } from '../packages/development-guardian/work-session/index.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import { guardianShellTestCommand } from './guardian-shell-fixture.js'

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

  return { repoPath, gitRunner }
}

// ============ AskBridge Fixture ============

interface AskBridgeFixtureHandler {
  packet: string
  threadLink?: string
}

function createAskBridgeFixture(
  handlers: readonly AskBridgeFixtureHandler[],
): { runner: AskBridgeCommandRunner; requests: AskBridgeCommandRequest[] } {
  const requests: AskBridgeCommandRequest[] = []
  let call = 0
  const runner: AskBridgeCommandRunner = async (req) => {
    requests.push(req)
    const outputIndex = req.args.indexOf('--output')
    const outputPath = outputIndex >= 0 ? req.args[outputIndex + 1] : undefined
    assert.ok(outputPath, 'must have --output')
    const handler = handlers[call]
    call += 1
    assert.ok(handler !== undefined, `unexpected ask-bridge call #${call}`)
    await writeFile(outputPath, handler.packet, 'utf8')
    const stdout =
      handler.threadLink !== undefined
        ? `${handler.packet}\nThread Link: ${handler.threadLink}`
        : handler.packet
    return { exitCode: 0, stdout, stderr: '' }
  }
  return { runner, requests }
}

function blockedPacket(goal: string): string {
  return JSON.stringify({
    verdict: 'blocked',
    goal,
    instructions: [],
    constraints: [],
    verification: [],
    do_not_do: [],
    rationale: '需要人工确认',
  })
}

function revisePacket(goal: string): string {
  return JSON.stringify({
    verdict: 'revise',
    goal,
    instructions: ['继续实现 T2'],
    constraints: [],
    verification: ['git diff --check'],
    do_not_do: [],
    rationale: '恢复执行',
  })
}

function donePacket(goal: string): string {
  return JSON.stringify({
    verdict: 'done',
    goal,
    instructions: [],
    constraints: [],
    verification: ['git diff --check'],
    do_not_do: [],
    rationale: '验收条件满足',
  })
}

// ============ Test 1: checkpoint 精确绑定当前 taskId ============

await test('W003 CLOSURE: T2 checkpoint captures URL-2 and resume uses URL-2 (no first-key)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-task-binding-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    const T1_URL = 'https://chatgpt.com/c/t1-conversation'
    const T2_URL = 'https://chatgpt.com/c/t2-conversation'

    // ================= STEP 1: T2 HUMAN_REQUIRED 捕获 checkpoint =================
    const askBridge1 = createAskBridgeFixture([{ packet: blockedPacket('T2 的任务') }])
    const brain1 = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      headless: false,
      timeoutMs: 60_000,
      commandRunner: askBridge1.runner,
    })
    // 预置同一 Brain 持有两个任务的 conversation URL（T1 在 T2 之前注册）
    brain1.restoreProviderState({
      taskConversationUrls: { T1: T1_URL, T2: T2_URL },
      reviewedTaskIds: ['T1', 'T2'],
    })

    const fakeExecutor = {
      execute: async (): Promise<ExecutionReport> => ({
        summary: 'noop',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [{ name: 'git diff --check', status: 'passed' }],
        blockers: [],
      }),
      captureProviderState: () => ({}),
    }

    const runner1 = new GuardianWorkSessionTaskRunner({
      brain: brain1,
      createExecutor: () => fakeExecutor,
      repoPath,
      gitRunner,
    })

    const result1 = await runner1.run({ id: 'T2', goal: 'T2 的任务' })

    assert.strictEqual(result1.status, 'HUMAN_REQUIRED', 'blocked review must suspend')
    assert.ok(result1.checkpoint !== undefined, 'checkpoint must be captured')
    const checkpoint1 = result1.checkpoint as GuardianTaskRecoveryCheckpoint

    // 修复验证：T2 的 checkpoint 必须携带 URL-2，不能是 first key（URL-1）
    assert.strictEqual(
      checkpoint1.provider.chatgptConversationUrl,
      T2_URL,
      'T2 checkpoint must capture T2 conversation URL, not the first key',
    )

    // T2 首轮 review 已经使用 --session-url URL-2
    const reviewArgs1 = askBridge1.requests[0]?.args ?? []
    const sessionIdx1 = reviewArgs1.indexOf('--session-url')
    assert.ok(sessionIdx1 >= 0, 'T2 review must use --session-url')
    assert.strictEqual(reviewArgs1[sessionIdx1 + 1], T2_URL, 'T2 review must use URL-2')

    // ================= STEP 2: 恢复 T2 → AskBridge 必须使用 URL-2 =================
    const askBridge2 = createAskBridgeFixture([
      { packet: revisePacket('T2 的任务') },
      { packet: donePacket('T2 的任务') },
    ])
    const brain2 = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      headless: false,
      timeoutMs: 60_000,
      commandRunner: askBridge2.runner,
    })

    const runner2 = new GuardianWorkSessionTaskRunner({
      brain: brain2,
      createExecutor: () => fakeExecutor,
      repoPath,
      gitRunner,
    })

    const result2 = await runner2.run({ id: 'T2', goal: 'T2 的任务' }, undefined, checkpoint1)

    assert.strictEqual(result2.status, 'COMPLETED', 'T2 resume must complete')
    assert.strictEqual(askBridge2.requests.length, 2, 'T2 resume: revise -> done')

    for (const request of askBridge2.requests) {
      const args = request.args ?? []
      assert.strictEqual(args.includes('--new'), false, 'resume must not create a new conversation')
      const sessionIdx = args.indexOf('--session-url')
      assert.ok(sessionIdx >= 0, 'resume must continue T2 conversation via --session-url')
      assert.strictEqual(args[sessionIdx + 1], T2_URL, 'resume must use URL-2, not URL-1')
    }
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Test 2: repo verification unavailable → fail closed ============

await test('W003 CLOSURE: checkpoint without repo verification capability fails closed', async () => {
  const checkpoint: GuardianTaskRecoveryCheckpoint = {
    version: 1,
    task: {
      id: 'T-failclosed',
      goal: 'fail closed test',
      state: 'HUMAN_REQUIRED',
      iteration: 1,
      maxIterations: 10,
    },
    provider: {
      chatgptConversationUrl: 'https://chatgpt.com/c/must-not-restore',
      chatgptConversationStale: true,
    },
    repo: {
      repoPath: '/does/not/matter',
      branch: 'main',
      headSha: 'a'.repeat(40),
      changedFiles: [],
      worktreeFingerprint: 'b'.repeat(64),
    },
    capturedAt: new Date().toISOString(),
  }

  let reviewCalls = 0
  let executeCalls = 0
  let restoreCalls = 0

  const brain = {
    review: async (): Promise<DelegationPacket> => {
      reviewCalls += 1
      return {
        verdict: 'blocked',
        goal: 'fail closed test',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
      }
    },
    captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
    restoreProviderState: () => {
      restoreCalls += 1
    },
  }
  const executor = {
    execute: async (): Promise<ExecutionReport> => {
      executeCalls += 1
      return {
        summary: 'should not run',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [],
        blockers: [],
      }
    },
    captureProviderState: () => ({}),
  }

  // 不传 repoPath/gitRunner → repo verification capability 缺失
  const runner = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
  })

  const result = await runner.run({ id: 'T-failclosed', goal: 'fail closed test' }, undefined, checkpoint)

  assert.strictEqual(result.status, 'HUMAN_REQUIRED', 'must require human when verification unavailable')
  assert.strictEqual(result.humanRequired?.category, 'REPO_DRIFT', 'unverifiable checkpoint fails closed as REPO_DRIFT')
  assert.ok(
    (result.humanRequired?.reason ?? '').includes('checkpoint verification unavailable'),
    'reason must state checkpoint verification unavailable',
  )

  // fail closed：不得自动信任 checkpoint，不做任何 provider execution
  assert.strictEqual(reviewCalls, 0, 'Brain review must NOT be invoked')
  assert.strictEqual(executeCalls, 0, 'Executor execute must NOT be invoked')
  assert.strictEqual(restoreCalls, 0, 'restoreProviderState must NOT be invoked')
})

// ============ Test 2b: identity gate 仍先于 verification gate ============

await test('W003 CLOSURE: checkpoint task mismatch still fails closed before verification gate', async () => {
  const checkpoint: GuardianTaskRecoveryCheckpoint = {
    version: 1,
    task: {
      id: 'T-other',
      goal: 'other task',
      state: 'HUMAN_REQUIRED',
      iteration: 1,
      maxIterations: 10,
    },
    provider: {},
    repo: {
      repoPath: '/does/not/matter',
      branch: 'main',
      headSha: 'a'.repeat(40),
      changedFiles: [],
      worktreeFingerprint: 'b'.repeat(64),
    },
    capturedAt: new Date().toISOString(),
  }

  let reviewCalls = 0
  let executeCalls = 0

  const brain = {
    review: async (): Promise<DelegationPacket> => {
      reviewCalls += 1
      return {
        verdict: 'blocked',
        goal: 'other task',
        instructions: [],
        constraints: [],
        verification: [],
        doNotDo: [],
      }
    },
    captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
  }
  const executor = {
    execute: async (): Promise<ExecutionReport> => {
      executeCalls += 1
      return {
        summary: 'should not run',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [],
        blockers: [],
      }
    },
    captureProviderState: () => ({}),
  }

  const runner = new GuardianWorkSessionTaskRunner({
    brain,
    createExecutor: () => executor,
  })

  const result = await runner.run({ id: 'T-current', goal: 'current task' }, undefined, checkpoint)

  assert.strictEqual(result.status, 'HUMAN_REQUIRED')
  assert.ok(
    (result.humanRequired?.reason ?? '').includes('does not match work session task'),
    'identity mismatch must be reported',
  )
  assert.strictEqual(reviewCalls, 0)
  assert.strictEqual(executeCalls, 0)
})
