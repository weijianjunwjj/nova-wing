/* global console, process */
/**
 * W003 最终 Fly-Weave T002 Legacy Recovery Canary — 第二次验收
 *
 * 真实链：WorkSessionRuntime → GuardianWorkSessionTaskRunner → AskBridgeBrain → ClaudeCodeExecutor
 *
 * 流程：
 *  1. 前置环境确认（python --version / where.exe python）
 *  2. Fly-Weave 只读勘察（branch / HEAD / changed files / fingerprint）
 *  3. 重新 Explicit Legacy Adoption（旧 checkpoint 作废）
 *  4. WorkSessionRuntime 播种 run（fake provider → SUSPENDED snapshot）
 *  5. WorkSessionRuntime.resumeFromRecoveryCheckpoint（正式 recovery API，
 *     内部校验 session/identity 并持久化 checkpoint；不走 raw snapshot）
 *  6. 走真实 GuardianWorkSessionTaskRunner + AskBridgeBrain + ClaudeCodeExecutor
 *
 * 模式：
 *  - W003_DRY_RUN=1：fake provider（验证注入与完整链路，真实 adapter 生成 args/prompt）
 *  - 默认：真实 ask-bridge.exe + 真实 claude CLI
 *
 * 输出：stdout JSON = W003_FLYWEAVE_CANARY_PROOF_V2
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  AskBridgeBrain,
  ClaudeCodeExecutor,
} from '../dist/packages/development-guardian/index.js'
import { WorkSessionRuntime } from '../dist/packages/development-guardian/work-session/runtime.js'
import { GuardianWorkSessionTaskRunner } from '../dist/packages/development-guardian/work-session/guardian-task-runner.js'
import { adoptLegacyRecoveryCheckpoint } from '../dist/packages/development-guardian/work-session/legacy-recovery.js'

// ============ Constants ============

const FLY_WEAVE = resolve('D:/VSCode/fly-weave')
const ASK_BRIDGE_EXE = join(process.env.USERPROFILE ?? '', '.local', 'bin', 'ask-bridge.exe')
const DRY_RUN = process.env.W003_DRY_RUN?.trim() === '1'

const T002_FACTS = {
  id: 'T002',
  goal: 'Create the minimal FastAPI backend.',
  constraints: [
    '只允许修改 apps/api/**（除非确实需要 root workspace）',
    '保持最小 FastAPI 后端，不引入额外复杂度',
  ],
  acceptanceCriteria: [
    'API starts locally',
    'GET /health returns structured healthy status',
    'configuration is environment-driven',
    'basic test structure exists',
  ],
  doNotDo: [
    '不要引入 microservices',
    '不要引入 generic provider layer',
    '不要引入 Agent framework',
    '不要引入 PostgreSQL / 数据库依赖',
    '不要 git commit',
    '不要 git push',
  ],
  allowedPaths: ['apps/api/**'],
  forbiddenPaths: ['node_modules/**', '.git/**', 'dist/**'],
}

const DEFINITION = {
  id: 'w003-flyweave-t002-legacy-recovery',
  targetRepo: FLY_WEAVE,
  branch: 'feat/mvp-shell',
  tasks: [{ id: 'T002', goal: T002_FACTS.goal }],
  limits: { softMinutes: 30, hardMinutes: 90, maxTasks: 1 },
}

// ============ Helpers ============

function spawnCapture(executable, args, cwd, timeoutMs, onOutput) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-200_000)
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolvePromise({
        exitCode: null,
        stdout,
        stderr: `${stderr}\ncommand timed out after ${timeoutMs}ms`.trim(),
      })
    }, timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

/** 真实 git runner（只读命令；记录所有命令用于证明无破坏性操作） */
function createGitRunner(repoPath, commandLog) {
  return async (command) => {
    const parts = command.trim().split(/\s+/)
    if (commandLog !== null) {
      commandLog.push(command)
    }
    const result = await spawnCapture('git', parts.slice(1), repoPath, 30_000, null)
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}

/** 真实 ask-bridge runner（spawn ask-bridge.exe；记录 args） */
function createRealAskBridgeRunner(record) {
  return async (request) => {
    record.push({ args: [...request.args], kind: 'ask-bridge', at: Date.now() })
    return spawnCapture(ASK_BRIDGE_EXE, [...request.args], process.cwd(), request.timeoutMs, null)
  }
}

/** 真实 claude runner（spawn request.executable + args，与 defaultCommandRunner 一致；记录 args） */
function createRealClaudeRunner(record) {
  return async (request) => {
    const isClaude =
      request.executable === 'bash' &&
      request.args.length > 1 &&
      (request.args[1]?.includes('claude') ?? false)
    record.push({
      args: [...request.args],
      kind: 'claude',
      isClaude,
      at: Date.now(),
      cwd: request.cwd,
    })
    return spawnCapture(request.executable, [...request.args], request.cwd, request.timeoutMs, null)
  }
}

/** fake ask-bridge runner（写 packet 到 --output，返回 Thread Link） */
function createFakeAskBridgeRunner(packets, record) {
  let call = 0
  return async (request) => {
    record.push({ args: [...request.args], kind: 'ask-bridge', at: Date.now() })
    const outputIndex = request.args.indexOf('--output')
    const outputPath = outputIndex >= 0 ? request.args[outputIndex + 1] : undefined
    if (outputPath === undefined) {
      return { exitCode: 1, stdout: '', stderr: 'missing --output' }
    }
    const handler = packets[call]
    call += 1
    if (handler === undefined) {
      return { exitCode: 1, stdout: '', stderr: `unexpected ask-bridge call #${call}` }
    }
    await writeFile(outputPath, handler.packet, 'utf8')
    return {
      exitCode: 0,
      stdout: handler.threadLink !== undefined
        ? `${handler.packet}\nThread Link: ${handler.threadLink}`
        : handler.packet,
      stderr: '',
    }
  }
}

/** fake claude runner（claude 调用返回成功 JSON；bash git 委托 gitRunner） */
function createFakeClaudeRunner(record, gitRunner) {
  let call = 0
  return async (request) => {
    const isClaude =
      request.executable === 'bash' &&
      request.args.length > 1 &&
      (request.args[1]?.includes('claude') ?? false)
    record.push({
      args: [...request.args],
      kind: 'claude',
      isClaude,
      at: Date.now(),
      cwd: request.cwd,
    })
    if (isClaude) {
      call += 1
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          type: 'success',
          result: call === 1 ? 'T002 continued via recovery resume' : 'T002 work continued',
          session_id: `claude-fake-session-${call}`,
        }),
        stderr: '',
      }
    }
    if (request.executable === 'bash' && request.args[0] === '-lc' && request.args[1] !== undefined) {
      return gitRunner(request.args[1])
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
  }
}

