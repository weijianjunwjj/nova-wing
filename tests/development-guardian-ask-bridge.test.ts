import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AskBridgeBrain,
  createAskBridgeCommandRunner,
  GuardianBrainInfrastructureError,
  RetryableGuardianBrainError,
  normalizeAskBridgeDiagnostics,
  runGuardianTask,
  terminateAskBridgeProcessTree,
  type AskBridgeCommandRequest,
  type AskBridgeCommandRunner,
  type AskBridgeOutputEvent,
  type AskBridgeTimingEvent,
  type AskBridgeConfigurationStatus,
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

test('sticky provider configuration is reused by a second Task and its new conversation', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return {
        exitCode: 0,
        stdout: `Thread Link: https://chatgpt.com/c/sticky-task-${String(requests.length)}`,
        stderr: '',
      }
    },
  })

  await brain.review({ task })
  assert.equal(brain.captureConfigurationStatus('task-1')?.actualModel, 'GPT-5.6 Sol')
  assert.equal(brain.captureConfigurationStatus('task-1')?.actualReasoning, 'high')
  await brain.review({ task: { ...task, id: 'task-2' } })

  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(requests[0]?.args[requests[0]!.args.indexOf('--reasoning') + 1], 'high')
  assert.equal(requests[1]?.args.includes('--new'), true)
  assert.equal(requests[1]?.args.includes('--model'), false)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
  assert.equal(brain.captureConfigurationStatus('task-2')?.actualReasoning, 'high')
})

test('sticky high prevents a later Task from reaching a missing reasoning picker', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      if (requests.length > 1 && request.args.includes('--reasoning')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'reasoning-switch-failed: ChatGPT picker not found',
        }
      }
      await writePacket(request)
      return {
        exitCode: 0,
        stdout: `Thread Link: https://chatgpt.com/c/no-picker-task-${String(requests.length)}`,
        stderr: '',
      }
    },
  })

  await brain.review({ task })
  const result = await brain.review({ task: { ...task, id: 'task-2' } })

  assert.equal(result.verdict, 'proceed')
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
})

test('ask-bridge brain classifies a switched Thread Link as a stale conversation', async () => {
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
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.kind === 'conversation' &&
      error.failure.failureType === 'BRAIN_CONVERSATION_MISMATCH' &&
      error.failure.fingerprint === 'brain-conversation:mismatch' &&
      !error.message.includes('https://'),
  )
  const state = brain.captureProviderState()
  assert.equal(state.taskConversationUrls['task-1'], undefined)
  assert.deepEqual(state.staleTaskIds, ['task-1'])
})

test('missing continuation rotates to a fresh Reviewer conversation', async () => {
  const requests: AskBridgeCommandRequest[] = []
  let calls = 0
  let executorCalls = 0
  const donePacket = JSON.stringify({
    verdict: 'done', goal: '完成最小任务', instructions: [], constraints: ['不得越界'],
    verification: ['npm test'], do_not_do: ['不要提交'],
  })
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      calls += 1
      await writeResponse(request, calls === 1 ? packet : donePacket)
      return calls === 1
        ? { exitCode: 0, stdout: packet, stderr: '' }
        : { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/fresh-missing-session', stderr: '' }
    },
  })

  await brain.review({ task })
  const result = await runGuardianTask({
    task: {
      ...task,
      state: 'REVIEWING',
      iteration: 1,
      lastReport: {
        summary: 'executor evidence', changedFiles: ['src/recovered.ts'], commandsRun: ['npm test'],
        verificationResults: [{ name: 'npm test', status: 'passed' }], blockers: [],
      },
    },
    brain,
    executor: { async execute() { executorCalls += 1; throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })

  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(executorCalls, 0)
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.args.includes('--new'), true)
  assert.equal(requests[1]?.args.includes('--session-url'), false)
})

