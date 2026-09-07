/**
 * W003 FINAL D: Deterministic Verification Capability 回归测试
 *
 * 复现 Fly-Weave Canary 的 permission-denial 收敛场景：
 * - Brain proceed → Claude 完成代码但 permission_denials 命中 deterministic verification
 *   （.venv/Scripts/python.exe -m pytest、git diff --check）
 * - ExecutionReport 携带 incompleteReason / permissionDenials / executorCapabilities /
 *   deterministicVerificationCapabilities
 * - Reviewer 第二轮必须 revise（不得 blocked）：不让 Claude 再跑被拒验证命令，
 *   验证交由 Guardian deterministic verifier
 * - 下一轮 Claude 只做代码修改，Executor 自行执行 git diff --check + pytest（PASS）
 * - Reviewer done → Guardian COMPLETED
 *
 * 断言：
 * - report.deterministicVerificationCapabilities 包含 pytest / git diff --check
 * - executorCapabilities 不包含 pytest / git diff --check（能力边界分离）
 * - Claude 的 allowedTools 不含 Bash(pytest) / Bash(git diff --check)（无新权限）
 * - 最终 COMPLETED
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AskBridgeBrain,
  ClaudeCodeExecutor,
  type AskBridgeCommandRequest,
  type AskBridgeCommandRunner,
  type GuardianCommandRequest,
  type GuardianCommandResult,
} from 'nova-wing/development-guardian'
import { GuardianWorkSessionTaskRunner } from '../packages/development-guardian/work-session/guardian-task-runner.js'
import {
  guardianShellPayload,
  guardianShellTestCommand,
  isClaudeShellRequest,
  isGuardianShellRequest,
} from './guardian-shell-fixture.js'

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

// ============ Claude runner fixture ============

/** 命中的 deterministic verification 命令：模拟 Guardian 独立执行并成功 */
const VERIFY_OK_COMMANDS = new Set([
  '.venv/Scripts/python.exe -m pytest',
  'git diff --check',
])

function createClaudeFixture(
  gitRunner: (cmd: string) => Promise<GitRunResult>,
  denials: { tool: string; operation: string; summary: string }[],
) {
  const requests: GuardianCommandRequest[] = []
  let claudeCall = 0
  const runner = async (req: GuardianCommandRequest): Promise<GuardianCommandResult> => {
    requests.push(req)
    const isClaude = isClaudeShellRequest(req)
    if (isClaude) {
      claudeCall += 1
      if (claudeCall === 1) {
        // 第一次：代码已完成，但 Claude 会话内被拒跑验证命令
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            type: 'success',
            subtype: 'success',
            result: '代码已完成，但验证命令被拒绝',
            session_id: 'session-dv-1',
            permission_denials: denials,
          }),
          stderr: '',
        }
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          type: 'success',
          subtype: 'success',
          result: '仅完成必要代码修改',
          session_id: 'session-dv-1',
        }),
        stderr: '',
      }
    }
    const shellCommand = guardianShellPayload(req)
    if (shellCommand !== undefined) {
      const command = shellCommand.trim()
      if (VERIFY_OK_COMMANDS.has(command)) {
        // Guardian deterministic verification 独立执行成功
        return { exitCode: 0, signal: null, stdout: 'ok', stderr: '' }
      }
      return gitRunner(command)
    }
    return { exitCode: 1, signal: null, stdout: '', stderr: 'Unexpected command' }
  }
  return { runner, requests, claudeCall: () => claudeCall }
}

// ============ AskBridge fixture ============

interface AskBridgeFixtureHandler {
  packet: string
  threadLink?: string
}

function createAskBridgeFixture(
  handlers: readonly AskBridgeFixtureHandler[],
): { runner: AskBridgeCommandRunner; requests: AskBridgeCommandRequest[]; verdicts: string[] } {
  const requests: AskBridgeCommandRequest[] = []
  const verdicts: string[] = []
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
    verdicts.push((JSON.parse(handler.packet) as { verdict: string }).verdict)
    const stdout =
      handler.threadLink !== undefined
        ? `${handler.packet}\nThread Link: ${handler.threadLink}`
        : handler.packet
    return { exitCode: 0, stdout, stderr: '' }
  }
  return { runner, requests, verdicts }
}