const BLOCKED_PACKET = {
  verdict: 'blocked',
  goal: T002_FACTS.goal,
  instructions: [],
  constraints: [],
  verification: [],
  doNotDo: [],
  rationale: 'seed run: no adoption checkpoint yet',
}

function makeRevisePacket(index) {
  return {
    verdict: 'revise',
    goal: T002_FACTS.goal,
    instructions: [
      index === 1
        ? '继续 T002：创建 .venv、安装依赖，并运行确定性验证。'
        : '继续完成剩余 T002 工作并运行确定性验证。',
    ],
    constraints: [],
    verification: ['git diff --check'],
    do_not_do: [],
    rationale: 'recovery continuation: continue existing dirty worktree',
  }
}

const DONE_PACKET = {
  verdict: 'done',
  goal: T002_FACTS.goal,
  instructions: [],
  constraints: [],
  verification: ['git diff --check'],
  do_not_do: [],
  rationale: 'acceptance criteria satisfied',
}

// ============ Proof collector ============

const PROOF = {
  ENVIRONMENT: {},
  BEFORE: {},
  ADOPTION: {},
  PROVIDER: { askBridgeArgs: [], claudeArgs: [] },
  VERIFICATION: {},
  RESULT: {},
  COST: {},
}

// ============ 0. 前置环境确认 ============

