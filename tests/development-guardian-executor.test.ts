import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ClaudeCodeExecutor,
  createDefaultTenXChatCommand,
  guardianShellCommand,
  NativeGitBashUnavailableError,
  resolveWindowsGitBashExecutable,
  type ClaudeCodeTimingEvent,
  type DelegationPacket,
  type GuardianCommandRequest,
  type GuardianCommandResult,
  type GuardianCommandRunner,
  type GuardianTask,
} from 'nova-wing/development-guardian'
import { guardianShellTestCommand } from './guardian-shell-fixture.js'

function task(iteration = 0, overrides: Partial<GuardianTask> = {}): GuardianTask {
  return {
    id: 'task-1',
    goal: '完成最小修改',
    state: 'EXECUTING',
    iteration,
    maxIterations: 4,
    ...overrides,
  }
}

function packet(verification: readonly string[] = ['npm test']): DelegationPacket {
  return {
    verdict: 'proceed',
    goal: '完成最小修改',
    instructions: ['修改 src/a.ts'],
    constraints: ['只改目标文件'],
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
    result: '已修改目标文件。',
    session_id: 'session-123',
    num_turns: 3,
    total_cost_usd: 0.1,
    duration_ms: 1200,
    duration_api_ms: 900,
    ...overrides,
  })
}

test('Windows shell contract resolves native Git Bash from deployment configuration', () => {
  const command = guardianShellCommand('git status --porcelain', {
    platform: 'win32',
    gitBashPath: 'E:/Tools/Git/bin/bash.exe',
  })

  assert.equal(command.executable, 'E:/Tools/Git/bin/bash.exe')
  assert.deepEqual(command.args, ['-lc', 'git status --porcelain'])
  assert.equal(command.nativeGitBash, true)
  assert.notEqual(command.executable, 'bash')
})

test('Windows shell resolver uses known Git installations but fails closed without one', () => {
  assert.equal(
    resolveWindowsGitBashExecutable({
      env: { ProgramFiles: 'C:/Program Files' },
      pathExists: (path) => path === 'C:/Program Files\\Git\\bin\\bash.exe',
    }),
    'C:/Program Files\\Git\\bin\\bash.exe',
  )
  assert.throws(
    () => guardianShellCommand('git status', { platform: 'win32', env: {}, pathExists: () => false }),
    NativeGitBashUnavailableError,
  )
})

test('Windows shell contract rejects bare Bash and Windows/WSL shim routes', () => {
  for (const gitBashPath of ['bash', 'C:/Windows/System32/bash.exe', 'C:/Users/me/AppData/Local/Microsoft/WindowsApps/bash.exe']) {
    assert.throws(
      () => guardianShellCommand('git status', { platform: 'win32', gitBashPath }),
      NativeGitBashUnavailableError,
    )
  }
})

test('non-Windows shell commands retain Bash compatibility without Windows executable', () => {
  const command = guardianShellCommand('git status --porcelain', {
    platform: 'linux',
    gitBashPath: 'E:/Tools/Git/bin/bash.exe',
  })
  const tenX = createDefaultTenXChatCommand(12_345, { platform: 'darwin' })

  assert.deepEqual(command, { executable: 'bash', args: ['-lc', 'git status --porcelain'] })
  assert.equal(tenX.command, 'npx')
  assert.ok(!tenX.args.join(' ').includes('E:/Tools/Git/bin/bash.exe'))
})

test('Claude invocation forwards argv through the Git Bash -- delimiter', async () => {
  const runner = new QueueRunner([result(''), result(claudeJson()), result(' M src/a.ts\n'), result('diff clean'), result('tests passed')])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    platform: 'win32',
    gitBashPath: 'E:/Tools/Git/bin/bash.exe',
    commandRunner: runner.run,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claude = runner.requests[1]!
  assert.equal(claude.executable, 'E:/Tools/Git/bin/bash.exe')
  assert.deepEqual(claude.args.slice(0, 3), ['-lc', 'exec claude "$@"', '--'])
  assert.equal(claude.args[3], '-p')
  assert.equal(claude.nativeGitBash, true)
})