test('conversation mismatch rotates once with the complete recovered Review context and fenced JSON', async () => {
  const requests: AskBridgeCommandRequest[] = []
  let executorCalls = 0
  const donePacket = JSON.stringify({
    verdict: 'done', goal: 'preserve trusted task', instructions: [], constraints: ['keep constraint'],
    verification: ['npm test'], do_not_do: ['do not widen scope'],
  })
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async (request) => {
      requests.push(request)
      await writeResponse(request, requests.length === 1 ? donePacket : `\n\`\`\`json\n${donePacket}\n\`\`\`\n`)
      return {
        exitCode: 0,
        stdout: requests.length === 1
          ? 'Thread Link: https://chatgpt.com/c/wrong-task-session'
          : 'Thread Link: https://chatgpt.com/c/fresh-reviewer-session',
        stderr: '',
      }
    },
  })
  brain.restoreProviderState({
    taskConversationUrls: { 'task-1': 'https://chatgpt.com/c/stale-reviewer-session' },
    reviewedTaskIds: ['task-1'],
  })
  const recoveredTask = {
    ...task,
    state: 'REVIEWING' as const,
    iteration: 2,
    constraints: ['keep constraint'],
    acceptanceCriteria: ['tests pass'],
    doNotDo: ['do not widen scope'],
    allowedPaths: ['src/**'],
    forbiddenPaths: ['**/.env'],
    recoveryContinuation: true,
    lastReport: {
      summary: 'executor evidence is retained',
      changedFiles: ['src/recovered.ts'],
      commandsRun: ['npm test'],
      verificationResults: [{ name: 'npm test', status: 'passed' as const }],
      blockers: [],
    },
  }

  const result = await runGuardianTask({
    task: recoveredTask,
    brain,
    executor: { async execute() { executorCalls += 1; throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })

  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(executorCalls, 0)
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.args.includes('--session-url'), true)
  assert.equal(requests[1]?.args.includes('--new'), true)
  assert.equal(requests[1]?.args.includes('--session-url'), false)
  const freshPrompt = requests[1]?.args.at(-1) ?? ''
  assert.match(freshPrompt, /"id":"task-1"/)
  assert.match(freshPrompt, /"iteration":2/)
  assert.match(freshPrompt, /"allowed_paths":\["src\/\*\*"\]/)
  assert.match(freshPrompt, /"forbidden_paths":\["\*\*\/\.env"\]/)
  assert.match(freshPrompt, /"summary":"executor evidence is retained"/)
  assert.deepEqual(result.task.lastReport, recoveredTask.lastReport)
  const state = brain.captureProviderState()
  assert.equal(state.taskConversationUrls['task-1'], 'https://chatgpt.com/c/fresh-reviewer-session')
  assert.deepEqual(state.staleTaskIds, [])
})

test('provider continuation rejection is typed and marks the old conversation stale', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: 'Reviewer conversation not found; continuation rejected',
    }),
  })
  brain.restoreProviderState({
    taskConversationUrls: { 'task-1': 'https://chatgpt.com/c/rejected-session' },
    reviewedTaskIds: ['task-1'],
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.kind === 'conversation' &&
      error.failure.failureType === 'BRAIN_CONVERSATION_MISMATCH' &&
      error.failure.fingerprint === 'brain-conversation:rejected',
  )
  assert.deepEqual(brain.captureProviderState().staleTaskIds, ['task-1'])
})

