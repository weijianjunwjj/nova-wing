import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AskBridgeBrain,
  RetryableGuardianBrainError,
  runGuardianTask,
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
  await writeResponse(request, packet)
}

async function writeResponse(request: AskBridgeCommandRequest, response: string): Promise<void> {
  const outputIndex = request.args.indexOf('--output')
  const outputPath = outputIndex >= 0 ? request.args[outputIndex + 1] : undefined
  assert.ok(outputPath)
  await writeFile(outputPath, response, 'utf8')
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

test('ask-bridge brain marks only malformed JSON after a successful transport as retryable protocol failure', async () => {
  const rawResponse = '{"verdict":"proceed","goal":"contains a secret-looking value: do-not-log"'
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({ exitCode: 0, stdout: rawResponse, stderr: '' }),
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.kind === 'protocol' &&
      error.message === 'reviewer returned malformed Guardian JSON' &&
      !error.message.includes('do-not-log'),
  )
})

test('ask-bridge protocol retry reuses the Thread Link captured before malformed JSON', async () => {
  const sessionUrl = 'https://chatgpt.com/c/protocol-retry-session'
  const requests: AskBridgeCommandRequest[] = []
  let calls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async (request) => {
      requests.push(request)
      calls += 1
      await writeResponse(request, calls === 1 ? '{"verdict":"proceed"' : packet)
      return { exitCode: 0, stdout: `Thread Link: ${sessionUrl}`, stderr: '' }
    },
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) => error instanceof RetryableGuardianBrainError && error.kind === 'protocol',
  )
  const result = await brain.review({ task })

  assert.equal(result.verdict, 'proceed')
  assert.equal(requests[0]?.args.includes('--new'), true)
  const retrySessionIndex = requests[1]?.args.indexOf('--session-url') ?? -1
  assert.ok(retrySessionIndex >= 0)
  assert.equal(requests[1]?.args[retrySessionIndex + 1], sessionUrl)
  assert.equal(requests[1]?.args.includes('--new'), false)
})

test('guardian protocol retry keeps the AskBridge Thread Link through final review', async () => {
  const sessionUrl = 'https://chatgpt.com/c/guardian-protocol-retry-session'
  const donePacket = JSON.stringify({
    verdict: 'done',
    goal: '完成最小任务',
    instructions: [],
    constraints: ['不得越界'],
    verification: ['npm test'],
    do_not_do: ['不要提交'],
  })
  const requests: AskBridgeCommandRequest[] = []
  const responses = ['{"verdict":"proceed"', packet, donePacket]
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async (request) => {
      requests.push(request)
      const response = responses.shift()
      assert.ok(response)
      await writeResponse(request, response)
      return { exitCode: 0, stdout: `Thread Link: ${sessionUrl}`, stderr: '' }
    },
  })

  const result = await runGuardianTask({
    task,
    brain,
    executor: {
      async execute() {
        return {
          summary: 'executor completed',
          changedFiles: [],
          commandsRun: ['npm test'],
          verificationResults: [{ name: 'npm test', status: 'passed' as const }],
          blockers: [],
        }
      },
    },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })

  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(requests.length, 3)
  assert.equal(requests[0]?.args.includes('--new'), true)
  for (const request of requests.slice(1)) {
    const sessionIndex = request.args.indexOf('--session-url')
    assert.ok(sessionIndex >= 0)
    assert.equal(request.args[sessionIndex + 1], sessionUrl)
    assert.equal(request.args.includes('--new'), false)
  }
})

test('ask-bridge brain does not make valid JSON packet-contract failures retryable', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({ exitCode: 0, stdout: '{"verdict":"proceed"}', stderr: '' }),
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) => !(error instanceof RetryableGuardianBrainError),
  )
})

test('ask-bridge rotation resets only one Task and records the fresh conversation', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const newUrl = 'https://chatgpt.com/c/new-task-session'
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return { exitCode: 0, stdout: `Thread Link: ${newUrl}`, stderr: '' }
    },
  })
  const otherUrl = 'https://chatgpt.com/c/other-task-session'
  brain.restoreProviderState({
    taskConversationUrls: {
      'task-1': 'https://chatgpt.com/c/old-task-session',
      'task-2': otherUrl,
    },
    reviewedTaskIds: ['task-1', 'task-2'],
  })

  brain.resetTaskReviewSession('task-1')
  const resetState = brain.captureProviderState()
  assert.equal(resetState.taskConversationUrls['task-1'], undefined)
  assert.equal(resetState.reviewedTaskIds.includes('task-1'), false)
  assert.equal(resetState.taskConversationUrls['task-2'], otherUrl)
  assert.equal(resetState.reviewedTaskIds.includes('task-2'), true)

  await brain.review({ task })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.args.includes('--new'), true)
  assert.equal(requests[0]?.args.includes('--session-url'), false)
  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  const freshState = brain.captureProviderState()
  assert.equal(freshState.taskConversationUrls['task-1'], newUrl)
  assert.equal(Object.values(freshState.taskConversationUrls).includes('https://chatgpt.com/c/old-task-session'), false)
  assert.equal(freshState.taskConversationUrls['task-2'], otherUrl)
})

test('ask-bridge rotation never restores the old URL after the fresh review times out', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({ exitCode: null, stdout: '', stderr: '' }),
  })
  brain.restoreProviderState({
    taskConversationUrls: { 'task-1': 'https://chatgpt.com/c/old-task-session' },
    reviewedTaskIds: ['task-1'],
  })

  brain.resetTaskReviewSession('task-1')
  await assert.rejects(brain.review({ task }), RetryableGuardianBrainError)

  const state = brain.captureProviderState()
  assert.equal(state.taskConversationUrls['task-1'], undefined)
  assert.equal(state.reviewedTaskIds.includes('task-1'), false)
})

test('ask-bridge rotation overrides an initially fixed conversation for that Task', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    conversationUrl: 'https://chatgpt.com/c/initial-fixed-session',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/fresh-session', stderr: '' }
    },
  })

  brain.resetTaskReviewSession('task-1')
  await brain.review({ task })

  assert.equal(requests[0]?.args.includes('--new'), true)
  assert.equal(requests[0]?.args.includes('--session-url'), false)
  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(brain.captureProviderState().taskConversationUrls['task-1'], 'https://chatgpt.com/c/fresh-session')
})