async function collectEnvironment() {
  const pythonVersion = await spawnCapture(
    'python',
    ['--version'],
    process.cwd(),
    10_000,
    null,
  ).catch(() => ({ exitCode: null, stdout: '', stderr: '' }))
  PROOF.ENVIRONMENT.pythonVersion = (pythonVersion.stdout || pythonVersion.stderr || '').trim()
  const whereResult = await spawnCapture(
    'where.exe',
    ['python'],
    process.cwd(),
    10_000,
    null,
  ).catch(() => ({ exitCode: null, stdout: '', stderr: '' }))
  PROOF.ENVIRONMENT.pythonPaths = (whereResult.stdout || '')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
  PROOF.ENVIRONMENT.resolvedPythonPath = PROOF.ENVIRONMENT.pythonPaths[0] ?? null
}

async function main() {
  const startedAt = Date.now()
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-canary-'))
  const storageUrl = `file:${join(tempBase, 'canary.db')}`
  const seedRepoPath = join(tempBase, 'seed-repo')

  let runtimeA = null
  let runtimeB = null
  let resultError = null

  try {
    await collectEnvironment()

    // ============ 1. Fly-Weave 只读勘察 ============
    const preCommands = []
    const preGit = createGitRunner(FLY_WEAVE, preCommands)
    const branchRes = await preGit('git branch --show-current')
    const headRes = await preGit('git rev-parse HEAD')
    const statusRes = await preGit('git status --porcelain --untracked-files=all')
    const preEntries = parseStatus(statusRes.stdout)
    const preFingerprint = await computeFingerprint(FLY_WEAVE, preEntries)

    PROOF.BEFORE.branch = branchRes.stdout.trim()
    PROOF.BEFORE.head = headRes.stdout.trim()
    PROOF.BEFORE.changedFiles = preEntries.map((e) => e.path)
    PROOF.BEFORE.fingerprint = preFingerprint
    PROOF.BEFORE.changedCount = preEntries.length

    // ============ 2/3. 重新 Explicit Legacy Adoption ============
    const adoptionCommands = []
    const adoptionGit = createGitRunner(FLY_WEAVE, adoptionCommands)
    const adopted = await adoptLegacyRecoveryCheckpoint({
      task: T002_FACTS,
      repoPath: FLY_WEAVE,
      gitRunner: adoptionGit,
    })

    PROOF.ADOPTION.checkpoint = {
      version: adopted.version,
      taskId: adopted.task.id,
      taskGoal: adopted.task.goal,
      taskState: adopted.task.state,
      taskIteration: adopted.task.iteration,
      maxIterations: adopted.task.maxIterations,
      constraints: adopted.task.constraints ?? null,
      acceptanceCriteria: adopted.task.acceptanceCriteria ?? null,
      doNotDo: adopted.task.doNotDo ?? null,
      allowedPaths: adopted.task.allowedPaths ?? null,
      forbiddenPaths: adopted.task.forbiddenPaths ?? null,
      providerKeys: Object.keys(adopted.provider),
      chatgptConversationUrl: adopted.provider.chatgptConversationUrl ?? null,
      claudeSessionId: adopted.provider.claudeSessionId ?? null,
      repoPath: adopted.repo.repoPath,
      branch: adopted.repo.branch,
      headSha: adopted.repo.headSha,
      changedFiles: adopted.repo.changedFiles,
      worktreeFingerprint: adopted.repo.worktreeFingerprint,
      capturedAt: adopted.capturedAt,
      adoptionGitCommands: adoptionCommands,
      adoptionGitCommandCount: adoptionCommands.length,
    }
    PROOF.ADOPTION.newFingerprint = adopted.repo.worktreeFingerprint
    PROOF.ADOPTION.providerStates = {
      chatgptConversationUrl: adopted.provider.chatgptConversationUrl ?? null,
      claudeSessionId: adopted.provider.claudeSessionId ?? null,
      providerEmpty: Object.keys(adopted.provider).length === 0,
    }

    // ============ 4. Seed run（fake provider → SUSPENDED snapshot） ============
    const seedCommands = []
    const seedGit = createGitRunner(FLY_WEAVE, seedCommands)
    const fakeBrain = {
      review: async () => BLOCKED_PACKET,
      captureProviderState: () => ({ taskConversationUrls: {}, reviewedTaskIds: [] }),
    }
    const fakeExecutor = {
      execute: async () => ({
        summary: 'seed noop',
        changedFiles: [],
        commandsRun: [],
        verificationResults: [],
        blockers: [],
      }),
      captureProviderState: () => ({}),
    }
    const seedRunner = new GuardianWorkSessionTaskRunner({
      brain: fakeBrain,
      createExecutor: () => fakeExecutor,
      repoPath: FLY_WEAVE,
      gitRunner: seedGit,
    })
    runtimeA = new WorkSessionRuntime({ definition: DEFINITION, taskRunner: seedRunner, storageUrl })
    const seedState = await runtimeA.start()
    if (seedState.state !== 'SUSPENDED') {
      throw new Error(`seed run did not suspend: ${seedState.state}`)
    }
    await runtimeA.close()
    runtimeA = null
    // checkpoint 注入交给正式 WorkSessionRuntime.resumeFromRecoveryCheckpoint（内部持久化），
    // 不再直接操作 Mastra raw snapshot。

    // ============ 5. Real resume（真实链） ============
    const askBridgeRecord = []
    const claudeRecord = []
    const resumeGitCommands = []
    const resumeGit = createGitRunner(FLY_WEAVE, resumeGitCommands)

    const claudeTiming = []
    const askBridgeTimeoutMs = 11 * 60 * 1000
    const claudeTimeoutMs = 25 * 60 * 1000

    const realAskBridgeRunner = DRY_RUN
      ? createFakeAskBridgeRunner(
          [
            { packet: JSON.stringify(makeRevisePacket(1)), threadLink: 'https://chatgpt.com/c/dry-run-recovery-1' },
            { packet: JSON.stringify(makeRevisePacket(2)), threadLink: 'https://chatgpt.com/c/dry-run-recovery-1' },
            { packet: JSON.stringify(DONE_PACKET), threadLink: 'https://chatgpt.com/c/dry-run-recovery-1' },
          ],
          askBridgeRecord,
        )
      : createRealAskBridgeRunner(askBridgeRecord)

    const brain = new AskBridgeBrain({
      command: ASK_BRIDGE_EXE,
      model: 'GPT-5.6 Sol',
      reasoning: 'medium',
      headless: false,
      timeoutMs: askBridgeTimeoutMs,
      commandRunner: realAskBridgeRunner,
      onDiagnostic: (event) => {
        if (!DRY_RUN) {
          console.error(`[bridge] ${event.stream}: ${event.line}`)
        }
      },
    })

    const realClaudeRunner = DRY_RUN
      ? createFakeClaudeRunner(claudeRecord, resumeGit)
      : createRealClaudeRunner(claudeRecord)

    const executor = new ClaudeCodeExecutor({
      cwd: FLY_WEAVE,
      maxTurns: 12,
      timeoutMs: claudeTimeoutMs,
      model: 'sonnet',
      allowPythonBootstrap: true,
      commandRunner: realClaudeRunner,
      onTiming: (event) => {
        claudeTiming.push(event)
      },
    })

    const realRunner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => executor,
      repoPath: FLY_WEAVE,
      gitRunner: resumeGit,
    })

    runtimeB = new WorkSessionRuntime({ definition: DEFINITION, taskRunner: realRunner, storageUrl })
    const resumeState = await runtimeB.resumeFromRecoveryCheckpoint({
      sessionId: DEFINITION.id,
      checkpoint: adopted,
      resumeData: { approval: true },
    })

    PROOF.PROVIDER.askBridgeArgs = askBridgeRecord.map((entry) => entry.args)
    const claudeInvocations = claudeRecord.filter((entry) => entry.isClaude === true)
    PROOF.PROVIDER.claudeArgs = claudeInvocations.map((entry) => entry.args)
    PROOF.PROVIDER.askBridgeCount = askBridgeRecord.length
    PROOF.PROVIDER.claudeCount = claudeInvocations.length

    // 提取 W003 行为证据
    PROOF.PROVIDER.firstAskBridgeNew = analyzeFirstAskBridge(askBridgeRecord)
    PROOF.PROVIDER.firstClaudeResume = analyzeFirstClaude(claudeInvocations)
    PROOF.PROVIDER.laterClaudeResume = analyzeLaterClaude(claudeInvocations)

    // ============ 6. Verification ============
    PROOF.VERIFICATION.gitCommands = resumeGitCommands
    PROOF.VERIFICATION.destructiveGit = resumeGitCommands.filter((cmd) =>
      /\bgit (reset|clean|restore|checkout|stash|rm|add|commit|push)\b/.test(cmd),
    )

    // ============ 7. Result ============
    PROOF.RESULT.workSessionState = resumeState.state
    PROOF.RESULT.completedTaskIds = resumeState.completedTaskIds
    PROOF.RESULT.currentTaskId = resumeState.currentTaskId
    if (resumeState.humanRequired !== undefined) {
      PROOF.RESULT.humanRequired = resumeState.humanRequired
    }
    if (resumeState.currentTaskCheckpoint !== undefined) {
      PROOF.RESULT.finalCheckpoint = {
        version: resumeState.currentTaskCheckpoint.version,
        taskState: resumeState.currentTaskCheckpoint.task.state,
        taskIteration: resumeState.currentTaskCheckpoint.task.iteration,
        taskStopReason: resumeState.currentTaskCheckpoint.task.stopReason ?? null,
        providerKeys: Object.keys(resumeState.currentTaskCheckpoint.provider),
        chatgptConversationUrl: resumeState.currentTaskCheckpoint.provider.chatgptConversationUrl ?? null,
        claudeSessionId: resumeState.currentTaskCheckpoint.provider.claudeSessionId ?? null,
      }
    }
    PROOF.RESULT.destructiveGit = PROOF.VERIFICATION.destructiveGit
    PROOF.RESULT.destructiveGitCount = PROOF.VERIFICATION.destructiveGit.length

    // 检查 Fly-Weave HEAD 是否变化（无 commit）
    const afterHead = await resumeGit('git rev-parse HEAD')
    PROOF.RESULT.flyWeaveHeadBefore = PROOF.BEFORE.head
    PROOF.RESULT.flyWeaveHeadAfter = afterHead.stdout.trim()
    PROOF.RESULT.flyWeaveCommitted = afterHead.stdout.trim() !== PROOF.BEFORE.head

    // ============ 8. Cost ============
    PROOF.COST.reviewerIterations = askBridgeRecord.length
    PROOF.COST.claudeInvocations = PROOF.PROVIDER.claudeCount
    PROOF.COST.claudeTurns = claudeTiming.filter((e) => e.phase === 'claude-code').reduce(
      (sum, e) => sum + (e.numTurns ?? 0),
      0,
    )
    PROOF.COST.reportedCostUsd = claudeTiming.reduce((sum, e) => sum + (e.totalCostUsd ?? 0), 0)
    PROOF.COST.elapsedMs = Date.now() - startedAt
  } catch (error) {
    resultError = error instanceof Error ? error.message : String(error)
    console.error(`[canary-error] ${resultError}`)
  } finally {
    if (runtimeA !== null) {
      await runtimeA.close().catch(() => {})
    }
    if (runtimeB !== null) {
      await runtimeB.close().catch(() => {})
    }
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }

  PROOF.RESULT.error = resultError
  PROOF.RESULT.canaryResult = computeCanaryResult(PROOF)
  console.log(JSON.stringify(PROOF, null, 2))
  process.exitCode = PROOF.RESULT.canaryResult === 'COMPLETED' ? 0 : 1
}