test('conversation rotation is bounded and never invokes Executor', async () => {
  let reviews = 0
  let rotations = 0
  let executorCalls = 0
  const result = await runGuardianTask({
    task,
    brain: {
      async review() {
        reviews += 1
        throw new RetryableGuardianBrainError(
          'Reviewer conversation cannot be continued safely',
          'conversation',
          {
            failureType: 'BRAIN_CONVERSATION_MISMATCH',
            fingerprint: 'brain-conversation:mismatch',
          },
        )
      },
      resetTaskReviewSession() { rotations += 1 },
    },
    executor: { async execute() { executorCalls += 1; throw new Error('must not execute') } },
    maxBrainReviewRetries: 5,
    maxBrainReviewSessionRotations: 1,
  })

  assert.equal(reviews, 2)
  assert.equal(rotations, 1)
  assert.equal(executorCalls, 0)
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.equal(result.task.brainFailure?.failureType, 'BRAIN_CONVERSATION_MISMATCH')
  assert.equal(result.task.brainFailure?.attempt, 2)
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

test('ask-bridge brain marks command-runner timeout as retryable', async () => {
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

test('Guardian remaining budget overrides the configured AskBridge timeout for one operation', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    timeoutMs: 180_000,
    commandRunner: (request) => {
      requests.push(request)
      return Promise.resolve({ exitCode: null, stdout: '', stderr: '' })
    },
  })

  await assert.rejects(
    brain.review({ task, transportTimeoutMs: 75_000 }),
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.message === 'ChatGPT review timed out after 75000ms',
  )
  const request = requests[0]
  assert.ok(request)
  assert.equal(request.timeoutMs <= 75_000, true)
  const timeoutIndex = request.args.indexOf('--timeout')
  assert.equal(request.args[timeoutIndex + 1], '75')
})

test('AskBridge timeout waits for cleanup of only the spawned process', async () => {
  let cleanedPid: number | undefined
  const runner = createAskBridgeCommandRunner({
    terminateProcessTree: async (child) => {
      cleanedPid = child.pid
      child.kill()
    },
  })

  const result = await runner({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 1000)'],
    timeoutMs: 25,
  })

  assert.equal(result.exitCode, null)
  assert.equal(typeof cleanedPid, 'number')
  assert.match(result.stderr, /timed out after 25ms/u)
})

test('Windows AskBridge cleanup targets the exact spawned PID tree', async () => {
  const treeKillPids: number[] = []
  let directKills = 0
  const child = {
    pid: 4242,
    kill() { directKills += 1; return true },
  } as unknown as ChildProcess

  await terminateAskBridgeProcessTree(child, {
    platform: 'win32',
    windowsTreeKill: async (pid) => {
      treeKillPids.push(pid)
      return true
    },
  })

  assert.deepEqual(treeKillPids, [4242])
  assert.equal(directKills, 0)
})

test('Finding #11: AskBridge newly-opened-tab transport failure is retryable', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr:
        'Error opening ChatGPT session: Could not identify the newly opened tab; existing tabs were preserved',
    }),
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.kind === 'transport' &&
      error.message.includes('Could not identify the newly opened tab'),
  )
})

test('Finding #11: unknown and credential AskBridge failures are not transport-retryable', async () => {
  for (const stderr of [
    'arbitrary unknown AskBridge failure',
    'Error opening ChatGPT session: authentication required for provider account',
    'Error opening ChatGPT session: 403 Insufficient account balance',
    'browser executable not found',
  ]) {
    const brain = new AskBridgeBrain({
      command: 'ask-bridge.exe',
      commandRunner: () => Promise.resolve({ exitCode: 1, stdout: '', stderr }),
    })

    await assert.rejects(
      brain.review({ task }),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof RetryableGuardianBrainError) &&
        error.message.includes(stderr),
    )
  }
})