test('large Claude prompt is streamed over stdin instead of the Windows command line', async () => {
  const runner = new QueueRunner([result(''), result(claudeJson()), result(' M src/a.ts\n'), result('diff clean'), result('tests passed')])
  const handoff = `handoff:${'x'.repeat(12_000)}`
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo', platform: 'win32', gitBashPath: 'E:/Tools/Git/bin/bash.exe',
    commandRunner: runner.run, additionalExecutionContext: handoff,
  })

  await executor.execute({ task: task(), packet: packet() })

  const claude = runner.requests[1]!
  assert.equal(claude.args[3], '-p')
  assert.equal(claude.args[4], '--output-format')
  assert.ok(claude.stdinText?.includes(handoff))
  assert.equal(claude.args.some(arg => arg.includes(handoff)), false)
})

test('large dynamic execution prompt without handoff context also stays out of argv', async () => {
  const runner = new QueueRunner([result(''), result(claudeJson()), result(' M src/a.ts\n'), result('diff clean')])
  const marker = `large-task:${'z'.repeat(70_000)}`
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo', platform: 'win32', gitBashPath: 'E:/Tools/Git/bin/bash.exe', commandRunner: runner.run,
  })

  await executor.execute({ task: task(0, { goal: marker }), packet: { ...packet([]), goal: marker } })

  const claude = runner.requests[1]!
  assert.ok(claude.stdinText?.includes(marker))
  assert.equal(claude.args.some(arg => arg.includes(marker)), false)
  assert.ok(claude.args.every(arg => arg.length < 1_000), 'argv contains only fixed flags and short identifiers')
})

test('missing configured Git Bash fails closed through shell:false process launch', async () => {
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    platform: 'win32',
    gitBashPath: 'Z:/missing/Git/bin/bash.exe',
  })

  await assert.rejects(
    executor.execute({ task: task(), packet: packet() }),
    /Native Git Bash unavailable: the configured Git for Windows bash\.exe could not be started/,
  )
})

test('native Git Bash executor pins nested npm scripts to Git Bash instead of cmd.exe', async () => {
  const executable = 'D:/Git/bin/bash.exe'
  const observed: NodeJS.ProcessEnv[] = []
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    platform: 'win32',
    gitBashPath: executable,
    commandRunner: async (request) => {
      observed.push(request.env ?? {})
      return result(request.args.join(' ').includes('claude') ? claudeJson() : '')
    },
  })
  await executor.execute({ task: task(), packet: packet() })
  assert.ok(observed.length > 0)
  assert.ok(observed.every((env) => env.npm_config_script_shell === executable))
})

test('executor runs Claude Code then deterministic verification', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const timings: ClaudeCodeTimingEvent[] = []
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    onTiming: (event) => timings.push(event),
  })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.deepEqual(report.changedFiles, ['src/a.ts'])
  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    { name: 'npm test', status: 'passed' },
  ])
  assert.deepEqual(report.blockers, [])
  assert.equal(runner.requests[0]?.args.join(' '), '-lc git status --porcelain')
  assert.match(runner.requests[1]?.args.join(' ') ?? '', /claude/)
  assert.equal(runner.requests[3]?.args.join(' '), '-lc git diff --check')
  assert.equal(runner.requests[4]?.args.join(' '), '-lc npm test')
  assert.ok(
    runner.requests.every((request) => request.executable === guardianShellTestCommand('').executable),
    'initial execution and deterministic verification must use the native Git Bash contract',
  )
  assert.deepEqual(
    timings.map((event) => event.phase),
    ['clean-start', 'inspect-changes', 'claude-code', 'verification', 'verification', 'executor-total'],
  )
  const claudeTiming = timings.find((event) => event.phase === 'claude-code')
  assert.equal(claudeTiming?.numTurns, 3)
  assert.equal(claudeTiming?.totalCostUsd, 0.1)
  assert.equal(claudeTiming?.reportedDurationMs, 1200)
  assert.equal(claudeTiming?.apiDurationMs, 900)
  assert.ok(timings.every((event) => event.durationMs >= 0))
})

test('executor refuses autonomous start on dirty worktree', async () => {
  const runner = new QueueRunner([result(' M src/existing.ts\n')])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.equal(report.changedFiles.length, 0)
  assert.match(report.blockers[0] ?? '', /clean worktree/)
  assert.equal(runner.requests.length, 1)
})

test('executor blocks verification command outside MVP allowlist', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(),
    packet: packet(['rm -rf dist']),
  })

  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    {
      name: 'rm -rf dist',
      status: 'skipped',
      details: 'verification command is not in the MVP allowlist',
    },
  ])
  assert.match(report.blockers[0] ?? '', /human approval/)
  assert.equal(runner.requests.length, 4)
})

