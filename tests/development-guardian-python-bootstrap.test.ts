import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  buildGuardianBrainPrompt,
  type DelegationPacket,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type GuardianCommandRunner,
  type GuardianTask,
} from 'nova-wing/development-guardian'

function task(iteration = 0, overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'task-python-bootstrap',
    goal: 'Bootstrap FastAPI application',
    state: 'EXECUTING',
    iteration,
    maxIterations: 3,
    ...overrides,
  }
}

function packet(verification: readonly string[] = ['.venv/Scripts/python.exe -m pytest']): DelegationPacket {
  return {
    verdict: 'proceed',
    goal: 'Bootstrap FastAPI application',
    instructions: ['创建 FastAPI 项目结构', '实现 GET /health endpoint'],
    constraints: ['只修改 app/ 目录'],
    verification,
    doNotDo: ['不要提交 git'],
  }
}

function result(stdout = '', stderr = '', exitCode = 0): GuardianCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
  }
}

class QueueRunner {
  readonly requests: GuardianCommandRequest[] = []
  readonly queue: GuardianCommandResult[]

  constructor(queue: GuardianCommandResult[]) {
    this.queue = [...queue]
  }

  run: GuardianCommandRunner = async (request) => {
    this.requests.push(request)
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error('fake runner exhausted')
    }
    return next
  }
}

function claudeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '已实现 FastAPI 应用。',
    session_id: 'session-python-test',
    num_turns: 2,
    ...overrides,
  })
}

// CASE A: 默认未开启 Python bootstrap
test('executor does not include Python bootstrap permission by default', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M app/main.py\n M requirements.txt\n'),
    result('diff clean'),
    result('test passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
  assert.ok(allowedToolsIndex >= 0, 'should have --allowedTools flag')

  const tools = claudeRequest.args.slice(allowedToolsIndex + 1)
  assert.ok(
    !tools.includes('Bash(python -m venv .venv)'),
    'should not include python venv permission by default',
  )
  assert.ok(
    !tools.includes('Bash(.venv/Scripts/python.exe -m pip install:*)'),
    'should not include pip install permission by default',
  )
  assert.ok(tools.includes('Read'), 'should include Read permission')
  assert.ok(tools.includes('Write'), 'should include Write permission')
})

// CASE B: allowPythonBootstrap=true 时只新增指定的两个权限
test('executor includes only specified Python bootstrap permissions when enabled', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M app/main.py\n M requirements.txt\n'),
    result('diff clean'),
    result('test passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
  assert.ok(allowedToolsIndex >= 0, 'should have --allowedTools flag')

  const tools = claudeRequest.args.slice(allowedToolsIndex + 1)
  assert.ok(
    tools.includes('Bash(python -m venv .venv)'),
    'should include python venv permission when enabled',
  )
  assert.ok(
    tools.includes('Bash(.venv/Scripts/python.exe -m pip install:*)'),
    'should include pip install permission when enabled',
  )
  assert.ok(!tools.includes('Bash'), 'should not include generic Bash permission')
  assert.ok(!tools.includes('Bash(pip install)'), 'should not include bare pip install')
  assert.ok(!tools.includes('Bash(python -c:*)'), 'should not include python -c')
  assert.ok(!tools.includes('Bash(uv:*)'), 'should not include uv')
  assert.ok(!tools.includes('Bash(poetry:*)'), 'should not include poetry')
  assert.ok(!tools.includes('Bash(conda:*)'), 'should not include conda')
})

// CASE C: max_turn recovery 后仍继承 Python bootstrap 权限
test('executor preserves Python bootstrap permission through recovery', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M app/main.py\n'),
    result(claudeJson({ result: '已完成所有实现。' })),
    result(' M app/main.py\n M requirements.txt\n'),
    result('diff clean'),
    result('test passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2, 'should call Claude twice: initial + recovery')

  for (const claudeRequest of claudeRequests) {
    const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
    assert.ok(allowedToolsIndex >= 0, 'should have --allowedTools flag')

    const tools = claudeRequest.args.slice(allowedToolsIndex + 1)
    assert.ok(
      tools.includes('Bash(python -m venv .venv)'),
      'python venv permission should be preserved through recovery',
    )
    assert.ok(
      tools.includes('Bash(.venv/Scripts/python.exe -m pip install:*)'),
      'pip install permission should be preserved through recovery',
    )
  }
})