test('Finding #11: real tab failure uses bounded retry then session rotation and completes', async () => {
  const tabFailure =
    'Error opening ChatGPT session: Could not identify the newly opened tab; existing tabs were preserved'
  const donePacket = JSON.stringify({
    verdict: 'done',
    goal: '完成最小任务',
    instructions: [],
    constraints: ['不得越界'],
    verification: ['npm test'],
    do_not_do: ['不要提交'],
  })
  const requests: AskBridgeCommandRequest[] = []
  let calls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async (request) => {
      requests.push(request)
      calls += 1
      if (calls <= 2) {
        return { exitCode: 1, stdout: '', stderr: tabFailure }
      }
      await writeResponse(request, calls === 3 ? packet : donePacket)
      return {
        exitCode: 0,
        stdout: 'Thread Link: https://chatgpt.com/c/rotated-tab-session',
        stderr: '',
      }
    },
  })
  const resetTaskIds: string[] = []
  const resetTaskReviewSession = brain.resetTaskReviewSession.bind(brain)
  brain.resetTaskReviewSession = (taskId) => {
    resetTaskIds.push(taskId)
    resetTaskReviewSession(taskId)
  }

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
  assert.equal(requests.length, 4)
  assert.deepEqual(resetTaskIds, ['task-1'])
  assert.equal(requests[2]?.args.includes('--new'), true)
  const finalSessionIndex = requests[3]?.args.indexOf('--session-url') ?? -1
  assert.ok(finalSessionIndex >= 0)
  assert.equal(requests[3]?.args[finalSessionIndex + 1], 'https://chatgpt.com/c/rotated-tab-session')
})

test('Finding #11: tab-failure retry and rotation budgets exhaust without a fourth call', async () => {
  const tabFailure =
    'Error opening ChatGPT session: Could not identify the newly opened tab; existing tabs were preserved'
  let calls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => {
      calls += 1
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: tabFailure })
    },
  })
  const resetTaskIds: string[] = []
  const resetTaskReviewSession = brain.resetTaskReviewSession.bind(brain)
  brain.resetTaskReviewSession = (taskId) => {
    resetTaskIds.push(taskId)
    resetTaskReviewSession(taskId)
  }

  const result = await runGuardianTask({
    task,
    brain,
    executor: { async execute() { throw new Error('must not execute') } },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 1,
  })

  assert.equal(calls, 3)
  assert.deepEqual(resetTaskIds, ['task-1'])
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.match(result.task.stopReason ?? '', /Could not identify the newly opened tab/)
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
      error.failure.fingerprint === 'brain-protocol:json-format' &&
      !error.message.includes('do-not-log'),
  )
})

test('malformed AskBridge JSON exhausts the bounded retry then suspends without Executor', async () => {
  let bridgeCalls = 0
  let executorCalls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async (request) => {
      bridgeCalls += 1
      await writeResponse(request, '{"verdict":"proceed"')
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/bounded-protocol-retry', stderr: '' }
    },
  })

  const result = await runGuardianTask({
    task,
    brain,
    executor: {
      async execute() {
        executorCalls += 1
        throw new Error('must not execute after invalid Brain response')
      },
    },
    maxBrainReviewRetries: 1,
    maxBrainReviewSessionRotations: 0,
  })

  assert.equal(bridgeCalls, 2)
  assert.equal(executorCalls, 0)
  assert.equal(result.task.state, 'BRAIN_INFRASTRUCTURE_FAILED')
  assert.equal(result.task.brainFailure?.category, 'PROTOCOL')
  assert.equal(result.task.brainFailure?.failureType, 'BRAIN_RESPONSE_INVALID')
  assert.equal(result.task.brainFailure?.fingerprint, 'brain-protocol:json-format')
  assert.equal(result.task.brainFailure?.attempt, 2)
})

test('ask-bridge protocol retry reuses the Thread Link captured before malformed JSON', async () => {
  const sessionUrl = 'https://chatgpt.com/c/protocol-retry-session'
  const requests: AskBridgeCommandRequest[] = []
  let calls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
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
  const result = await brain.review({ task, protocolRepair: true })

  assert.equal(result.verdict, 'proceed')
  assert.equal(requests[0]?.args.includes('--new'), true)
  const retrySessionIndex = requests[1]?.args.indexOf('--session-url') ?? -1
  assert.ok(retrySessionIndex >= 0)
  assert.equal(requests[1]?.args[retrySessionIndex + 1], sessionUrl)
  assert.equal(requests[1]?.args.includes('--new'), false)
  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(requests[1]?.args.includes('--model'), false)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
  assert.doesNotMatch(requests[0]?.args.at(-1) ?? '', /协议修复/)
  assert.match(requests[1]?.args.at(-1) ?? '', /只返回合法 JSON object/)
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
  let executorCalls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
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
        executorCalls += 1
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
  assert.equal(executorCalls, 1)
  assert.equal(requests[0]?.args.includes('--new'), true)
  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  for (const request of requests.slice(1)) {
    const sessionIndex = request.args.indexOf('--session-url')
    assert.ok(sessionIndex >= 0)
    assert.equal(request.args[sessionIndex + 1], sessionUrl)
    assert.equal(request.args.includes('--new'), false)
    assert.equal(request.args.includes('--model'), false)
    assert.equal(request.args.includes('--reasoning'), false)
  }
  assert.doesNotMatch(requests[0]?.args.at(-1) ?? '', /协议修复/)
  assert.match(requests[1]?.args.at(-1) ?? '', /只返回合法 JSON object/)
  assert.doesNotMatch(requests[2]?.args.at(-1) ?? '', /协议修复/)
})