// ============ Analysis helpers ============

function parseStatus(stdout) {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3).trim() }))
    .filter((entry) => entry.path.length > 0)
}

async function computeFingerprint(repoPath, entries) {
  const { computeWorktreeFingerprint } = await import(
    '../dist/packages/development-guardian/work-session/worktree-fingerprint.js'
  )
  return computeWorktreeFingerprint(repoPath, entries)
}

function analyzeFirstAskBridge(record) {
  if (record.length === 0) {
    return { executed: false }
  }
  const args = record[0].args
  const prompt = args.at(-1) ?? ''
  return {
    executed: true,
    hasNew: args.includes('--new'),
    hasSessionUrl: args.includes('--session-url'),
    hasModel: args.includes('--model'),
    modelValue: args[args.indexOf('--model') + 1] ?? null,
    hasReasoning: args.includes('--reasoning'),
    reasoningValue: args[args.indexOf('--reasoning') + 1] ?? null,
    recoveryContinuationTrue: prompt.includes('"recovery_continuation":true'),
    recoveryContinuationFalse: prompt.includes('"recovery_continuation":false'),
    lastPacketNull: prompt.includes('"last_packet":null'),
    executionReportNull: prompt.includes('"execution_report":null'),
    claimsOldConversation: prompt.includes('chatgpt.com/c/'),
    carriesGoal: prompt.includes(T002_FACTS.goal),
    carriesConstraint: prompt.includes('只允许修改 apps/api/**'),
    carriesAcceptance: prompt.includes('API starts locally'),
    carriesDoNotDo: prompt.includes('不要引入 PostgreSQL'),
    carriesAllowedPath: prompt.includes('apps/api/**'),
  }
}

