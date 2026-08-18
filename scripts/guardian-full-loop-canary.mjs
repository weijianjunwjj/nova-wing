/* global console, process */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  AskBridgeBrain,
  ClaudeCodeExecutor,
  runGuardianTask,
} from 'nova-wing/development-guardian'

const repositoryRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = join(repositoryRoot, '.guardian-workspaces')
const scriptStartedAt = performance.now()
const timings = []
const bridgeDiagnostics = []
let completedBridgeReviews = 0

function roundMs(value) {
  return Math.round(value * 10) / 10
}

function recordTiming(component, phase, durationMs, details = {}) {
  timings.push({
    component,
    phase,
    durationMs: roundMs(durationMs),
    ...details,
  })
}

function recordBridgeDiagnostic(event) {
  bridgeDiagnostics.push({
    review: completedBridgeReviews + 1,
    elapsedMs: roundMs(event.elapsedMs),
    stream: event.stream,
    line: event.line.slice(0, 800),
  })
  if (bridgeDiagnostics.length > 120) {
    bridgeDiagnostics.shift()
  }
}

function run(command, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('bash', ['-lc', 'exec "$@"', '--', command, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-200_000)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-200_000)
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolveRun({ exitCode: null, stdout, stderr: `${stderr}\nTimed out`.trim() })
    }, timeoutMs)

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ exitCode, stdout, stderr })
    })
  })
}

