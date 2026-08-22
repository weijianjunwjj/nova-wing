import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AskBridgeBrain,
  RetryableGuardianBrainError,
  type AskBridgeCommandRequest,
  type AskBridgeCommandRunner,
  type AskBridgeOutputEvent,
  type AskBridgeTimingEvent,
} from 'nova-wing/development-guardian'

const packet = JSON.stringify({
  verdict: 'proceed',
  goal: '完成最小任务',
  instructions: ['修改目标文件'],
  constraints: ['不得越界'],
  verification: ['npm test'],
  do_not_do: ['不要提交'],
  rationale: '目标明确',
})

const task = {
  id: 'task-1',
  goal: '完成最小任务',
  state: 'READY' as const,
  iteration: 0,
  maxIterations: 3,
}

async function writePacket(request: AskBridgeCommandRequest): Promise<void> {
  const outputIndex = request.args.indexOf('--output')
  const outputPath = outputIndex >= 0 ? request.args[outputIndex + 1] : undefined
  assert.ok(outputPath)
  await writeFile(outputPath, packet, 'utf8')
}

test('ask-bridge brain drives fixed ChatGPT session and parses packet from output file', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const runner: AskBridgeCommandRunner = async (request) => {
    requests.push(request)
    await writePacket(request)
    return {
      exitCode: 0,
      stdout: `${packet}\nThread Link: https://chatgpt.com/c/test-session`,
      stderr: '',
    }
  }
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    conversationUrl: 'https://chatgpt.com/c/test-session',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    headless: false,
    timeoutMs: 120_000,
    commandRunner: runner,
  })

  const result = await brain.review({ task })

  assert.equal(result.verdict, 'proceed')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.executable, 'ask-bridge.exe')
  assert.deepEqual(requests[0]?.args.slice(0, 11), [
    '--provider',
    'chatgpt',
    '--headless=false',
    '--session-url',
    'https://chatgpt.com/c/test-session',
    '--model',
    'GPT-5.6 Sol',
    '--reasoning',
    'high',
    '--timeout',
    '120',
  ])
  assert.ok(requests[0]?.args.includes('--output'))
  assert.match(requests[0]?.args.at(-1) ?? '', /唯一 Brain/)
})

test('ask-bridge brain creates a new task conversation then resumes the exact session without resetting model options', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const sessionUrl = 'https://chatgpt.com/c/task-session'
  const runner: AskBridgeCommandRunner = async (request) => {
    requests.push(request)
    await writePacket(request)
    return {
      exitCode: 0,
      stdout: `${packet}\nThread Link: ${sessionUrl}`,
      stderr: '',
    }
  }
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: runner,
  })

  await brain.review({ task })
  await brain.review({
    task: { ...task, state: 'REVIEWING', iteration: 1 },
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.args.includes('--new'), true)
  assert.equal(requests[0]?.args.includes('--session-url'), false)
  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)

  const secondSessionIndex = requests[1]?.args.indexOf('--session-url') ?? -1
  assert.ok(secondSessionIndex >= 0)
  assert.equal(requests[1]?.args[secondSessionIndex + 1], sessionUrl)
  assert.equal(requests[1]?.args.includes('--new'), false)
  assert.equal(requests[1]?.args.includes('--model'), false)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
})

test('ask-bridge brain refuses to silently switch conversation inside one task', async () => {
  let call = 0
  const runner: AskBridgeCommandRunner = async (request) => {
    call += 1
    await writePacket(request)
    return {
      exitCode: 0,
      stdout:
        call === 1
          ? 'Thread Link: https://chatgpt.com/c/task-session'
          : 'Thread Link: https://chatgpt.com/c/other-session',
      stderr: '',
    }
  }
  const brain = new AskBridgeBrain({ command: 'ask-bridge.exe', commandRunner: runner })

  await brain.review({ task })
  await assert.rejects(
    brain.review({ task: { ...task, state: 'REVIEWING', iteration: 1 } }),
    /switched ChatGPT conversation unexpectedly/,
  )
})

test('ask-bridge brain exposes verbose diagnostics and command timing', async () => {
  const diagnostics: AskBridgeOutputEvent[] = []
  const timings: AskBridgeTimingEvent[] = []
  const runner: AskBridgeCommandRunner = async (request) => {
    request.onOutput?.({ stream: 'stdout', elapsedMs: 12.5, line: 'Checking open Chrome tabs...' })
    await writePacket(request)
    return { exitCode: 0, stdout: packet, stderr: '' }
  }
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    verbose: true,
    commandRunner: runner,
    onDiagnostic: (event) => diagnostics.push(event),
    onTiming: (event) => timings.push(event),
  })

  const result = await brain.review({ task })

  assert.equal(result.verdict, 'proceed')
  assert.deepEqual(diagnostics, [
    { stream: 'stdout', elapsedMs: 12.5, line: 'Checking open Chrome tabs...' },
  ])
  assert.equal(timings.length, 1)
  assert.equal(timings[0]?.phase, 'bridge-command')
  assert.equal(timings[0]?.taskId, 'task-1')
  assert.equal(timings[0]?.iteration, 0)
  assert.ok((timings[0]?.durationMs ?? -1) >= 0)
})

test('ask-bridge brain falls back to clean stdout when output file is unavailable', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({ exitCode: 0, stdout: packet, stderr: '' }),
  })

  const result = await brain.review({ task })

  assert.equal(result.verdict, 'proceed')
})

test('ask-bridge brain fails closed when bridge exits non-zero', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'Chrome not found',
    }),
  })

  await assert.rejects(brain.review({ task }), /Chrome not found/)
})

test('ask-bridge brain marks only command-runner timeout as retryable', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    timeoutMs: 120_000,
    commandRunner: () => Promise.resolve({ exitCode: null, stdout: '', stderr: '' }),
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.kind === 'timeout' &&
      error.message === 'ChatGPT review timed out after 120000ms',
  )
})
