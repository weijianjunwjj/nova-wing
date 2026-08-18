import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AskBridgeBrain,
  type AskBridgeCommandRequest,
  type AskBridgeCommandRunner,
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
      stdout: `${packet}\nnon-protocol stdout noise`,
      stderr: '',
    }
  }
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    conversationUrl: 'https://chatgpt.com/c/test-session',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    timeoutMs: 120_000,
    commandRunner: runner,
  })

  const result = await brain.review({ task })

  assert.equal(result.verdict, 'proceed')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.executable, 'ask-bridge.exe')
  assert.deepEqual(requests[0]?.args.slice(0, 10), [
    '--provider',
    'chatgpt',
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

test('ask-bridge brain captures first Thread Link and reuses it for the same task', async () => {
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
    commandRunner: runner,
  })

  await brain.review({ task })
  await brain.review({
    task: { ...task, state: 'REVIEWING', iteration: 1 },
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.args.includes('--session-url'), false)
  const secondSessionIndex = requests[1]?.args.indexOf('--session-url') ?? -1
  assert.ok(secondSessionIndex >= 0)
  assert.equal(requests[1]?.args[secondSessionIndex + 1], sessionUrl)
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
