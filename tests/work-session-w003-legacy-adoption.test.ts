/**
 * W003 Legacy Recovery Adoption Test
 *
 * Legacy Adoption 解决：W003 之前某个真实 Task 已在 repository 产生 dirty worktree，
 * 但没有 WorkSession checkpoint / ChatGPT conversation URL / Claude session ID。
 * 用户显式调用 adoptLegacyRecoveryCheckpoint，把当前工作现场认领为该 Task 的恢复基线。
 *
 * 证明项：
 * - CASE A: dirty repo 未 adoption 仍 fail closed（Claude invocation = 0），
 *   Legacy Adoption 没有把默认安全策略改成"所有 dirty repo 都可恢复"；
 * - CASE B: 显式 adoption → checkpoint provider sessions 均为 undefined，
 *   branch/HEAD/changedFiles/fingerprint 正确，且只读（git status 前后一致、文件内容一致、无破坏性 git 命令）；
 * - CASE C: adoption checkpoint 注入现有 Recovery Resume path → Task COMPLETED，
 *   ChatGPT --new、Claude 无 --resume + continuation prompt、既有 dirty files 保留；
 * - CASE D: adoption 后再修改文件 → REPO_DRIFT，AskBridge/Claude 调用均为 0
 *   （Adoption 是"在某个确定时刻认可现场"，不是"永久信任 dirty repo"）；
 * - Task Identity: T1 的 checkpoint 拿去 resume T2 → fail closed（SAFETY_BLOCKED）。
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
} from 'nova-wing/development-guardian'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import { adoptLegacyRecoveryCheckpoint } from '../packages/development-guardian/work-session/legacy-recovery.js'
import type { GuardianTaskRecoveryCheckpoint } from '../packages/development-guardian/work-session/checkpoint.js'
import {
  guardianShellPayload,
  guardianShellTestCommand,
  isClaudeShellRequest,
} from './guardian-shell-fixture.js'

// ============ Git Test Helper ============

type GitRunResult = {
  exitCode: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function setupLegacyRepo(baseDir: string): Promise<{
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
  await writeFile(join(repoPath, 'README.md'), '# Legacy Test Repo')
  await gitRunner('git add README.md')
  await gitRunner('git commit -m "Initial commit"')
  await mkdir(join(repoPath, 'src'), { recursive: true })
  await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 1\n')
  await gitRunner('git add src/feature.ts')
  await gitRunner('git commit -m "add feature baseline"')
  await gitRunner('git checkout -b feat/test')

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

/** 通用 git 命令 fixture（委托真实 git，拦截 claude 调用） */
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

/** 只读探测命令（adoption 允许的全部命令） */
const READ_ONLY_ADOPTION_COMMANDS = [
  'git branch --show-current',
  'git rev-parse HEAD',
  'git status --porcelain --untracked-files=all',
]

/** 破坏性 git 命令模式（adoption 必须绝无） */
const DESTRUCTIVE_GIT_PATTERN = /\bgit (add|commit|reset|clean|restore|checkout|stash|rm|mv)\b/

const legacyTaskFacts = {
  id: 'T1',
  goal: 'Legacy 恢复实现 feature',
  constraints: ['保持 src 内部一致性'],
  acceptanceCriteria: ['npm run typecheck 通过'],
  doNotDo: ['不要删除现有文件'],
  allowedPaths: ['src/**'],
  forbiddenPaths: ['docs/**'],
}

const pRevisePacket = JSON.stringify({
  verdict: 'revise',
  goal: 'Legacy 恢复实现 feature',
  instructions: ['继续实现 src/feature.ts 并补全测试'],
  constraints: [],
  verification: ['git diff --check'],
  do_not_do: [],
  rationale: '从既有 dirty worktree 继续',
})

