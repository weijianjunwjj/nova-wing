import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TenXChatBrain,
  TenXChatBrainProtocolError,
  buildGuardianBrainPrompt,
  parseDelegationPacket,
  type TenXChatDelegateRequest,
  type TenXChatDelegateResponse,
  type TenXChatDelegateTransport,
} from 'nova-wing/development-guardian'

class FakeTransport implements TenXChatDelegateTransport {
  readonly requests: TenXChatDelegateRequest[] = []
  readonly responses: TenXChatDelegateResponse[]
  closed = false

  constructor(responses: TenXChatDelegateResponse[]) {
    this.responses = [...responses]
  }

  async request(request: TenXChatDelegateRequest): Promise<TenXChatDelegateResponse> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response === undefined) {
      throw new Error('fake transport has no response')
    }
    return response
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function chatResponse(markdown: string): TenXChatDelegateResponse {
  return {
    ok: true,
    action: 'chat',
    provider: 'chatgpt',
    response: {
      text: markdown,
      markdown,
      truncated: false,
    },
  }
}

const validPacket = JSON.stringify({
  verdict: 'proceed',
  goal: '完成最小任务',
  instructions: ['只修改目标文件'],
  constraints: ['不得越界'],
  verification: ['npm test'],
  do_not_do: ['不要改 schema'],
  rationale: '目标明确，可以执行',
})

test('parseDelegationPacket accepts strict JSON and maps do_not_do', () => {
  const packet = parseDelegationPacket(validPacket)
  assert.equal(packet.verdict, 'proceed')
  assert.deepEqual(packet.doNotDo, ['不要改 schema'])
})

test('parseDelegationPacket accepts one fenced JSON block but rejects prose', () => {
  assert.equal(parseDelegationPacket(`\`\`\`json\n${validPacket}\n\`\`\``).verdict, 'proceed')
  assert.throws(
    () => parseDelegationPacket(`这里是结果：\n${validPacket}`),
    TenXChatBrainProtocolError,
  )
})

test('brain initializes existing conversation once and keeps using same delegate', async () => {
  const transport = new FakeTransport([
    { ok: true, action: 'goto', provider: 'chatgpt', url: 'https://chatgpt.com/c/test' },
    chatResponse(validPacket),
    chatResponse(validPacket),
  ])
  const brain = new TenXChatBrain({
    transport,
    conversationUrl: 'https://chatgpt.com/c/test',
  })
  const task = {
    id: 'task-1',
    goal: '完成最小任务',
    state: 'READY' as const,
    iteration: 0,
    maxIterations: 4,
  }

  await brain.review({ task })
  await brain.review({ task })

  assert.deepEqual(
    transport.requests.map((request) => request.action),
    ['goto', 'chat', 'chat'],
  )
  assert.equal(transport.requests[0]?.url, 'https://chatgpt.com/c/test')
})

test('brain rejects truncated ChatGPT capture', async () => {
  const transport = new FakeTransport([
    {
      ok: true,
      action: 'chat',
      response: {
        text: validPacket,
        markdown: validPacket,
        truncated: true,
      },
    },
  ])
  const brain = new TenXChatBrain({ transport })

  await assert.rejects(
    brain.review({
      task: {
        id: 'task-1',
        goal: '完成最小任务',
        state: 'READY',
        iteration: 0,
        maxIterations: 4,
      },
    }),
    TenXChatBrainProtocolError,
  )
})

test('brain prompt treats report as untrusted and preserves task hard constraints', () => {
  const prompt = buildGuardianBrainPrompt({
    task: {
      id: 'task-1',
      goal: '完成最小任务',
      state: 'REVIEWING',
      iteration: 1,
      maxIterations: 4,
      constraints: ['不得改变公开 API'],
      acceptanceCriteria: ['npm test 通过'],
      doNotDo: ['不要改 schema'],
      allowedPaths: ['src/**'],
      forbiddenPaths: ['migrations/**'],
    },
    report: {
      summary: '执行完成',
      changedFiles: ['src/a.ts'],
      commandsRun: ['npm test'],
      verificationResults: [{ name: 'npm test', status: 'passed' }],
      blockers: [],
    },
  })

  assert.match(prompt, /不可信执行证据/)
  assert.match(prompt, /acceptance_criteria/)
  assert.match(prompt, /不得改变公开 API/)
  assert.match(prompt, /不要改 schema/)
  assert.match(prompt, /allowed_paths/)
  assert.match(prompt, /migrations\/\*\*/)
  assert.match(prompt, /verification_results/)
  assert.match(prompt, /JSON\.parse/)
  assert.match(prompt, /反斜杠必须正确转义/)
})