// CASE E: Python pytest verification 可以执行并记录结果
test('executor can run Python pytest verification', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M app/main.py\n M tests/test_health.py\n'),
    result('diff clean'),
    result('test passed', '', 0),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  const report = await executor.execute({
    task: task(),
    packet: packet(['.venv/Scripts/python.exe -m pytest']),
  })

  assert.equal(report.verificationResults.length, 2, 'should have 2 verification results')
  const gitDiffCheck = report.verificationResults.find((r) => r.name === 'git diff --check')
  const pytest = report.verificationResults.find((r) => r.name === '.venv/Scripts/python.exe -m pytest')

  assert.ok(gitDiffCheck !== undefined, 'should have git diff --check result')
  assert.equal(gitDiffCheck.status, 'passed', 'git diff --check should pass')

  assert.ok(pytest !== undefined, 'should have pytest result')
  assert.equal(pytest.status, 'passed', 'pytest should pass')
})

// CASE E (variant): pytest verification 失败时记录 failed
test('executor records failed pytest verification', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M app/main.py\n M tests/test_health.py\n'),
    result('diff clean'),
    result('test output', 'test failed: assertion error', 1),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  const report = await executor.execute({
    task: task(),
    packet: packet(['.venv/Scripts/python.exe -m pytest']),
  })

  const pytest = report.verificationResults.find((r) => r.name === '.venv/Scripts/python.exe -m pytest')
  assert.ok(pytest !== undefined, 'should have pytest result')
  assert.equal(pytest.status, 'failed', 'pytest should fail')
  assert.ok(pytest.details !== undefined, 'failed pytest should have details')
})

// CASE F: Brain prompt 明确列出 Python pytest verification
test('brain prompt includes Python pytest in allowed verification commands', () => {
  const task: GuardianTask = {
    id: 'task-python',
    goal: 'Bootstrap FastAPI application',
    state: 'REVIEWING',
    iteration: 0,
    maxIterations: 3,
  }

  const prompt = buildGuardianBrainPrompt({ task })

  assert.ok(prompt.includes('MVP verification 只能从以下命令中选择：'), 'should have verification section')
  assert.ok(prompt.includes('- .venv/Scripts/python.exe -m pytest'), 'should list pytest command')
  assert.ok(prompt.includes('- npm test'), 'should still list npm test')
  assert.ok(prompt.includes('- git diff --check'), 'should still list git diff --check')
})

// CASE G: 确认没有 generic 权限
test('executor never includes generic or disallowed Python commands', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M app/main.py\n'),
    result('diff clean'),
    result('test passed'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const allowedToolsIndex = claudeRequest.args.findIndex((entry) => entry === '--allowedTools')
  const tools = claudeRequest.args.slice(allowedToolsIndex + 1)

  const disallowedPatterns = [
    'Bash',
    'pip install',
    'python -c',
    'uv',
    'poetry',
    'conda',
    'pipenv',
    'activate',
  ]

  for (const pattern of disallowedPatterns) {
    const found = tools.some((tool) => {
      // 允许的工具不应该被误判
      if (tool === 'Bash(python -m venv .venv)') {
        return false
      }
      if (tool === 'Bash(.venv/Scripts/python.exe -m pip install:*)') {
        return false
      }
      if (tool.startsWith('Bash(git ')) {
        return false
      }
      return tool.includes(pattern)
    })
    assert.ok(!found, `should not include generic or disallowed pattern: ${pattern}`)
  }
})

// W003 BOOTSTRAP CLOSURE: changedFiles 与 worktree fingerprint 对 runtime artifact 的语义一致
// 只忽略 untracked 的 node_modules/.venv/dist 产物；tracked 修改始终纳入（不得 blanket-ignore）
test('untracked venv artifacts are excluded from changedFiles; tracked files kept', async () => {
  const runner = new QueueRunner([
    result(''), // ensureCleanStart: git status --porcelain（clean）
    result(claudeJson()),
    result(' M apps/api/main.py\n?? .venv/Scripts/python.exe\n?? .venv/pyvenv.cfg\n?? .venv/Lib/site-packages/_pytest/__init__.py\n'), // readChangedFiles
    result('diff clean'), // git diff --check
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  const report = await executor.execute({
    task: task(),
    packet: packet([]),
  })

  assert.deepEqual(
    report.changedFiles,
    ['apps/api/main.py'],
    'untracked venv artifacts must be excluded from changedFiles',
  )
})

test('tracked changes under artifact dirs are still captured (no blanket ignore)', async () => {
  const runner = new QueueRunner([
    result(''), // ensureCleanStart: git status --porcelain（clean）
    result(claudeJson()),
    result(' M .venv/pyvenv.cfg\n?? apps/api/new.py\n M node_modules/pkg/index.js\n'), // readChangedFiles
    result('diff clean'), // git diff --check
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    allowPythonBootstrap: true,
  })

  const report = await executor.execute({
    task: task(),
    packet: packet([]),
  })

  assert.deepEqual(
    report.changedFiles,
    ['.venv/pyvenv.cfg', 'apps/api/new.py', 'node_modules/pkg/index.js'],
    'tracked changes under artifact dirs must be captured',
  )
})