test('executor runs a strictly scoped Node test command but rejects path and shell escapes', async () => {
  const safe = 'node --test ticketFilters.test.mjs'
  const runner = new QueueRunner([
    result(''), result(claudeJson()), result(' M src/a.ts\n'), result('diff clean'), result('targeted tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })
  const report = await executor.execute({ task: task(), packet: packet([safe]) })
  assert.deepEqual(report.blockers, [])
  assert.equal(report.verificationResults.find((item) => item.name === safe)?.status, 'passed')
  assert.ok(runner.requests.some((request) => request.args.includes(safe)))

  for (const unsafe of ['node --test ../outside.test.mjs', 'node --test ticket.test.mjs && whoami']) {
    const unsafeRunner = new QueueRunner([result(''), result(claudeJson()), result(' M src/a.ts\n'), result('diff clean')])
    const unsafeExecutor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: unsafeRunner.run })
    const unsafeReport = await unsafeExecutor.execute({ task: task(), packet: packet([unsafe]) })
    assert.match(unsafeReport.blockers[0] ?? '', /human approval/u)
    assert.equal(unsafeRunner.requests.some((request) => request.args.includes(unsafe)), false)
  }
})

test('runtime-approved exact verification command is executable only once', async () => {
  const command = 'cd apps/api && ../../.venv/Scripts/python.exe -m alembic upgrade head'
  const runner = new QueueRunner([
    result(''), result(claudeJson()), result(' M src/a.ts\n'), result('diff clean'), result('migration passed'),
    result(claudeJson({ result: 'revised' })), result(' M src/a.ts\n'), result('diff clean'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
    approvedVerificationCommand: command,
  })

  const first = await executor.execute({ task: task(0), packet: packet([command]) })
  const second = await executor.execute({
    task: task(1),
    packet: { ...packet([command]), verdict: 'revise' },
  })

  assert.equal(first.verificationResults.find((item) => item.name === command)?.status, 'passed')
  assert.deepEqual(
    second.verificationResults.find((item) => item.name === command),
    {
      name: command,
      status: 'skipped',
      details: 'verification command is not in the MVP allowlist',
    },
  )
  assert.equal(
    runner.requests.filter((request) => request.args.includes(command)).length,
    1,
  )
  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(
    claudeRequests.every((request) => !request.args.includes(command)),
    'verification approval must not become a Claude shell/tool grant',
  )
})

test('executor stops before verification when changed files leave allowed scope', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n M package.json\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['src/**'] }),
    packet: packet(),
  })

  assert.deepEqual(report.changedFiles, ['src/a.ts', 'package.json'])
  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /outside allowed scope: package.json/)
  assert.equal(runner.requests.length, 3)
})

test('executor stops when changed files enter forbidden scope', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n M migrations/001.sql\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { forbiddenPaths: ['migrations/**'] }),
    packet: packet(),
  })

  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /inside forbidden scope: migrations\/001.sql/)
  assert.equal(runner.requests.length, 3)
})

test('executor resumes same Claude Code session on revise round', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
    result(claudeJson({ result: '已修复。' })),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  await executor.execute({ task: task(0), packet: packet() })
  await executor.execute({ task: task(1), packet: { ...packet(), verdict: 'revise' } })

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2)
  assert.ok(claudeRequests[1]?.args.includes('--resume'))
  assert.ok(claudeRequests[1]?.args.includes('session-123'))
})