const TASK_GOAL = 'Create the minimal FastAPI backend.'

// ============ Test Case: permission denial → revise → Guardian verification → done ============

await test('W003 FINAL D: permission denial in deterministic verification → revise, Guardian verifies → COMPLETED', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-deterministic-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    const denials = [
      { tool: 'Bash', operation: '.venv/Scripts/python.exe -m pytest', summary: 'User denied pytest' },
      { tool: 'Bash', operation: 'git diff --check', summary: 'User denied git diff --check' },
    ]
    const claudeFixture = createClaudeFixture(gitRunner, denials)

    const askBridge = createAskBridgeFixture([
      {
        packet: JSON.stringify({
          verdict: 'proceed',
          goal: TASK_GOAL,
          instructions: ['实现最小 FastAPI 后端'],
          constraints: [],
          verification: [],
          do_not_do: [],
          rationale: '开始执行',
        }),
        threadLink: 'https://chatgpt.com/c/dv-recovery-1',
      },
      {
        packet: JSON.stringify({
          verdict: 'revise',
          goal: TASK_GOAL,
          instructions: [
            '不要再让 Claude 执行被拒绝的验证命令；只完成必要的代码修改。',
            'verification 交由 Guardian deterministic verifier 执行。',
          ],
          constraints: [],
          verification: ['.venv/Scripts/python.exe -m pytest', 'git diff --check'],
          do_not_do: [],
          rationale: 'denied verification 属于 Guardian deterministic verification capability',
        }),
        threadLink: 'https://chatgpt.com/c/dv-recovery-1',
      },
      {
        packet: JSON.stringify({
          verdict: 'done',
          goal: TASK_GOAL,
          instructions: [],
          constraints: [],
          verification: ['.venv/Scripts/python.exe -m pytest', 'git diff --check'],
          do_not_do: [],
          rationale: '确定性验证全部通过',
        }),
        threadLink: 'https://chatgpt.com/c/dv-recovery-1',
      },
    ])

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
      maxTurns: 12,
      timeoutMs: 10_000,
      allowPythonBootstrap: true,
      commandRunner: claudeFixture.runner,
    })

    const runner = new GuardianWorkSessionTaskRunner({
      brain,
      createExecutor: () => executor,
      repoPath,
      gitRunner,
      taskBuilder: {
        maxIterations: 10,
        constraints: ['只允许修改 apps/api/**'],
        acceptanceCriteria: ['GET /health 返回结构化 healthy 状态'],
        doNotDo: ['不要 git commit'],
        allowedPaths: ['apps/api/**'],
      },
    })

    const result = await runner.run({ id: 'T002', goal: TASK_GOAL })

    // ===== 全链结果 =====
    assert.strictEqual(result.status, 'COMPLETED', 'must complete via Guardian verification')

    // ===== Reviewer 必须走 revise，不得 blocked =====
    assert.strictEqual(askBridge.requests.length, 3, 'proceed -> revise -> done')
    assert.deepEqual(
      askBridge.verdicts,
      ['proceed', 'revise', 'done'],
      'second review must be revise, not blocked',
    )

    // ===== Claude 调用两次（首次 permission denial + revise 后代码修改）=====
    const claudeCalls = claudeFixture.requests.filter((req) =>
      req.args.join(' ').includes('claude'),
    )
    assert.strictEqual(claudeCalls.length, 2, 'Claude called twice')

    // ===== NO new Claude allowedTools =====
    for (const call of claudeCalls) {
      const args = call.args
      const allowedIndex = args.indexOf('--allowedTools')
      assert.ok(allowedIndex >= 0, 'claude call must have --allowedTools')
      const allowedTools = args.slice(allowedIndex + 1)
      assert.ok(
        !allowedTools.includes('Bash(.venv/Scripts/python.exe -m pytest)'),
        'must NOT add Bash(pytest) to Claude allowedTools',
      )
      assert.ok(
        !allowedTools.includes('Bash(git diff --check)'),
        'must NOT add Bash(git diff --check) to Claude allowedTools',
      )
      assert.ok(
        !allowedTools.some((tool) => tool === 'Bash' || tool === 'Bash(*:*)'),
        'must NOT add generic Bash to Claude allowedTools',
      )
    }

    // ===== Executor 独立执行确定性验证 =====
    const verifyRuns = claudeFixture.requests.filter((req) =>
      isGuardianShellRequest(req) &&
      VERIFY_OK_COMMANDS.has((req.args[1] ?? '').trim()),
    )
    assert.ok(
      verifyRuns.some((req) => (req.args[1] ?? '').includes('.venv/Scripts/python.exe -m pytest')),
      'Guardian must run pytest itself',
    )
    assert.ok(
      verifyRuns.some((req) => (req.args[1] ?? '').includes('git diff --check')),
      'Guardian must run git diff --check itself',
    )
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})