const pDonePacket = JSON.stringify({
  verdict: 'done',
  goal: 'Legacy 恢复实现 feature',
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

/** 计数型 fixture：只数调用，不产生有效输出（用于 fail-closed 负例） */
function createCountingProviderFixtures() {
  const counters = { askBridgeCalls: 0, claudeCalls: 0 }
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async () => {
      counters.askBridgeCalls++
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  return { counters, brain }
}

function claudeCountingCommandRunner(
  gitRunner: (cmd: string) => Promise<GitRunResult>,
  counters: { claudeCalls: number },
): (req: GuardianCommandRequest) => Promise<GuardianCommandResult> {
  return async (req) => {
    if (isClaudeShellRequest(req)) {
      counters.claudeCalls++
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
  }
}

// ============ CASE A: Dirty Repo Without Adoption ============

await test('W003 Legacy Adoption CASE A: dirty repo WITHOUT adoption still fails closed (no default adoption)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-case-a-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    // dirty worktree，但从未调用 adoptLegacyRecoveryCheckpoint
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // dirty without adoption\n')

    const counters = { claudeCalls: 0 }
    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: claudeCountingCommandRunner(gitRunner, counters),
    })

    const task: GuardianTask = { id: 'T1', goal: 'CASE A', iteration: 1, state: 'READY', maxIterations: 3 }
    const packet: DelegationPacket = {
      verdict: 'revise',
      goal: 'CASE A',
      instructions: [],
      constraints: [],
      verification: ['git diff --check'],
      doNotDo: [],
    }

    const report = await executor.execute({ task, packet })

    // 默认安全策略未被 Legacy Adoption 削弱：未 adoption 的 dirty repo 必须 fail closed
    assert.ok(report.blockers.length >= 1, 'must be blocked on dirty worktree without adoption')
    assert.ok(
      report.blockers.some((blocker) => blocker.includes('pre-existing')),
      `must be the dirty-worktree blocker, got: ${report.blockers.join(', ')}`,
    )
    assert.strictEqual(counters.claudeCalls, 0, 'Claude invocation must be 0 (fail closed)')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ CASE B: Explicit Adoption ============

await test('W003 Legacy Adoption CASE B: explicit adoption binds task facts to current repo state (read-only)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-case-b-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    // 制造 legacy dirty worktree：tracked 修改（部分实现）+ 合法 untracked 文件
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // partial legacy implementation\n')
    await writeFile(join(repoPath, 'src/untracked-notes.md'), '# manual notes\n')

    const beforeStatus = (await gitRunner('git status --porcelain --untracked-files=all')).stdout
    const beforeHead = (await gitRunner('git rev-parse HEAD')).stdout.trim()

    // 记录 adoption 期间执行的 git 命令
    const recording = createRecordingGitRunner(gitRunner)

    const checkpoint = await adoptLegacyRecoveryCheckpoint({
      task: legacyTaskFacts,
      repoPath,
      gitRunner: recording.run,
    })

    // ===== checkpoint 结构 =====
    assert.strictEqual(checkpoint.version, 1)
    assert.ok(checkpoint.capturedAt.length > 0, 'capturedAt must exist')

    // provider sessions 一律 undefined
    assert.strictEqual(checkpoint.provider.chatgptConversationUrl, undefined, 'ChatGPT URL must be undefined')
    assert.strictEqual(checkpoint.provider.claudeSessionId, undefined, 'Claude session must be undefined')
    assert.strictEqual(Object.keys(checkpoint.provider).length, 0, 'provider must be empty')

    // task facts 被明确绑定，不从 dirty code 猜测
    assert.strictEqual(checkpoint.task.id, 'T1')
    assert.strictEqual(checkpoint.task.goal, 'Legacy 恢复实现 feature')
    assert.deepEqual(checkpoint.task.constraints, ['保持 src 内部一致性'])
    assert.deepEqual(checkpoint.task.acceptanceCriteria, ['npm run typecheck 通过'])
    assert.deepEqual(checkpoint.task.doNotDo, ['不要删除现有文件'])
    assert.deepEqual(checkpoint.task.allowedPaths, ['src/**'])
    assert.deepEqual(checkpoint.task.forbiddenPaths, ['docs/**'])

    // repo checkpoint
    assert.strictEqual(checkpoint.repo.repoPath, repoPath)
    assert.strictEqual(checkpoint.repo.branch, 'feat/test', 'branch must be feat/test')
    assert.strictEqual(checkpoint.repo.headSha, beforeHead, 'HEAD must match')
    assert.strictEqual(checkpoint.repo.headSha.length, 40, 'HEAD SHA must be 40 chars')
    assert.ok(checkpoint.repo.changedFiles.includes('src/feature.ts'), 'tracked modified must be captured')
    assert.ok(checkpoint.repo.changedFiles.includes('src/untracked-notes.md'), 'untracked file must be captured')
    assert.strictEqual(checkpoint.repo.worktreeFingerprint.length, 64, 'fingerprint must be SHA-256 hex')

    // ===== 只读证明 =====
    assert.deepEqual(
      recording.commands,
      READ_ONLY_ADOPTION_COMMANDS,
      'adoption must issue exactly the 3 read-only git commands',
    )
    const destructive = recording.commands.filter((cmd) => DESTRUCTIVE_GIT_PATTERN.test(cmd))
    assert.deepEqual(destructive, [], 'adoption must issue NO destructive git commands')

    const afterStatus = (await gitRunner('git status --porcelain --untracked-files=all')).stdout
    assert.strictEqual(afterStatus, beforeStatus, 'git status must be identical before/after adoption')

    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('partial legacy implementation'), 'tracked file content must be unchanged')
    const notesContent = await readFile(join(repoPath, 'src/untracked-notes.md'), 'utf8')
    assert.ok(notesContent.includes('manual notes'), 'untracked file content must be unchanged')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ CASE C: Adopt Then Recovery Resume ============

await test('W003 Legacy Adoption CASE C: adopted checkpoint feeds existing Recovery Resume path to COMPLETED', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-case-c-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    // legacy dirty worktree
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // legacy partial\n')
    await writeFile(join(repoPath, 'src/untracked-notes.md'), '# manual notes\n')

    // ===== ADOPT（使用缺省 git runner，证明真实运行器可用）=====
    const checkpoint = await adoptLegacyRecoveryCheckpoint({
      task: legacyTaskFacts,
      repoPath,
    })
    assert.strictEqual(checkpoint.provider.chatgptConversationUrl, undefined)
    assert.strictEqual(checkpoint.provider.claudeSessionId, undefined)
    assert.strictEqual(checkpoint.repo.branch, 'feat/test')
    assert.strictEqual(checkpoint.repo.worktreeFingerprint.length, 64)

    // ===== RECOVERY RESUME：复用既有 path，provider state 全部为空 =====
    const recoveryThreadLink = 'https://chatgpt.com/c/recovery-legacy-conversation'
    const askBridge = createAskBridgeFixture([
      { packet: pRevisePacket, threadLink: recoveryThreadLink },
      { packet: pDonePacket, threadLink: recoveryThreadLink },
    ])
    const claudeFixture = createGitDelegatingClaudeFixture(gitRunner)
    const recording = createRecordingGitRunner(gitRunner)

    const brain = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      model: 'GPT-5.6 Sol',
      reasoning: 'medium',
      headless: false,
      timeoutMs: 120_000,
      commandRunner: askBridge.runner,
    })

    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: async (req) => {
        if (isClaudeShellRequest(req)) {
          claudeFixture.requests.push(req)
          // 在既有 dirty 内容上追加，验证"继续而非 recreate"
          await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // legacy partial\n// resumed\n')
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ type: 'success', result: 'legacy task continued and completed' }),
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
      gitRunner: recording.run,
    })

    const result = await runner.run(
      { id: 'T1', goal: 'Legacy 恢复实现 feature' },
      undefined,
      checkpoint,
    )

    // ===== 结果 =====
    assert.strictEqual(result.status, 'COMPLETED', 'adopted checkpoint must recover to COMPLETED')

    // ChatGPT：新 conversation
    assert.strictEqual(askBridge.requests.length, 2, 'recovery flow: revise -> done')
    const firstReviewArgs = askBridge.requests[0]?.args ?? []
    assert.strictEqual(firstReviewArgs.includes('--new'), true, 'Must create NEW ChatGPT conversation')
    assert.strictEqual(firstReviewArgs.includes('--session-url'), false, 'Must NOT use old conversation URL')
    assert.strictEqual(firstReviewArgs.includes('--model'), true, 'New conversation may set model')
    assert.strictEqual(firstReviewArgs.includes('--reasoning'), true, 'New conversation may set reasoning')

    const reviewerPrompt = firstReviewArgs.at(-1) ?? ''
    assert.ok(reviewerPrompt.includes('Legacy 恢复实现 feature'), 'prompt must carry task goal')
    assert.ok(reviewerPrompt.includes('保持 src 内部一致性'), 'prompt must carry constraints')
    assert.ok(reviewerPrompt.includes('npm run typecheck 通过'), 'prompt must carry acceptance criteria')
    assert.ok(reviewerPrompt.includes('不要删除现有文件'), 'prompt must carry doNotDo')
    assert.ok(reviewerPrompt.includes('src/**'), 'prompt must carry allowedPaths')
    assert.ok(reviewerPrompt.includes('docs/**'), 'prompt must carry forbiddenPaths')
    // W003: recovery_continuation 只由"携带并成功验证了 checkpoint"决定。
    // Legacy Adoption 的 checkpoint provider empty、lastPacket/lastReport 全为空，
    // 但仍必须是 recovery continuation，且继续携带 task hard facts。
    assert.ok(
      reviewerPrompt.includes('"recovery_continuation":true'),
      'legacy adopted checkpoint must be a recovery continuation',
    )
    assert.ok(
      reviewerPrompt.includes('"last_packet":null'),
      'legacy checkpoint has no last packet; recovery must NOT be inferred from lastPacket',
    )
    assert.ok(
      reviewerPrompt.includes('"execution_report":null'),
      'legacy checkpoint has no execution report; recovery must NOT be inferred from lastReport',
    )
    assert.ok(
      !reviewerPrompt.includes('chatgpt.com/c/'),
      'must not claim to restore a nonexistent old conversation',
    )

    // 第二次 review 继续 NEW conversation（--session-url），不再 --new
    const secondReviewArgs = askBridge.requests[1]?.args ?? []
    assert.strictEqual(secondReviewArgs.includes('--new'), false, 'Second review must not create another conversation')
    const sessionIdx = secondReviewArgs.indexOf('--session-url')
    assert.ok(sessionIdx >= 0, 'Second review must continue the new conversation')
    assert.strictEqual(secondReviewArgs[sessionIdx + 1], recoveryThreadLink)

    // Claude：无 --resume + continuation prompt + 普通 task budget
    assert.strictEqual(claudeFixture.requests.length, 1, 'recovery flow executes exactly once')
    const claudeArgs = claudeFixture.requests[0]?.args ?? []
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

    // RepositoryCheckpoint 验证通过（否则早已 REPO_DRIFT）+ 既有 dirty files 保留
    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('legacy partial'), 'legacy dirty content must be preserved')
    assert.ok(featureContent.includes('resumed'), 'resumed work must be applied on top')
    const notesExists = await access(join(repoPath, 'src/untracked-notes.md'))
      .then(() => true)
      .catch(() => false)
    assert.strictEqual(notesExists, true, 'legacy untracked file must survive resume')

    const destructive = recording.commands.filter((cmd) => DESTRUCTIVE_GIT_PATTERN.test(cmd))
    assert.deepEqual(destructive, [], 'no destructive git operations during recovery resume')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ CASE D: Drift After Adoption ============