test('recovered final review accepts fenced JSON without invoking Executor again', async () => {
  const donePacket = JSON.stringify({
    verdict: 'done',
    goal: '完成最小任务',
    instructions: [],
    constraints: ['不得越界'],
    verification: ['npm test'],
    do_not_do: ['不要提交'],
  })
  let executorCalls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: async (request) => {
      await writeResponse(request, `\`\`\`json\n${donePacket}\n\`\`\``)
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/recovered-final-review', stderr: '' }
    },
  })

  const result = await runGuardianTask({
    task: {
      ...task,
      state: 'REVIEWING',
      iteration: 1,
      lastReport: {
        summary: 'executor and verification already completed',
        changedFiles: ['src/already-complete.ts'],
        commandsRun: ['npm test'],
        verificationResults: [{ name: 'npm test', status: 'passed' }],
        blockers: [],
      },
    },
    brain,
    executor: {
      async execute() {
        executorCalls += 1
        throw new Error('recovered Brain review must not rerun Executor')
      },
    },
    maxBrainReviewRetries: 1,
  })

  assert.equal(result.task.state, 'COMPLETED')
  assert.equal(result.task.iteration, 1)
  assert.equal(executorCalls, 0)
  assert.deepEqual(result.task.lastReport?.changedFiles, ['src/already-complete.ts'])
})

test('ask-bridge keeps valid JSON packet-contract failures strict and non-retryable', async () => {
  const invalidContract = JSON.stringify({
    verdict: 'proceed',
    goal: '完成最小任务',
    instructions: 'forbidden_paths includes **/*credential* as ordinary task text',
    constraints: [],
    verification: [],
    do_not_do: [],
  })
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({ exitCode: 0, stdout: invalidContract, stderr: '' }),
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof GuardianBrainInfrastructureError &&
      !(error instanceof RetryableGuardianBrainError) &&
      error.failure.category === 'PROTOCOL' &&
      error.failure.failureType === 'BRAIN_RESPONSE_INVALID' &&
      error.failure.fingerprint === 'brain-protocol:packet-contract',
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

test('conversation rotation keeps successful provider model and reasoning configuration sticky', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return {
        exitCode: 0,
        stdout: `Thread Link: https://chatgpt.com/c/rotation-${String(requests.length)}`,
        stderr: '',
      }
    },
  })

  await brain.review({ task })
  brain.resetTaskReviewSession(task.id)
  await brain.review({ task })

  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(requests[1]?.args.includes('--new'), true)
  assert.equal(requests[1]?.args.includes('--model'), false)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
})

test('Final Review inherits sticky provider configuration', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return {
        exitCode: 0,
        stdout: 'Thread Link: https://chatgpt.com/c/sticky-final-review',
        stderr: '',
      }
    },
  })

  await brain.review({ task })
  await brain.review({
    task: { ...task, state: 'REVIEWING', iteration: 1 },
    report: {
      summary: 'implementation complete',
      changedFiles: ['src/complete.ts'],
      commandsRun: ['npm test'],
      verificationResults: [{ name: 'npm test', status: 'passed' }],
      blockers: [],
    },
  })

  assert.equal(requests[0]?.args.includes('--model'), true)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(requests[1]?.args.includes('--model'), false)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
})