// ============ ExecutionReport 字段断言（不依赖完整循环） ============

await test('W003 FINAL D: ExecutionReport carries deterministicVerificationCapabilities distinct from executorCapabilities', async () => {
  const tempBase = await mkdtemp(join(tmpdir(), 'w003-deterministic-report-'))
  const { repoPath, gitRunner } = await setupTestGitRepo(tempBase)

  try {
    const denials = [
      { tool: 'Bash', operation: '.venv/Scripts/python.exe -m pytest', summary: 'User denied pytest' },
    ]
    const claudeFixture = createClaudeFixture(gitRunner, denials)
    // 只触发一次 execute（single claude call + permission denial），不进入 revise 循环
    const executor = new ClaudeCodeExecutor({
      cwd: repoPath,
      maxTurns: 12,
      timeoutMs: 10_000,
      allowPythonBootstrap: true,
      commandRunner: claudeFixture.runner,
    })

    const report = await executor.execute({
      task: {
        id: 'T002',
        goal: TASK_GOAL,
        state: 'EXECUTING',
        iteration: 1,
        maxIterations: 10,
        allowedPaths: ['apps/api/**'],
      },
      packet: {
        verdict: 'proceed',
        goal: TASK_GOAL,
        instructions: ['实现'],
        constraints: [],
        verification: [],
        doNotDo: [],
      },
    })

    // 首次执行：permission denial → incompleteReason + permissionDenials
    assert.notEqual(report.incompleteReason, undefined, 'must be incomplete after permission denial')
    assert.ok((report.permissionDenials?.length ?? 0) >= 1, 'must include permission denials')
    assert.ok(
      report.permissionDenials?.some((d) => (d.operation ?? '').includes('pytest')),
      'permission denial must reference pytest',
    )

    // deterministicVerificationCapabilities 与 executorCapabilities 分离
    assert.ok(
      report.deterministicVerificationCapabilities !== undefined,
      'must include deterministicVerificationCapabilities',
    )
    assert.ok(
      report.deterministicVerificationCapabilities?.includes('.venv/Scripts/python.exe -m pytest'),
      'deterministic verification must include pytest',
    )
    assert.ok(
      report.deterministicVerificationCapabilities?.includes('git diff --check'),
      'deterministic verification must include git diff --check',
    )

    assert.ok(report.executorCapabilities !== undefined, 'must include executorCapabilities')
    assert.ok(
      !report.executorCapabilities?.includes('.venv/Scripts/python.exe -m pytest'),
      'executor capabilities must NOT include pytest (capability boundary)',
    )
    assert.ok(
      !report.executorCapabilities?.includes('git diff --check'),
      'executor capabilities must NOT include git diff --check (capability boundary)',
    )
  } finally {
    await rm(tempBase, { recursive: true, force: true }).catch(() => {})
  }
})