await test('W003 Legacy Adoption CASE D: repo modified after adoption fails closed (point-in-time trust)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-case-d-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // legacy partial\n')
    await writeFile(join(repoPath, 'src/untracked-notes.md'), '# manual notes\n')

    const checkpoint = await adoptLegacyRecoveryCheckpoint({
      task: legacyTaskFacts,
      repoPath,
    })
    assert.strictEqual(checkpoint.repo.worktreeFingerprint.length, 64, 'adoption must capture fingerprint')

    // Adoption 之后外部再次修改 dirty file 内容
    await writeFile(
      join(repoPath, 'src/feature.ts'),
      'export const a = 2 // legacy partial\n// EXTERNAL POST-ADOPTION EDIT\n',
    )

    const { counters, brain } = createCountingProviderFixtures()
    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: claudeCountingCommandRunner(gitRunner, counters),
    })

    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => executor,
      repoPath,
      gitRunner,
    })

    const result = await runner.run(
      { id: 'T1', goal: 'Legacy 恢复实现 feature' },
      undefined,
      checkpoint,
    )

    assert.strictEqual(result.status, 'HUMAN_REQUIRED', 'drift must require human')
    assert.strictEqual(result.humanRequired?.category, 'REPO_DRIFT', 'category must be REPO_DRIFT')
    assert.ok((result.humanRequired?.reason ?? '').includes('REPO_DRIFT'))
    assert.strictEqual(counters.askBridgeCalls, 0, 'AskBridge invocation must be 0 (fail closed)')
    assert.strictEqual(counters.claudeCalls, 0, 'Claude invocation must be 0 (fail closed)')

    // drifted 文件保持原样（没有被 reset/clean/restore）
    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('EXTERNAL POST-ADOPTION EDIT'), 'drifted file must remain untouched')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ Task Identity: T1 checkpoint cannot resume T2 ============

