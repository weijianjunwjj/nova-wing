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
  assert.match(prompt, /"incomplete_reason":null/)
  assert.match(prompt, /JSON\.parse/)
  assert.match(prompt, /反斜杠必须正确转义/)
})

test('brain prompt serializes safe incomplete execution for Reviewer convergence', () => {
  const incompleteReason = '执行预算耗尽（12 + 6 turns），但安全边界正常，需要 Brain 判断是否继续'
  const prompt = buildGuardianBrainPrompt({
    task: {
      id: 'task-incomplete',
      goal: '完成复杂任务',
      state: 'REVIEWING',
      iteration: 1,
      maxIterations: 3,
    },
    report: {
      summary: '部分完成',
      changedFiles: ['src/a.ts'],
      commandsRun: ['claude -p --output-format json'],
      verificationResults: [],
      blockers: [],
      incompleteReason,
    },
  })

  assert.match(prompt, /execution_report\.incomplete_reason 非空/)
  assert.match(prompt, /"incomplete_reason":"执行预算耗尽（12 \+ 6 turns），但安全边界正常，需要 Brain 判断是否继续"/)
})

// W003 BOOTSTRAP CLOSURE：venv missing + bootstrap capability → Reviewer 必须 revise bootstrap
test('brain prompt requires revise (not blocked) when venv missing and python bootstrap capability is approved', () => {
  const prompt = buildGuardianBrainPrompt({
    task: {
      id: 'task-bootstrap',
      goal: 'Create the minimal FastAPI backend',
      state: 'REVIEWING',
      iteration: 2,
      maxIterations: 10,
      constraints: ['只允许修改 apps/api/**'],
      doNotDo: ['不要 git commit'],
    },
    report: {
      summary: 'venv 未创建，pytest 无法运行',
      changedFiles: ['apps/api/main.py'],
      commandsRun: ['claude -p --output-format json', '.venv/Scripts/python.exe -m pytest'],
      verificationResults: [
        { name: 'git diff --check', status: 'passed' },
        {
          name: '.venv/Scripts/python.exe -m pytest',
          status: 'failed',
          details: '.venv/Scripts/python.exe: No such file or directory',
        },
      ],
      blockers: [],
      executorCapabilities: ['python venv bootstrap', 'venv pip install'],
      deterministicVerificationCapabilities: ['.venv/Scripts/python.exe -m pytest', 'git diff --check'],
    },
  })

  // 必须识别为 recoverable bootstrap prerequisite 并要求 revise
  assert.match(prompt, /recoverable bootstrap prerequisite/)
  assert.match(prompt, /必须 verdict=revise/)
  assert.match(prompt, /不得 blocked/)
  assert.match(prompt, /不得把该失败当作 ENVIRONMENT_REQUIRED/)
  assert.match(prompt, /PERMISSION_REQUIRED/)

  // instructions 必须明确精确的 venv 命令
  assert.match(prompt, /python -m venv \.venv/)
  assert.match(prompt, /\.venv\/Scripts\/python\.exe -m pip install -r/)

  // requirements 路径来自 task/repo 已知事实，不泛化 dependency resolver
  assert.match(prompt, /requirements 路径必须来自当前 task\/repo 已知事实/)

  // deterministic verification 交回 Guardian，不让 Executor 自己跑 pytest/git diff
  assert.match(prompt, /不要让 Executor 自己执行 pytest \/ git diff --check/)
  assert.match(prompt, /Guardian deterministic verifier/)

  // 不扩大权限
  assert.match(prompt, /不得要求新增 generic Bash/)
  assert.match(prompt, /uv、poetry、conda 或 bare pip/)
})

test('brain prompt keeps normal revise semantics when venv missing but no bootstrap capability', () => {
  const prompt = buildGuardianBrainPrompt({
    task: {
      id: 'task-no-bootstrap',
      goal: '完成最小任务',
      state: 'REVIEWING',
      iteration: 1,
      maxIterations: 5,
    },
    report: {
      summary: 'venv 未创建，pytest 无法运行',
      changedFiles: [],
      commandsRun: ['.venv/Scripts/python.exe -m pytest'],
      verificationResults: [
        {
          name: '.venv/Scripts/python.exe -m pytest',
          status: 'failed',
          details: '.venv/Scripts/python.exe: No such file or directory',
        },
      ],
      blockers: [],
      deterministicVerificationCapabilities: ['.venv/Scripts/python.exe -m pytest', 'git diff --check'],
    },
  })

  // 没有 executor_capabilities 的 bootstrap 信号时，bootstrap 恢复规则不适用；
  // 规则文本必须引用 executor_capabilities 同时包含两个 capability 才触发。
  assert.ok(
    prompt.includes('executor_capabilities 同时包含 "python venv bootstrap" 与 "venv pip install"'),
    'bootstrap recovery rule must require both approved capabilities',
  )
})
