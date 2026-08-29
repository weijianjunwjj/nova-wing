/**
 * W003 Recovery Resume Without Provider Sessions
 *
 * 证明：即使旧 ChatGPT conversation URL 和 Claude session ID 都丢失，
 * 只要 durable WorkSession state + GuardianTaskRecoveryCheckpoint + RepositoryCheckpoint
 * 完整且 branch/HEAD/fingerprint 验证通过，NovaWing 仍能：
 * - 创建 NEW ChatGPT conversation（--new，无 --session-url）
 * - 创建 NEW Claude session（无 --resume，task-continuation prompt，normal maxTurns）
 * - 继续当前 dirty worktree，而不是把任务当新任务从头做
 *
 * Provider continuity 是优化，不是 durability source of truth。
 *
 * 使用真实 temp git repo + 真实 adapter 层（AskBridgeBrain / ClaudeCodeExecutor /
 * GuardianWorkSessionTaskRunner / WorkSessionRuntime durable resume path），
 * 仅 fake 外部命令执行结果，但验证真实 adapter 生成的 arguments / prompts。
 *
 * 负例：dirty file 内容变化 → RepositoryCheckpoint mismatch → REPO_DRIFT fail-closed，
 * repo validation 早于任何 provider execution（Claude invocation = 0，AskBridge 也不被调用）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AskBridgeBrain,
  ClaudeCodeExecutor,
  type AskBridgeCommandRequest,
  type AskBridgeCommandRunner,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type GuardianTask,
  type DelegationPacket,
  type ExecutionReport,
} from 'nova-wing/development-guardian'
import {
  WorkSessionRuntime,
  type WorkSessionDefinition,
  type GuardianTaskRecoveryCheckpoint,
} from '../packages/development-guardian/work-session/index.js'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import {
  guardianShellPayload,
  guardianShellTestCommand,
  isClaudeShellRequest,
} from './guardian-shell-fixture.js'
import {
  parseGitStatus,
  computeWorktreeFingerprint,
} from '../packages/development-guardian/work-session/worktree-fingerprint.js'
import type { RepositoryCheckpoint } from '../packages/development-guardian/work-session/checkpoint.js'

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
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 1\n')
  await gitRunner('git add src/feature.ts')
  await gitRunner('git commit -m "add feature"')

  return { repoPath, gitRunner }
}

/** 记录所有 git 命令（用于断言无破坏性操作） */
function createRecordingGitRunner(
  gitRunner: (cmd: string) => Promise<GitRunResult>,
): { run: (cmd: string) => Promise<GitRunResult>; commands: string[] } {
  const commands: string[] = []
  const run = async (cmd: string) => {
    commands.push(cmd)
    return gitRunner(cmd)
  }
  return { run, commands }
}

async function captureCheckpoint(
  repoPath: string,
  gitRunner: (cmd: string) => Promise<GitRunResult>,
): Promise<RepositoryCheckpoint> {
  const branchResult = await gitRunner('git branch --show-current')
  const headResult = await gitRunner('git rev-parse HEAD')
  const statusResult = await gitRunner('git status --porcelain --untracked-files=all')
  const entries = parseGitStatus(statusResult.stdout)
  return {
    repoPath,
    branch: branchResult.stdout.trim(),
    headSha: headResult.stdout.trim(),
    changedFiles: entries.map((e) => e.path),
    worktreeFingerprint: await computeWorktreeFingerprint(repoPath, entries),
  }
}

// ============ 通用 git 命令 fixture（委托真实 git）============