await test('W003 Legacy Adoption: T1 checkpoint cannot resume T2 (task identity fail-closed)', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-legacy-identity-'))
  const { repoPath, gitRunner } = await setupLegacyRepo(tempBase)

  try {
    await writeFile(join(repoPath, 'src/feature.ts'), 'export const a = 2 // legacy partial\n')

    const checkpoint: GuardianTaskRecoveryCheckpoint = await adoptLegacyRecoveryCheckpoint({
      task: { id: 'T1', goal: 'T1 的任务' },
      repoPath,
    })
    assert.strictEqual(checkpoint.task.id, 'T1', 'checkpoint must belong to T1')

    const { counters, brain } = createCountingProviderFixtures()
    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 2,
      timeoutMs: 10_000,
      commandRunner: claudeCountingCommandRunner(gitRunner, counters),
    })

    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => executor,
      repoPath,
      gitRunner,
    })

    // 用 T2 去 resume T1 的 checkpoint：必须 fail closed
    const result = await runner.run(
      { id: 'T2', goal: 'T2 的任务' },
      undefined,
      checkpoint,
    )

    assert.strictEqual(result.status, 'HUMAN_REQUIRED', 'task mismatch must require human')
    assert.strictEqual(result.humanRequired?.category, 'SAFETY_BLOCKED', 'category must be SAFETY_BLOCKED')
    assert.ok((result.humanRequired?.reason ?? '').includes('T1'), 'reason must name the checkpoint task')
    assert.strictEqual(counters.askBridgeCalls, 0, 'AskBridge must NOT be invoked on task mismatch')
    assert.strictEqual(counters.claudeCalls, 0, 'Claude invocation must be 0 on task mismatch')

    // dirty 文件保持原样
    const featureContent = await readFile(join(repoPath, 'src/feature.ts'), 'utf8')
    assert.ok(featureContent.includes('legacy partial'), 'file must remain untouched')
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