test('a requested reasoning change is applied once after restoring sticky provider state', async () => {
  const firstBrain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    reasoning: 'high',
    commandRunner: async (request) => {
      await writePacket(request)
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/high-task', stderr: '' }
    },
  })
  await firstBrain.review({ task })

  const requests: AskBridgeCommandRequest[] = []
  const changedBrain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    reasoning: 'medium',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/medium-task', stderr: '' }
    },
  })
  changedBrain.restoreProviderState(firstBrain.captureProviderState())

  await changedBrain.review({ task: { ...task, id: 'task-2' } })

  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(requests[0]?.args[requests[0]!.args.indexOf('--reasoning') + 1], 'medium')
  assert.equal(changedBrain.captureConfigurationStatus('task-2')?.actualReasoning, 'medium')
})

test('an explicit provider configuration resync re-applies otherwise sticky settings', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return {
        exitCode: 0,
        stdout: `Thread Link: https://chatgpt.com/c/resync-${String(requests.length)}`,
        stderr: '',
      }
    },
  })

  await brain.review({ task })
  brain.requestConfigurationResync()
  await brain.review({ task: { ...task, id: 'task-2' } })

  assert.equal(requests[1]?.args.includes('--model'), true)
  assert.equal(requests[1]?.args.includes('--reasoning'), true)
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
  assert.deepEqual(state.staleTaskIds, ['task-1'])
})

test('ask-bridge restart keeps a stale conversation discarded and creates exactly one fresh thread', async () => {
  const staleBrain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    conversationUrl: 'https://chatgpt.com/c/constructor-session',
    commandRunner: async (request) => {
      await writePacket(request)
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/mismatched-session', stderr: '' }
    },
  })
  await assert.rejects(staleBrain.review({ task }), RetryableGuardianBrainError)
  const persisted = staleBrain.captureProviderState()

  const requests: AskBridgeCommandRequest[] = []
  const restoredBrain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    conversationUrl: 'https://chatgpt.com/c/constructor-session',
    commandRunner: async (request) => {
      requests.push(request)
      await writePacket(request)
      return { exitCode: 0, stdout: 'Thread Link: https://chatgpt.com/c/restart-fresh-session', stderr: '' }
    },
  })
  restoredBrain.restoreProviderState(persisted)

  await restoredBrain.review({ task })

  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.args.includes('--new'), true)
  assert.equal(requests[0]?.args.includes('--session-url'), false)
  assert.equal(
    restoredBrain.captureProviderState().taskConversationUrls['task-1'],
    'https://chatgpt.com/c/restart-fresh-session',
  )
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

test('reasoning picker failure degrades once and still sends the Brain prompt with the required model', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const configurations: AskBridgeConfigurationStatus[] = []
  const reasoningFailure = [
    'reasoning-switch-failed:',
    'ChatGPT picker not found;',
    'available options:',
    '能力, 高级, 模型, 推理强度, GPT-5.6 Sol, GPT-5.5, o3',
  ].join('\n')
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    onConfiguration: (status) => configurations.push(status),
    commandRunner: async (request) => {
      requests.push(request)
      if (requests.length === 1) {
        return { exitCode: 1, stdout: '', stderr: reasoningFailure }
      }
      await writePacket(request)
      return {
        exitCode: 0,
        stdout: 'Thread Link: https://chatgpt.com/c/reasoning-degraded',
        stderr: '',
      }
    },
  })

  const result = await brain.review({ task })

  assert.equal(result.verdict, 'proceed')
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.args.includes('--reasoning'), true)
  assert.equal(requests[1]?.args.includes('--reasoning'), false)
  assert.equal(requests[1]?.args.includes('--model'), true)
  assert.equal(requests[1]?.args[requests[1]!.args.indexOf('--model') + 1], 'GPT-5.6 Sol')
  assert.equal(requests[0]?.args.at(-1), requests[1]?.args.at(-1), 'the same Brain prompt must be submitted')
  const status = brain.captureConfigurationStatus('task-1')
  assert.equal(status?.requestedReasoning, 'high')
  assert.equal(status?.actualReasoning, 'unknown')
  assert.equal(status?.actualModel, 'GPT-5.6 Sol')
  assert.equal(status?.degraded, true)
  assert.equal(status?.warning?.fingerprint, 'reasoning-switch:option-not-found')
  assert.ok(status?.warning?.availableOptions.includes('推理强度'))
  assert.ok(configurations.some((value) => value.degraded && value.actualReasoning === 'unknown'))
})