test('executor prompt includes hard boundaries and excludes internal fields', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  await executor.execute({
    task: task(3, {
      id: 'task-boundary-test',
      allowedPaths: ['src/**'],
      forbiddenPaths: ['test/**', 'package.json'],
    }),
    packet: {
      verdict: 'proceed',
      goal: '实现用户认证功能',
      instructions: ['在 src/auth.ts 中添加登录方法'],
      constraints: ['必须使用现有 hash 函数'],
      verification: ['npm test'],
      doNotDo: ['不要修改公开 API'],
    },
  })

  const claudeRequest = runner.requests.find((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.ok(claudeRequest !== undefined, 'should have Claude Code request')

  const promptArgIndex = claudeRequest.args.findIndex((entry) => entry === '-p')
  assert.ok(promptArgIndex >= 0, 'should have -p flag')
  const prompt = claudeRequest.args[promptArgIndex + 1] ?? ''

  assert.match(prompt, /实现用户认证功能/, 'prompt must include goal')
  assert.match(prompt, /在 src\/auth\.ts 中添加登录方法/, 'prompt must include instructions')
  assert.match(prompt, /必须使用现有 hash 函数/, 'prompt must include constraints')
  assert.match(prompt, /src\/\*\*/, 'prompt must include allowedPaths')
  assert.match(prompt, /test\/\*\*/, 'prompt must include forbiddenPaths')
  assert.match(prompt, /package\.json/, 'prompt must include forbiddenPaths')
  assert.match(prompt, /不要修改公开 API/, 'prompt must include doNotDo')

  assert.doesNotMatch(prompt, /task-boundary-test/, 'prompt must not include task.id')
  assert.doesNotMatch(prompt, /iteration.*3/, 'prompt must not include task.iteration')
  assert.doesNotMatch(prompt, /npm test/, 'prompt must not include verification command')
})

test('CASE A: executor auto-resumes once on max_turns with valid session', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成所有任务。' })),
    result(' M src/a.ts\n M src/a.test.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.deepEqual(report.changedFiles, ['src/a.ts', 'src/a.test.ts'])
  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    { name: 'npm test', status: 'passed' },
  ])
  assert.deepEqual(report.blockers, [])
  assert.equal(report.summary, '已完成所有任务。')

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2, 'should call Claude twice')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call should use --resume')
  assert.ok(claudeRequests[1]?.args.includes('session-123'), 'second call should use same session')

  const secondMaxTurnsIndex = claudeRequests[1]?.args.findIndex((entry) => entry === '--max-turns')
  assert.ok(secondMaxTurnsIndex !== undefined && secondMaxTurnsIndex >= 0)
  assert.equal(claudeRequests[1]?.args[secondMaxTurnsIndex + 1], '6', 'recovery should use 6 turns')

  const secondPromptIndex = claudeRequests[1]?.args.findIndex((entry) => entry === '-p')
  assert.ok(secondPromptIndex !== undefined && secondPromptIndex >= 0)
  const secondPrompt = claudeRequests[1]?.args[secondPromptIndex + 1] ?? ''
  assert.match(secondPrompt, /继续当前任务/, 'recovery prompt should indicate continuation')
  assert.match(secondPrompt, /保留当前工作区修改/, 'recovery prompt should preserve changes')
  assert.doesNotMatch(secondPrompt, /执行指令/, 'recovery prompt should not repeat full instructions')
})

test('CASE B: executor does not auto-resume when session_id is missing', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', session_id: '', result: '部分完成。' })),
    result(' M src/a.ts\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /没有 session_id/)

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 1, 'should only call Claude once')
})

test('CASE C: executor does not auto-resume when scope violation exists', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M src/a.ts\n M forbidden/file.ts\n'),
  ])
  const executor = new ClaudeCodeExecutor({
    cwd: 'D:/repo',
    commandRunner: runner.run,
  })

  const report = await executor.execute({
    task: task(0, { forbiddenPaths: ['forbidden/**'] }),
    packet: packet(),
  })

  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /inside forbidden scope/)
  assert.match(report.blockers[1] ?? '', /存在 scope violation.*不自动恢复/)

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 1, 'should only call Claude once')
})

test('CASE D: executor does not attempt third recovery after second max_turns', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M src/a.ts\n'),
    result(claudeJson({ subtype: 'error_max_turns', result: '仍未完成。' })),
    result(' M src/a.ts\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.equal(report.verificationResults.length, 0, 'should not run verification on second max_turns')
  assert.equal(report.blockers.length, 0, 'should have no blockers when safe boundaries are intact')
  assert.notEqual(report.incompleteReason, undefined, 'should have incompleteReason')
  assert.match(
    report.incompleteReason ?? '',
    /执行预算耗尽/,
    'incompleteReason should mention budget exhaustion',
  )

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2, 'should call Claude exactly twice')
})

test('CASE E: executor does not use recovery for non-max_turns errors', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_permission_denied', result: '权限不足。' })),
    result(' M src/a.ts\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /not successful: error_permission_denied/)
  assert.doesNotMatch(report.blockers[0] ?? '', /recovery/)

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 1, 'should only call Claude once')
})

