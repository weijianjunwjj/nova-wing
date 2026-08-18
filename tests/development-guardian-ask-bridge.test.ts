import assert from 'node:assert/strict'
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

test('ask-bridge brain drives ChatGPT session and parses packet', async () => {
  const requests: AskBridgeCommandRequest[] = []
  const runner: AskBridgeCommandRunner = (request) => {
    requests.push(request)
    return Promise.resolve({ exitCode: 0, stdout: packet, stderr: '' })
  }
  const brain = new AskBridgeBrain({
    command: 'ask-bridge.exe',
    conversationUrl: 'https://chatgpt.com/c/test-session',
    model: 'GPT-5.6 Sol',
    reasoning: 'high',
    timeoutMs: 120_000,
    commandRunner: runner,
  })

  const result = await brain.review({
    task: {
      id: 'task-1',
      goal: '完成最小任务',
      state: 'READY',
      iteration: 0,
      maxIterations: 3,
    },
  })

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
  assert.match(requests[0]?.args.at(-1) ?? '', /唯一 Brain/)
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

  await assert.rejects(
    brain.review({
      task: {
        id: 'task-1',
        goal: '完成最小任务',
        state: 'READY',
        iteration: 0,
        maxIterations: 3,
      },
    }),
    /Chrome not found/,
  )
})
