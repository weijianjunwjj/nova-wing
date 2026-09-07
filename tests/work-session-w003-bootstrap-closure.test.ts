/**
 * W003 FINAL BOOTSTRAP CLOSURE — 完整 Guardian 收敛
 *
 * 真实 V3b 场景回归：
 *  Reviewer proceed → Claude 完成业务代码，但 venv 尚不存在
 *  → Guardian pytest 报 "No such file or directory"
 *  → Reviewer revise（bootstrap delegation，而非 ENVIRONMENT_REQUIRED）
 *  → Claude 执行已授权的 python -m venv .venv + venv pip install
 *  → Guardian deterministic：git diff --check PASS + pytest PASS
 *  → Reviewer done
 *  → Guardian COMPLETED
 *
 * 断言：
 *  - bootstrap 由 Reviewer → Claude 的明确 delegation 触发，Executor 不自举
 *  - 全链 NO new allowedTools（精确工具集合，含已授权的 venv bootstrap）
 *  - revise 轮继续同一 Claude session（--resume）
 *  - 最终 COMPLETED
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  runGuardianTask,
  type DelegationPacket,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type GuardianTask,
} from 'nova-wing/development-guardian'

const EXPECTED_ALLOWED_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(python -m venv .venv)',
  'Bash(.venv/Scripts/python.exe -m pip install:*)',
])

class QueueRunner {
  readonly requests: GuardianCommandRequest[] = []
  private readonly queue: GuardianCommandResult[]

  constructor(queue: GuardianCommandResult[]) {
    this.queue = [...queue]
  }

  run = async (request: GuardianCommandRequest): Promise<GuardianCommandResult> => {
    this.requests.push(request)
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error('test runner queue exhausted')
    }
    return next
  }
}

function result(stdout = '', stderr = '', exitCode = 0): GuardianCommandResult {
  return { exitCode, signal: null, stdout, stderr }
}

function claudeJson(resultText: string, sessionId: string): string {
  return JSON.stringify({
    type: 'success',
    subtype: 'success',
    is_error: false,
    result: resultText,
    session_id: sessionId,
    num_turns: 4,
  })
}

class ScriptedBrain {
  reviews = 0
  constructor(private readonly packets: readonly DelegationPacket[]) {}

  async review(): Promise<DelegationPacket> {
    const packet = this.packets[this.reviews]
    this.reviews += 1
    if (packet === undefined) {
      throw new Error('scripted brain exhausted')
    }
    return packet
  }
}

function task(): GuardianTask {
  return {
    id: 'T-bootstrap-closure',
    goal: 'Create the minimal FastAPI backend',
    state: 'READY',
    iteration: 0,
    maxIterations: 10,
    constraints: ['只允许修改 apps/api/**'],
    acceptanceCriteria: ['GET /health returns structured healthy status'],
    doNotDo: ['不要 git commit', '不要 git push'],
  }
}

test('full Guardian loop converges via Reviewer-delegated venv bootstrap (NOT ENVIRONMENT_REQUIRED)', async () => {
  const packets: DelegationPacket[] = [
    {
      verdict: 'proceed',
      goal: task().goal,
      instructions: ['实现 apps/api 的 FastAPI 后端与 GET /health endpoint'],
      constraints: [],
      verification: ['.venv/Scripts/python.exe -m pytest'],
      doNotDo: [],
    },
    {
      verdict: 'revise',
      goal: task().goal,
      instructions: [
        '先使用已有授权能力执行 python -m venv .venv 创建虚拟环境',
        '再执行 .venv/Scripts/python.exe -m pip install -r apps/api/requirements.txt 安装依赖',
        '不要自己执行 pytest / git diff --check，deterministic verification 交由 Guardian 执行',
      ],
      constraints: [],
      verification: ['.venv/Scripts/python.exe -m pytest'],
      doNotDo: [],
      rationale: 'venv 缺失是 recoverable bootstrap prerequisite，不是环境故障',
    },
    {
      verdict: 'done',
      goal: task().goal,
      instructions: [],
      constraints: [],
      verification: ['.venv/Scripts/python.exe -m pytest'],
      doNotDo: [],
      rationale: 'acceptance criteria satisfied',
    },
  ]

  const runner = new QueueRunner([
    // ---- round 1: proceed ----
    result(''), // ensureCleanStart: git status --porcelain（clean）
    result(claudeJson('业务代码已实现，但 .venv 尚未创建', 'session-bootstrap')),
    result(' M apps/api/main.py\n M apps/api/requirements.txt\n'), // readChangedFiles
    result('diff clean'), // git diff --check
    result('', 'bash: line 1: .venv/Scripts/python.exe: No such file or directory', 1), // pytest venv missing
    // ---- round 2: revise bootstrap ----
    result(claudeJson('已执行 python -m venv .venv 并 pip install -r apps/api/requirements.txt', 'session-bootstrap')),
    result(' M apps/api/main.py\n M apps/api/requirements.txt\n?? .venv/\n'), // readChangedFiles
    result('diff clean'), // git diff --check
    result('tests passed', '', 0), // pytest now passes
  ])

  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })
  const brain = new ScriptedBrain(packets)

  const resultRun = await runGuardianTask({ task: task(), brain, executor })

  assert.strictEqual(resultRun.task.state, 'COMPLETED', 'Guardian task must complete')
  assert.strictEqual(resultRun.reports.length, 2, 'exactly two execution rounds')
  assert.strictEqual(brain.reviews, 3, 'proceed + revise + done')

  const firstPytest = resultRun.reports[0]?.verificationResults.find(
    (r) => r.name === '.venv/Scripts/python.exe -m pytest',
  )
  assert.ok(firstPytest !== undefined, 'round 1 must include pytest verification')
  assert.strictEqual(firstPytest.status, 'failed', 'round 1 pytest fails: venv missing')

  const secondPytest = resultRun.reports[1]?.verificationResults.find(
    (r) => r.name === '.venv/Scripts/python.exe -m pytest',
  )
  assert.ok(secondPytest !== undefined, 'round 2 must include pytest verification')
  assert.strictEqual(secondPytest.status, 'passed', 'round 2 pytest passes after bootstrap')

  // bootstrap 由 Reviewer delegation 触发，不是 Executor 自举：包级没有任何 auto-bootstrap 逻辑，
  // Claude 只在收到 revise packet 的 venv 指令后才 bootstrap。
  const claudeRequests = runner.requests.filter((req) => req.args.some((entry) => entry.includes('claude')))
  assert.strictEqual(claudeRequests.length, 2, 'Claude called once per execution round')

  // NO new allowedTools：每个 claude 请求的 --allowedTools 精确等于既有授权集合
  for (const claudeRequest of claudeRequests) {
    const args = claudeRequest.args
    const toolsIndex = args.indexOf('--allowedTools')
    assert.ok(toolsIndex >= 0, 'must carry --allowedTools')
    const tools = args.slice(toolsIndex + 1)
    assert.deepEqual(
      new Set(tools),
      EXPECTED_ALLOWED_TOOLS,
      'allowedTools must be exactly the pre-approved set (NO new allowedTools)',
    )
  }

  // revise 轮继续同一 Claude session（--resume）
  const reviseArgs = claudeRequests[1]?.args
  assert.ok(reviseArgs !== undefined)
  const resumeIndex = reviseArgs.indexOf('--resume')
  assert.ok(resumeIndex >= 0, 'revise round must --resume the same Claude session')
  assert.strictEqual(reviseArgs[resumeIndex + 1], 'session-bootstrap', 'resume must use round-1 session id')
})