test('CASE F: recovery does not trigger clean-worktree gate on legitimate changes', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', result: '部分完成。' })),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成。' })),
    result(' M src/a.ts\n M src/a.test.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.deepEqual(report.changedFiles, ['src/a.ts', 'src/a.test.ts'])
  assert.equal(report.blockers.length, 0)

  const statusRequests = runner.requests.filter(
    (request) =>
      request.args.length >= 2 &&
      request.args[1]?.includes('git status --porcelain') === true,
  )

  assert.equal(statusRequests.length, 3, 'git status: once for clean gate, twice for inspect-changes')
})

test('CASE G: real Claude Code error_max_turns payload triggers auto-resume', async () => {
  const realClaudePayload = JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    num_turns: 13,
    stop_reason: 'tool_use',
    session_id: 'a61507a4-ab5b-4677-a842-7595eb47a902',
    permission_denials: [],
    terminal_reason: 'max_turns',
    errors: ['Reached maximum number of turns (12)'],
  })

  const runner = new QueueRunner([
    result(''),
    result(realClaudePayload),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成所有任务。' })),
    result(' M src/a.ts\n M src/a.test.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({ task: task(), packet: packet() })

  assert.deepEqual(report.changedFiles, ['src/a.ts', 'src/a.test.ts'])
  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    { name: 'npm test', status: 'passed' },
  ])
  assert.deepEqual(report.blockers, [], 'should have no blockers after successful recovery')

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 2, 'should call Claude twice: initial + recovery')
  assert.ok(claudeRequests[1]?.args.includes('--resume'), 'second call should use --resume')
  assert.ok(
    claudeRequests[1]?.args.includes('a61507a4-ab5b-4677-a842-7595eb47a902'),
    'second call should use real session_id',
  )

  const secondMaxTurnsIndex = claudeRequests[1]?.args.findIndex((entry) => entry === '--max-turns')
  assert.ok(secondMaxTurnsIndex !== undefined && secondMaxTurnsIndex >= 0)
  assert.equal(claudeRequests[1]?.args[secondMaxTurnsIndex + 1], '6', 'recovery should use 6 turns')
})

test('CASE H: reused executor can recover max_turns in subsequent execute() calls', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson({ subtype: 'error_max_turns', session_id: 'session-first' })),
    result(' M src/a.ts\n'),
    result(claudeJson({ result: '已完成第一次任务。', session_id: 'session-first' })),
    result(' M src/a.ts\n'),
    result('diff clean'),
    result('tests passed'),
    result(claudeJson({ subtype: 'error_max_turns', result: '第二次达到 max_turns。', session_id: 'session-second' })),
    result(' M src/a.ts\n M src/b.ts\n'),
    result(claudeJson({ result: '第二次 recovery 成功。', session_id: 'session-second' })),
    result(' M src/a.ts\n M src/b.ts\n M src/c.ts\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const firstReport = await executor.execute({ task: task(0), packet: packet() })
  assert.deepEqual(firstReport.blockers, [], 'first execution should succeed after recovery')
  assert.deepEqual(firstReport.changedFiles, ['src/a.ts'])

  const secondReport = await executor.execute({
    task: task(1),
    packet: { ...packet(), verdict: 'revise' },
  })
  assert.deepEqual(secondReport.blockers, [], 'second execution should also succeed after recovery')
  assert.deepEqual(secondReport.changedFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts'])

  const claudeRequests = runner.requests.filter((request) =>
    request.args.some((entry) => entry.includes('claude')),
  )
  assert.equal(claudeRequests.length, 4, 'should call Claude 4 times: first + recovery1 + second + recovery2')
  assert.ok(claudeRequests[1]?.args.includes('session-first'), 'first recovery should use first session')
  assert.ok(claudeRequests[2]?.args.includes('--resume'), 'second execution should resume')
  assert.ok(claudeRequests[2]?.args.includes('session-first'), 'second execution continues first session')
  assert.ok(claudeRequests[3]?.args.includes('session-second'), 'second recovery should use second session')
})