async function mustRun(command, args, cwd) {
  const result = await run(command, args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`,
    )
  }
  return result
}

async function createCanaryRepo() {
  await mkdir(workspaceRoot, { recursive: true })
  const root = await mkdtemp(join(workspaceRoot, 'canary-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'test'), { recursive: true })

  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'novawing-guardian-canary',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(
    join(root, 'src', 'normalize-name.mjs'),
    `export function normalizeName(value) {\n  return value\n}\n`,
    'utf8',
  )

  const fixtureImportPath = ['..', 'src', 'normalize-name.mjs'].join('/')
  const testSource = [
    "import assert from 'node:assert/strict'",
    "import test from 'node:test'",
    '',
    `import { normalizeName } from '${fixtureImportPath}'`,
    '',
    "test('normalizes whitespace and case', () => {",
    "  assert.equal(normalizeName('  Hello   World  '), 'hello-world')",
    "  assert.equal(normalizeName('NOVA WING'), 'nova-wing')",
    "  assert.equal(normalizeName('already-clean'), 'already-clean')",
    '})',
    '',
  ].join('\n')

  await writeFile(join(root, 'test', 'normalize-name.test.mjs'), testSource, 'utf8')

  await mustRun('git', ['init'], root)
  await mustRun('git', ['add', '.'], root)
  await mustRun(
    'git',
    [
      '-c',
      'user.name=NovaWing Canary',
      '-c',
      'user.email=canary@novawing.local',
      'commit',
      '-m',
      'baseline',
    ],
    root,
  )

  const baseline = await run('npm', ['test'], root)
  if (baseline.exitCode === 0) {
    throw new Error('Canary baseline unexpectedly passes; the target must start with a real failing test')
  }

  return root
}

const setupStartedAt = performance.now()
const targetRepo = await createCanaryRepo()
recordTiming('canary', 'setup', performance.now() - setupStartedAt)

const timeoutMs = Number(process.env.NOVAWING_GUARDIAN_TIMEOUT_MS ?? 20 * 60 * 1000)
const chatgptModel = process.env.NOVAWING_CHATGPT_MODEL?.trim() || undefined
const claudeModel = process.env.NOVAWING_CLAUDE_MODEL?.trim() || 'sonnet'
const chatgptReasoning = process.env.NOVAWING_CHATGPT_REASONING?.trim() || 'high'
const diagnosticsEnabled = process.env.NOVAWING_GUARDIAN_DIAGNOSTICS?.trim() !== '0'

const brain = new AskBridgeBrain({
  ...(chatgptModel === undefined ? {} : { model: chatgptModel }),
  reasoning: chatgptReasoning,
  timeoutMs,
  verbose: diagnosticsEnabled,
  onDiagnostic: diagnosticsEnabled ? recordBridgeDiagnostic : undefined,
  onTiming(event) {
    completedBridgeReviews += 1
    recordTiming('chatgpt-web', event.phase, event.durationMs, {
      iteration: event.iteration,
      review: completedBridgeReviews,
    })
  },
})
const executor = new ClaudeCodeExecutor({
  cwd: targetRepo,
  model: claudeModel,
  maxTurns: 10,
  timeoutMs,
  onTiming(event) {
    recordTiming('claude-executor', event.phase, event.durationMs, {
      iteration: event.iteration,
      ...(event.command === undefined ? {} : { command: event.command }),
      ...(event.numTurns === undefined ? {} : { numTurns: event.numTurns }),
      ...(event.totalCostUsd === undefined ? {} : { totalCostUsd: event.totalCostUsd }),
    })
  },
})

const task = {
  id: `guardian-canary-${Date.now()}`,
  goal: '修复金丝雀仓库的 normalizeName(value)：去掉首尾空白，将连续空白折叠为单个短横线，并统一为小写；不得硬编码测试样例。',
  state: 'READY',
  iteration: 0,
  maxIterations: 3,
  constraints: [
    '只允许修改 src/normalize-name.mjs。',
    '测试文件是验收事实，不允许修改测试来让结果变绿。',
    '实现必须是通用逻辑，不得针对现有输入样例硬编码。',
  ],
  acceptanceCriteria: [
    'npm test 通过。',
    'normalizeName 对任意字符串执行 trim、连续空白折叠为单个短横线、转小写。',
  ],
  doNotDo: [
    '不要 git commit。',
    '不要 git push。',
    '不要修改 package.json。',
    '不要修改 test/**。',
  ],
  allowedPaths: ['src/**'],
  forbiddenPaths: ['test/**', 'package.json', '.git/**'],
}

try {
  console.log(
    JSON.stringify(
      {
        phase: 'canary-start',
        targetRepo,
        taskId: task.id,
        diagnostics: {
          enabled: diagnosticsEnabled,
          chatgptReasoning,
          claudeModel,
        },
      },
      null,
      2,
    ),
  )

  const guardianStartedAt = performance.now()
  const result = await runGuardianTask({ task, brain, executor })
  recordTiming('guardian', 'run-total', performance.now() - guardianStartedAt)

  const finalSource = await readFile(join(targetRepo, 'src', 'normalize-name.mjs'), 'utf8')
  const finalTestStartedAt = performance.now()
  const finalTest = await run('npm', ['test'], targetRepo)
  recordTiming('canary', 'independent-final-test', performance.now() - finalTestStartedAt, {
    command: 'npm test',
  })
  recordTiming('canary', 'script-total', performance.now() - scriptStartedAt)

  console.log(
    JSON.stringify(
      {
        phase: 'canary-result',
        targetRepo,
        finalState: result.task.state,
        stopReason: result.task.stopReason ?? null,
        iterations: result.task.iteration,
        timings,
        bridgeDiagnostics,
        reports: result.reports,
        finalSource,
        independentFinalTest: {
          exitCode: finalTest.exitCode,
          stdout: finalTest.stdout,
          stderr: finalTest.stderr,
        },
      },
      null,
      2,
    ),
  )

  process.exitCode = result.task.state === 'COMPLETED' && finalTest.exitCode === 0 ? 0 : 1
} catch (error) {
  recordTiming('canary', 'script-total', performance.now() - scriptStartedAt)
  console.error(
    JSON.stringify(
      {
        phase: 'canary-failed-to-start',
        targetRepo,
        timings,
        bridgeDiagnostics,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  process.exitCode = 1
}