function createGitDelegatingClaudeFixture(gitRunner: (cmd: string) => Promise<GitRunResult>) {
  const requests: GuardianCommandRequest[] = []
  const runner = async (req: GuardianCommandRequest): Promise<GuardianCommandResult> => {
    if (isClaudeShellRequest(req)) {
      requests.push(req)
      return { exitCode: 1, signal: null, stdout: '', stderr: 'unhandled claude call' }
    }
    const command = guardianShellPayload(req)
    if (command !== undefined) {
      return gitRunner(command)
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
  }
  return { runner, requests }
}

// ============ Task / Packet Fixtures ============

const p1RevisePacket = JSON.stringify({
  verdict: 'revise',
  goal: 'Recovery resume 实现 feature',
  instructions: ['继续实现 src/feature.ts 并补全测试'],
  constraints: [],
  verification: ['npm run e2e'],
  do_not_do: [],
  rationale: '首轮执行后需人工确认验证方式',
})

const p2RevisePacket = JSON.stringify({
  verdict: 'revise',
  goal: 'Recovery resume 实现 feature',
  instructions: ['继续实现 src/feature.ts，保留现有修改'],
  constraints: [],
  verification: ['git diff --check'],
  do_not_do: [],
  rationale: '恢复执行，继续既有进度',
})

const p2DonePacket = JSON.stringify({
  verdict: 'done',
  goal: 'Recovery resume 实现 feature',
  instructions: [],
  constraints: [],
  verification: ['git diff --check'],
  do_not_do: [],
  rationale: '验收条件已满足',
})

interface AskBridgeFixtureHandler {
  packet: string
  threadLink?: string
}

/** AskBridge 命令 fixture：写 packet 到 --output，可选返回 Thread Link，记录 requests */
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

// ============ Test Case: Recovery Resume（正例）============

await test('W003 Recovery Resume: lost provider sessions still continue dirty worktree via NEW conversations', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-recovery-resume-'))
  const storageUrl = `file:${join(tempBase, 'test.db')}`
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // ================= PROCESS 1: 运行到 SUSPENDED，捕获 checkpoint（provider 为空） =================
    const askBridge1 = createAskBridgeFixture([{ packet: p1RevisePacket }])
    const claudeFixture1 = createGitDelegatingClaudeFixture(gitRunner)
    const recording1 = createRecordingGitRunner(gitRunner)

    const brain1 = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      model: 'GPT-5.6 Sol',
      reasoning: 'medium',
      headless: false,
      timeoutMs: 120_000,
      commandRunner: askBridge1.runner,
    })

    const executor1 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        if (isClaudeShellRequest(req)) {
          claudeFixture1.requests.push(req)
          // 产生 dirty worktree：tracked 修改 + untracked 新文件
          await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // P1 recovery\n')
          await writeFile(join(repoPath, 'src/new-feature.ts'), 'export const b = 3\n')
          // 故意不返回 session_id：为 provider session 丢失埋下源头
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ type: 'success', result: 'P1 partial done' }),
            stderr: '',
          }
        }
        const command = guardianShellPayload(req)
        if (command !== undefined) {
          return gitRunner(command)
        }
        return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
      },
    })

    const definition: WorkSessionDefinition = {
      id: 'recovery-resume-session',
      targetRepo: repoPath,
      branch: 'main',
      tasks: [{ id: 'T1', goal: 'Recovery resume 实现 feature' }],
      limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
    }

    const taskRunner1 = new GuardianWorkSessionTaskRunner({
      brain: brain1,
      createExecutor: () => executor1,
      repoPath,
      gitRunner: recording1.run,
      taskBuilder: {
        maxIterations: 10,
        constraints: ['约束：保持 src 内部一致性'],
        acceptanceCriteria: ['npm run typecheck 通过', 'feature 行为测试通过'],
        doNotDo: ['不要删除现有文件', '不要 git commit'],
        allowedPaths: ['src/**'],
        forbiddenPaths: ['docs/**', 'migrations/**'],
      },
    })

    const runtime1 = new WorkSessionRuntime({ definition, taskRunner: taskRunner1, storageUrl })
    const state1 = await runtime1.start()

    assert.strictEqual(state1.state, 'SUSPENDED', 'Process 1 must suspend')
    assert.ok(state1.currentTaskCheckpoint !== undefined, 'Checkpoint must exist in durable state')
    const checkpoint1 = state1.currentTaskCheckpoint as GuardianTaskRecoveryCheckpoint

    assert.strictEqual(checkpoint1.version, 1)
    // provider sessions 必须丢失
    assert.strictEqual(checkpoint1.provider.chatgptConversationUrl, undefined, 'ChatGPT URL must be lost')
    assert.strictEqual(checkpoint1.provider.claudeSessionId, undefined, 'Claude session ID must be lost')
    // 部分完成状态必须存在
    assert.ok(checkpoint1.task.lastPacket !== undefined, 'lastPacket must exist')
    assert.ok(checkpoint1.task.lastReport !== undefined, 'lastReport must exist')
    assert.ok(checkpoint1.task.constraints !== undefined, 'hard constraints must exist')
    assert.ok(checkpoint1.task.allowedPaths !== undefined, 'allowedPaths must exist')
    assert.ok(checkpoint1.task.forbiddenPaths !== undefined, 'forbiddenPaths must exist')
    // repo checkpoint 完整
    assert.ok(checkpoint1.repo.branch.length > 0)
    assert.ok(checkpoint1.repo.headSha.length === 40, 'HEAD SHA must be captured')
    assert.ok(checkpoint1.repo.worktreeFingerprint.length === 64, 'fingerprint must be SHA-256 hex')
    assert.ok(checkpoint1.repo.changedFiles.includes('src/feature.ts'), 'dirty file must be captured')
    assert.ok(checkpoint1.repo.changedFiles.includes('src/new-feature.ts'), 'untracked file must be captured')

    await runtime1.close()

    // ================= PROCESS 2: 销毁全部实例，用 NEW instances 恢复 =================
    const recoveryThreadLink = 'https://chatgpt.com/c/recovery-new-conversation'
    const askBridge2 = createAskBridgeFixture([
      { packet: p2RevisePacket, threadLink: recoveryThreadLink },
      { packet: p2DonePacket, threadLink: recoveryThreadLink },
    ])
    const claudeFixture2 = createGitDelegatingClaudeFixture(gitRunner)
    const recording2 = createRecordingGitRunner(gitRunner)

    const brain2 = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      model: 'GPT-5.6 Sol',
      reasoning: 'medium',
      headless: false,
      timeoutMs: 120_000,
      commandRunner: askBridge2.runner,
    })

    // NEW ClaudeCodeExecutor：sessionId 必须从 undefined 开始（无 restore）
    const executor2 = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        if (isClaudeShellRequest(req)) {
          claudeFixture2.requests.push(req)
          // 在既有 dirty 内容上追加，验证"继续而非 recreate"
          await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // P1 recovery\n// P2 continue\n')
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ type: 'success', result: 'P2 continued and completed', session_id: 'claude-recovery-new-session' }),
            stderr: '',
          }
        }
        const command = guardianShellPayload(req)
        if (command !== undefined) {
          return gitRunner(command)
        }
        return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
      },
    })

    const taskRunner2 = new GuardianWorkSessionTaskRunner({
      brain: brain2,
      createExecutor: () => executor2,
      repoPath,
      gitRunner: recording2.run,
    })

    const runtime2 = new WorkSessionRuntime({ definition, taskRunner: taskRunner2, storageUrl })
    const state2 = await runtime2.resume({ approval: true })

    // ============ WorkSession State ============
    assert.strictEqual(state2.state, 'COMPLETED', 'Recovery resume must complete the task')
    assert.strictEqual(state2.completedTaskIds.includes('T1'), true, 'T1 must be completed')
    assert.strictEqual(state2.currentTaskCheckpoint, undefined, 'checkpoint must be cleared after completion')

    await runtime2.close()

    // ============ CHATGPT: 新 conversation ============
    assert.strictEqual(askBridge2.requests.length, 2, 'recovery flow: revise -> done')
    const firstReviewArgs = askBridge2.requests[0]?.args ?? []
    assert.strictEqual(firstReviewArgs.includes('--new'), true, 'Must create NEW ChatGPT conversation')
    assert.strictEqual(firstReviewArgs.includes('--session-url'), false, 'Must NOT use old conversation URL')
    assert.strictEqual(firstReviewArgs.includes('--model'), false, 'New conversation must reuse sticky model')
    assert.strictEqual(firstReviewArgs.includes('--reasoning'), false, 'New conversation must reuse sticky reasoning')

    const reviewerPrompt = firstReviewArgs.at(-1) ?? ''
    assert.ok(reviewerPrompt.includes('recovery_continuation'), 'prompt must carry recovery marker')
    assert.ok(reviewerPrompt.includes('"recovery_continuation":true'), 'recovery_continuation must be true')
    assert.ok(reviewerPrompt.includes('last_packet'), 'prompt must carry last DelegationPacket')
    assert.ok(reviewerPrompt.includes('execution_report'), 'prompt must carry last ExecutionReport')
    assert.ok(reviewerPrompt.includes('Recovery resume 实现 feature'), 'prompt must carry task goal')
    assert.ok(reviewerPrompt.includes('保持 src 内部一致性'), 'prompt must carry constraints')
    assert.ok(reviewerPrompt.includes('npm run typecheck 通过'), 'prompt must carry acceptance criteria')
    assert.ok(reviewerPrompt.includes('不要删除现有文件'), 'prompt must carry doNotDo')
    assert.ok(reviewerPrompt.includes('src/**'), 'prompt must carry allowedPaths')
    assert.ok(reviewerPrompt.includes('docs/**'), 'prompt must carry forbiddenPaths')
    assert.ok(reviewerPrompt.includes('npm run e2e'), 'prompt must carry last packet verification')
    assert.ok(
      !reviewerPrompt.includes('chatgpt.com/c/'),
      'must not claim to restore a nonexistent old conversation',
    )

    // 第二次 review 必须继续 NEW conversation（--session-url），不再 --new
    const secondReviewArgs = askBridge2.requests[1]?.args ?? []
    assert.strictEqual(secondReviewArgs.includes('--new'), false, 'Second review must not create another conversation')
    const sessionIdx = secondReviewArgs.indexOf('--session-url')
    assert.ok(sessionIdx >= 0, 'Second review must continue the new conversation')
    assert.strictEqual(secondReviewArgs[sessionIdx + 1], recoveryThreadLink)

    // ============ CLAUDE: 新 session + task-continuation ============
    assert.strictEqual(claudeFixture2.requests.length, 1, 'recovery flow executes exactly once')
    const claudeArgs = claudeFixture2.requests[0]?.args ?? []
    assert.strictEqual(claudeArgs.includes('--resume'), false, 'Must NOT use --resume (no sessionId)')

    const promptIdx = claudeArgs.indexOf('-p')
    assert.ok(promptIdx >= 0, 'must have -p prompt')
    const claudePrompt = claudeArgs[promptIdx + 1] ?? ''
    assert.ok(claudePrompt.includes('继续当前任务'), 'must use continuation prompt')
    assert.ok(claudePrompt.includes('保留当前工作区修改'), 'continuation prompt must keep workspace changes')
    assert.ok(claudePrompt.includes('不要从头重新实现'), 'continuation prompt must forbid re-implement from scratch')
    assert.ok(
      !claudePrompt.includes('你是 NovaWing Development Guardian 的 Executor'),
      'must NOT use fresh-task prompt',
    )

    const maxTurnsIdx = claudeArgs.indexOf('--max-turns')
    assert.ok(maxTurnsIdx >= 0, 'must have --max-turns')
    assert.strictEqual(
      claudeArgs[maxTurnsIdx + 1],
      '2',
      'recovery resume must use normal task budget, not 6-turn max-turn-recovery',
    )

    // ============ REPO: checkpoint 验证通过 + dirty 保留 ============
    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('P1 recovery'), 'P1 dirty content must be preserved')
    assert.ok(featureContent.includes('P2 continue'), 'P2 changes must be applied on top')
    const newFeatureExists = await access(join(repoPath, 'src/new-feature.ts'))
      .then(() => true)
      .catch(() => false)
    assert.strictEqual(newFeatureExists, true, 'P1 untracked file must survive resume')

    const destructive = recording2.commands.filter((cmd) =>
      /\bgit (reset|clean|restore|checkout|rm)\b/.test(cmd),
    )
    assert.deepEqual(destructive, [], 'no destructive git operations during resume')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Test Case: Fail-Close（负例）============