test('CASE UNTRACKED A: untracked files in allowed directory do not produce scope blocker', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result('?? apps/web/index.html\n?? apps/web/src/App.vue\n?? package.json\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['apps/web/**', 'package.json'] }),
    packet: packet(),
  })

  assert.deepEqual(report.changedFiles, ['apps/web/index.html', 'apps/web/src/App.vue', 'package.json'])
  assert.equal(report.blockers.length, 0, 'should have no scope blockers')
  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    { name: 'npm test', status: 'passed' },
  ])

  const statusRequests = runner.requests.filter(
    (request) =>
      request.args.length >= 2 &&
      request.args[1]?.includes('git status --porcelain') === true,
  )
  assert.ok(statusRequests.length >= 1, 'should call git status at least once')
  const inspectStatusRequest = statusRequests.find((request) =>
    request.args[1]?.includes('--untracked-files=all'),
  )
  assert.ok(
    inspectStatusRequest !== undefined,
    'inspect-changes should use --untracked-files=all',
  )
})

test('CASE UNTRACKED B: untracked files outside allowed scope still produce blocker', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result('?? apps/api/main.py\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['apps/web/**'] }),
    packet: packet(),
  })

  assert.deepEqual(report.changedFiles, ['apps/api/main.py'])
  assert.equal(report.verificationResults.length, 0)
  assert.match(report.blockers[0] ?? '', /outside allowed scope: apps\/api\/main\.py/)
})

test('CASE UNTRACKED C: tracked modified files still work correctly', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M apps/web/src/App.vue\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['apps/web/**'] }),
    packet: packet(),
  })

  assert.deepEqual(report.changedFiles, ['apps/web/src/App.vue'])
  assert.equal(report.blockers.length, 0)
  assert.deepEqual(report.verificationResults, [
    { name: 'git diff --check', status: 'passed' },
    { name: 'npm test', status: 'passed' },
  ])
})

// ============ CASE TRACKED ARTIFACT: tracked artifact path 必须进入 scope enforcement ============
// parseChangedFiles 只过滤 untracked 产物；tracked 修改（即使位于 node_modules/.venv/dist）
// 仍进入 changedFiles，且必须接受 allowed scope 检查，不得按目录名 blanket-ignore。

test('CASE TRACKED ARTIFACT A: tracked node_modules change outside allowed scope produces blocker', async () => {
  const runner = new QueueRunner([
    result(''), // ensureCleanStart: git status --porcelain（clean）
    result(claudeJson()),
    result(' M node_modules/pkg/index.js\n'), // readChangedFiles
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['apps/api/**'] }),
    packet: packet(),
  })

  assert.deepEqual(
    report.changedFiles,
    ['node_modules/pkg/index.js'],
    'tracked node_modules change must enter changedFiles',
  )
  assert.equal(report.verificationResults.length, 0, 'scope blocker short-circuits verification')
  assert.match(
    report.blockers[0] ?? '',
    /outside allowed scope: node_modules\/pkg\/index\.js/,
    'tracked node_modules change must be a scope blocker',
  )
})

test('CASE TRACKED ARTIFACT B: tracked .venv and dist changes enter scope enforcement', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M .venv/pyvenv.cfg\n M dist/out.js\n'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['apps/api/**'] }),
    packet: packet(),
  })

  assert.deepEqual(report.changedFiles, ['.venv/pyvenv.cfg', 'dist/out.js'])
  assert.equal(report.blockers.length, 2, 'both tracked artifact changes must be outside allowed scope')
  assert.match(report.blockers[0] ?? '', /outside allowed scope: \.venv\/pyvenv\.cfg/)
  assert.match(report.blockers[1] ?? '', /outside allowed scope: dist\/out\.js/)
})

test('CASE TRACKED ARTIFACT C: untracked artifact files remain filtered from changedFiles', async () => {
  const runner = new QueueRunner([
    result(''),
    result(claudeJson()),
    result(' M apps/api/main.py\n?? node_modules/untracked-pkg/index.js\n?? .venv/Lib/site-packages/foo.py\n'),
    result('diff clean'),
    result('tests passed'),
  ])
  const executor = new ClaudeCodeExecutor({ cwd: 'D:/repo', commandRunner: runner.run })

  const report = await executor.execute({
    task: task(0, { allowedPaths: ['apps/api/**'] }),
    packet: packet(),
  })

  assert.deepEqual(
    report.changedFiles,
    ['apps/api/main.py'],
    'untracked artifacts must stay filtered; allowed tracked change captured',
  )
  assert.equal(report.blockers.length, 0, 'filtered untracked artifacts must not block')
})