test('required model selection failure remains a hard structured Brain configuration failure', async () => {
  let calls = 0
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    commandRunner: () => {
      calls += 1
      return Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'Error switching model: model selection failed: option not found; available options: GPT-5.5, o3',
      })
    },
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof GuardianBrainInfrastructureError &&
      error.failure.category === 'CONFIGURATION' &&
      error.failure.fingerprint === 'model-selection:option-not-found' &&
      error.failure.requestedModel === 'GPT-5.6 Sol',
  )
  assert.equal(calls, 1, 'model failure must not silently retry without the required model')
})

test('stderr DevTools noise cannot hide a structured root cause written to stdout', async () => {
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    model: 'GPT-5.6 Sol',
    commandRunner: () => Promise.resolve({
      exitCode: 1,
      stdout: 'Error switching model: option not found; available options: GPT-5.5, o3',
      stderr: Array.from(
        { length: 12 },
        () => '[chrome-devtools]\nNo handler registered for issue code PerformanceIssue',
      ).join('\n'),
    }),
  })

  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof GuardianBrainInfrastructureError &&
      error.failure.category === 'CONFIGURATION' &&
      error.failure.fingerprint === 'model-selection:option-not-found' &&
      error.failure.rawError?.includes('PerformanceIssue × 12') === true &&
      error.failure.rawError.includes('Error switching model: option not found'),
  )
})

test('PerformanceIssue noise is collapsed while the real root cause is preserved', () => {
  const noisy = [
    'reasoning switch failed: option not found',
    ...Array.from({ length: 87 }, () => '[chrome-devtools]\nNo handler registered for issue code PerformanceIssue'),
  ].join('\n')

  const normalized = normalizeAskBridgeDiagnostics(noisy)

  assert.match(normalized, /reasoning switch failed: option not found/)
  assert.match(normalized, /PerformanceIssue × 87/)
  assert.equal(normalized.match(/No handler registered/gu)?.length, 1)
  assert.ok(normalized.length < 500)
})

test('T021 combined DevTools noise preserves the Send button transport fingerprint', async () => {
  const stderr = [
    'code PerformanceIssue',
    ...Array.from(
      { length: 55 },
      () => '[chrome-devtools] No handler registered for issue code PerformanceIssue',
    ),
    'Error: "Text entry or submission failed: error: Send button did not become active/enabled"',
  ].join('\n')
  const normalized = normalizeAskBridgeDiagnostics(stderr)
  assert.match(normalized, /Send button did not become active\/enabled/u)
  assert.match(normalized, /PerformanceIssue × 56/u)
  assert.equal(normalized.match(/No handler registered/gu)?.length, 1)

  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    commandRunner: () => Promise.resolve({ exitCode: 1, stdout: '', stderr }),
  })
  await assert.rejects(
    brain.review({ task }),
    (error: unknown) =>
      error instanceof RetryableGuardianBrainError &&
      error.kind === 'transport' &&
      error.failure.failureType === 'BRAIN_TRANSPORT_FAILED' &&
      error.failure.fingerprint === 'brain-transport:browser-send-button-inactive' &&
      error.failure.rawError?.includes('PerformanceIssue × 56') === true,
  )
})