function analyzeFirstClaude(record) {
  if (record.length === 0) {
    return { executed: false }
  }
  const args = record[0].args
  const promptIdx = args.indexOf('-p')
  const prompt = promptIdx >= 0 ? (args[promptIdx + 1] ?? '') : ''
  return {
    executed: true,
    hasResume: args.includes('--resume'),
    resumeValue: args.includes('--resume') ? (args[args.indexOf('--resume') + 1] ?? null) : null,
    isContinuationPrompt: prompt.includes('继续当前任务'),
    keepsWorkspaceChanges: prompt.includes('保留当前工作区修改'),
    forbidsReimplement: prompt.includes('不要从头重新实现'),
    isFreshPrompt: prompt.includes('你是 NovaWing Development Guardian 的 Executor'),
    hasMaxTurns: args.includes('--max-turns'),
    maxTurnsValue: args.includes('--max-turns') ? (args[args.indexOf('--max-turns') + 1] ?? null) : null,
    hasModel: args.includes('--model'),
    modelValue: args.includes('--model') ? (args[args.indexOf('--model') + 1] ?? null) : null,
  }
}

function analyzeLaterClaude(record) {
  if (record.length < 2) {
    return { resumed: false, count: record.length }
  }
  const later = record.slice(1)
  const resumed = later.map((entry) => entry.args.includes('--resume'))
  return {
    count: later.length,
    resumed,
    anyResume: resumed.some((r) => r),
  }
}

function computeCanaryResult(proof) {
  const r = proof.RESULT
  if (r.error !== null && r.error !== undefined) {
    return 'BLOCKER'
  }
  if (r.humanRequired !== undefined) {
    const category = r.humanRequired.category
    if (category === 'ENVIRONMENT_REQUIRED') return 'ENVIRONMENT_REQUIRED'
    if (category === 'REPO_DRIFT') return 'REPO_DRIFT'
    if (category === 'SAFETY_BLOCKED') return 'SAFETY_BLOCKED'
    if (category === 'PERMISSION_REQUIRED') return 'PERMISSION_REQUIRED'
    if (category === 'STALLED') return 'STALLED'
    return 'HUMAN_REQUIRED'
  }
  if (r.workSessionState === 'COMPLETED') {
    return 'COMPLETED'
  }
  if (r.workSessionState === 'FAILED') {
    return 'FAILED'
  }
  return 'INCOMPLETE'
}

await main()