await test('W003 Recovery Resume: repo drift fails closed before any provider execution', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-recovery-drift-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    // 构造部分完成状态：dirty worktree + 合法 RepositoryCheckpoint
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // checkpoint state\n')
    const repoCheckpoint = await captureCheckpoint(repoPath, gitRunner)

    const lastPacket: DelegationPacket = {
      verdict: 'revise',
      goal: 'drift negative case',
      instructions: ['继续实现 src/feature.ts'],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }
    const lastReport: ExecutionReport = {
      summary: '部分完成',
      changedFiles: ['src/feature.ts'],
      commandsRun: ['claude -p --output-format json'],
      verificationResults: [{ name: 'git diff --check', status: 'passed' }],
      blockers: [],
    }
    const task: GuardianTask = {
      id: 'T-drift',
      goal: 'drift negative case',
      state: 'HUMAN_REQUIRED',
      iteration: 1,
      maxIterations: 10,
      constraints: ['constraint'],
      allowedPaths: ['src/**'],
      lastPacket,
      lastReport,
    }
    const checkpoint: GuardianTaskRecoveryCheckpoint = {
      version: 1,
      task,
      provider: {},
      repo: repoCheckpoint,
      capturedAt: new Date().toISOString(),
    }

    // 外部进程修改 dirty file 内容 → fingerprint mismatch（不做任何 git 操作）
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // EXTERNAL DRIFT EDIT\n')

    let askBridgeCalls = 0
    let claudeCalls = 0

    const brain = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      commandRunner: async () => {
        askBridgeCalls++
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        if (isClaudeShellRequest(req)) {
          claudeCalls++
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ type: 'success', result: 'should not run' }),
            stderr: '',
          }
        }
        const command = guardianShellPayload(req)
        if (command !== undefined) {
          return gitRunner(command)
        }
        return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
      },
    })

    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => executor,
      repoPath,
      gitRunner,
    })

    const result = await runner.run(
      { id: 'T-drift', goal: 'drift negative case' },
      undefined,
      checkpoint,
    )

    // repo validation 必须先于 provider execution，fail-closed
    assert.strictEqual(result.status, 'HUMAN_REQUIRED', 'drift must require human')
    assert.strictEqual(result.humanRequired?.category, 'REPO_DRIFT', 'category must be REPO_DRIFT')
    assert.ok((result.humanRequired?.reason ?? '').includes('REPO_DRIFT'))
    assert.strictEqual(askBridgeCalls, 0, 'AskBridge must NOT be invoked before repo validation')
    assert.strictEqual(claudeCalls, 0, 'Claude invocation must be 0 (fail closed before recovery)')

    // dirty 文件保持原样（没有被 reset/clean/restore）
    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('EXTERNAL DRIFT EDIT'), 'drifted file must remain untouched')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
