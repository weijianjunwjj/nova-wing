import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import {
  createNovaWingLaunchpad,
  defaultTrustedConfigDirectory,
  discoverTrustedWorkSessionConfigs,
  findBrowserExecutable,
  loadTrustedWorkSessionConfig,
  openLaunchpadInAppMode,
  persistComposedTrustedWorkSessionConfig,
  analyzeTaskBrief,
  runProductionDependencyPreflight,
  type BrowserProcessSpawner,
  NovaWingLaunchpad,
  type TrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'

import { createProductionWorkSessionUi } from '../packages/development-guardian/work-session/production.js'
import { GoldenPathTaskRunner } from '../packages/development-guardian/work-session/golden-path.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'
import type { TaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import { codexTestRepo } from './codex-test-fixture.js'

function trustedConfig(overrides: {
  sessionId?: string
  goal?: string
  executorModel?: string
} = {}): unknown {
  return {
    session: {
      id: overrides.sessionId ?? 'launchpad-test',
      targetRepo: process.cwd(),
      branch: 'feat/work-session-mvp',
      limits: { softMinutes: 45, hardMinutes: 60, maxTasks: 4 },
    },
    tasks: [{
      id: 'T010',
      goal: overrides.goal ?? 'AgentRun Persistence',
      guardian: {
        constraints: ['keep scope narrow'],
        acceptanceCriteria: ['tests pass'],
        doNotDo: ['do not expose credentials'],
        allowedPaths: ['packages/**'],
        forbiddenPaths: ['secrets/**'],
      },
    }],
    gitCheckpoint: { autoCommit: true, autoPush: false },
    executor: {
      model: overrides.executorModel ?? 'claude-sonnet',
      maxTurns: 10,
      allowNpmInstall: false,
      allowPythonBootstrap: false,
    },
    notification: { email: { enabled: false } },
  }
}

test('Composer schedule API normalizes UTC, accepts old requests, and rejects invalid dates before launch', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state), resolveEnvironment: async () => ({}),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    for (const [index, schedule] of [undefined, null, '2000-01-01T00:00:00Z', '2099-08-31T18:00:00+08:00'].entries()) {
      const response = await postCreate(launchpad, composerRequest(`scheduled-request-valid-${index}`, {
        ...(schedule === undefined ? {} : { scheduled_start_at: schedule }),
        ...(index === 3 ? { schedule_source: 'deepseek_off_peak' } : {}),
      }), auth)
      assert.equal(response.status, 202)
      const config = state.receivedConfigs[index]!
      assert.equal(config.session.scheduledStartAt, index === 3 ? '2099-08-31T10:00:00.000Z' : null)
      assert.ok(config.session.createdAt)
      if (index === 3) assert.equal(config.session.scheduleSource, 'deepseek_off_peak')
    }
    for (const [index, value] of ['tomorrow', '2026-08-31T18:00', '2026-02-30T00:00:00Z', 42, {}].entries()) {
      const response = await postCreate(launchpad, composerRequest(`scheduled-request-invalid-${index}`, { scheduled_start_at: value }), auth)
      assert.equal(response.status, 400)
    }
    const conflict = await postCreate(launchpad, composerRequest('scheduled-request-valid-3', {
      scheduled_start_at: '2099-09-01T10:00:00Z', schedule_source: 'deepseek_off_peak',
    }), auth)
    assert.equal(conflict.status, 409)
    assert.equal(state.createCalls, 4)
    const configs = await discoverTrustedWorkSessionConfigs(directory)
    assert.ok(configs.some((entry) => entry.config.session.scheduledStartAt === '2099-08-31T10:00:00.000Z'))
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

async function createConfigDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-launchpad-'))
  await writeFile(join(directory, 'fly-weave.json'), JSON.stringify(trustedConfig()), 'utf8')
  return directory
}

test('Composer executor defaults Codex, persists explicit modes, and confines Off-Peak to DeepSeek', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
    createWorkSession: fakeWorkSessionFactory(state), resolveEnvironment: async () => ({}),
    gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
  } })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    for (const [index, mode] of [undefined, 'auto', 'codex', 'deepseek'].entries()) {
      const result = await postCreate(launchpad, composerRequest(`executor-mode-valid-${index}`, {
        ...(mode === undefined ? {} : { executorMode: mode }),
      }), auth)
      assert.equal(result.status, 202)
      assert.equal(state.receivedConfigs[index]?.executor.defaultMode, mode ?? 'codex')
    }
    for (const mode of ['auto', 'codex']) {
      const result = await postCreate(launchpad, composerRequest(`executor-off-peak-invalid-${mode}`, {
        executorMode: mode, schedule_source: 'deepseek_off_peak', scheduled_start_at: '2099-08-31T10:00:00Z',
      }), auth)
      assert.equal(result.status, 400)
    }
    assert.equal((await postCreate(launchpad, composerRequest('executor-off-peak-valid-ds', {
      executorMode: 'deepseek', schedule_source: 'deepseek_off_peak', scheduled_start_at: '2099-08-31T10:00:00Z',
    }), auth)).status, 202)
    assert.equal((await postCreate(launchpad, composerRequest('executor-mode-invalid-value', { executorMode: 'other' }), auth)).status, 400)
    assert.equal((await postCreate(launchpad, composerRequest('executor-mode-valid-0', { executorMode: 'deepseek' }), auth)).status, 409)
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Launchpad quota default uses DeepSeek only for an explicit active exhaustion result', async () => {
  for (const [name, readCodexAvailability, expected] of [
    ['available', () => ({ state: 'available' as const }), 'codex'],
    ['exhausted', () => ({ state: 'quota_exhausted' as const }), 'deepseek'],
    ['unknown', () => ({ state: 'unknown' as const }), 'codex'],
    ['error', () => { throw new Error('quota probe failed') }, 'codex'],
    ['timeout', async () => { throw new Error('quota probe timed out') }, 'codex'],
  ] as const) {
    const directory = await createConfigDirectory()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
      readCodexAvailability,
    } })
    try {
      const address = await launchpad.start()
      const html = await (await fetch(address.url)).text()
      assert.match(html, new RegExp(`<option value="${expected}" selected>`), name)
      assert.match(html, /name="codexModel"/u, name)
      assert.match(html, /name="codexReasoningEffort"/u, name)
    } finally {
      await launchpad.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('Composer persists selected Codex model and reasoning, validates combinations, and leaves DeepSeek unchanged', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
    createWorkSession: fakeWorkSessionFactory(state), resolveEnvironment: async () => ({}),
    gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
    readCodexAvailability: () => ({ state: 'available' }),
  } })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const codex = await postCreate(launchpad, composerRequest('codex-model-reasoning-0001', {
      executorMode: 'codex', codexModel: 'gpt-5.6-luna', codexReasoningEffort: 'max',
    }), auth)
    assert.equal(codex.status, 202)
    assert.deepEqual(state.receivedConfigs[0]!.codex, {
      model: 'gpt-5.6-luna', reasoningEffort: 'max',
    })
    assert.equal((await postCreate(launchpad, composerRequest('codex-model-reasoning-0002', {
      executorMode: 'codex', codexModel: 'gpt-5.5', codexReasoningEffort: 'max',
    }), auth)).status, 400, 'unsupported model/reasoning pairs are rejected')
    const deepseek = await postCreate(launchpad, composerRequest('deepseek-model-unchanged-0003', {
      executorMode: 'deepseek', executorModel: 'sonnet', codexModel: 'gpt-6-astra', codexReasoningEffort: 'ultra',
    }), auth)
    assert.equal(deepseek.status, 202)
    assert.equal(state.receivedConfigs[1]!.executor.model, 'sonnet')
    assert.equal(state.receivedConfigs[1]!.codex, undefined)
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})

test('Task Brief analysis fills only explicit high-risk fields and recommends a supported Codex configuration', () => {
  const analysis = analyzeTaskBrief(`项目目录 D:\\VSCode\\nova-wing
Task ID: T033
目标：修复 Codex Executor Resume 后 model/reasoning 可能恢复错误的问题。
只允许修改：
packages/development-guardian/**
tests/**
禁止修改：
package.json
pnpm-lock.yaml
Executor 使用 Codex。
Soft Limit 10
Hard Limit 20
立即执行。
完成后 Auto Commit。
不要 Auto Push。
验证：npm test\nnpm run typecheck`, new Date('2026-09-05T09:00:00+08:00'))
  assert.equal(analysis.fields.targetRepo, 'D:\\VSCode\\nova-wing')
  assert.equal(analysis.fields.taskId, 'T033')
  assert.deepEqual(analysis.fields.allowedPaths, ['packages/development-guardian/**', 'tests/**'])
  assert.deepEqual(analysis.fields.forbiddenPaths, ['package.json', 'pnpm-lock.yaml'])
  assert.equal(analysis.fields.autoCommit, true)
  assert.equal(analysis.fields.autoPush, false)
  assert.equal(analysis.fields.startMode, 'immediate')
  assert.equal(analysis.modelRecommendation?.model, 'gpt-5.6-terra')
  assert.equal(analysis.modelRecommendation?.reasoningEffort, 'high')
  assert.deepEqual(analysis.fields.acceptanceCriteria, ['npm test', 'npm run typecheck'])

  const bound = analyzeTaskBrief(`Acceptance Criteria:
npm test passes.
typecheck passes.
Required Evidence:
npm test passes. => npm test
typecheck passes. => npm run typecheck`)
  assert.deepEqual(bound.fields.acceptanceEvidenceBindings, [
    { criterion: 'npm test passes.', requiredEvidence: ['npm test'] },
    { criterion: 'typecheck passes.', requiredEvidence: ['npm run typecheck'] },
  ])

  const tomorrowMorning = analyzeTaskBrief('明天上午开始修复 README。', new Date('2026-09-05T09:00:00+08:00'))
  assert.equal(tomorrowMorning.fields.startMode, 'custom')
  assert.equal(tomorrowMorning.fields.customStartAt, '2026-09-06T09:00')

  const explicit = analyzeTaskBrief('Model: GPT-5.6 Sol\nReasoning: High\n修复复杂状态机并发问题。')
  assert.equal(explicit.modelRecommendation?.model, 'gpt-5.6-sol')
  assert.equal(explicit.modelRecommendation?.reasoningEffort, 'high')
  assert.equal(explicit.modelRecommendation?.modelExplicit, true)

  const conservative = analyzeTaskBrief('修改 NovaWing，完成并发布。')
  assert.equal(conservative.fields.allowedPaths, undefined)
  assert.equal(conservative.fields.autoPush, undefined)

  const quotaFallback = analyzeTaskBrief('修复跨文件 runtime 问题并运行测试。', new Date(), 'deepseek')
  assert.equal(quotaFallback.modelRecommendation, undefined, 'DeepSeek quota fallback never invokes the Codex advisor')

  const boundedPaths = analyzeTaskBrief(`只允许修改：
docs/**
tests/**

如果不需要修改代码则不要产生无意义 diff。

禁止修改：
package.json`)
  assert.deepEqual(boundedPaths.fields.allowedPaths, ['docs/**', 'tests/**'])
  assert.deepEqual(boundedPaths.fields.forbiddenPaths, ['package.json'])

  const t034Audit = analyzeTaskBrief(`审计 NovaWing 在技术面试现场演示完整开发流程时可能出现的可靠性风险。
涉及：Launchpad、Codex SDK、DeepSeek handoff、Retry、Resume、verification、WebSocket、状态持久化等。
先调查，输出风险报告；不进行大规模修复，不做架构重构；问题定义明确。`)
  assert.equal(t034Audit.modelRecommendation?.model, 'gpt-5.6-terra')
  assert.equal(t034Audit.modelRecommendation?.reasoningEffort, 'high')
  assert.match(t034Audit.modelRecommendation?.reason ?? '', /审计/u)
  assert.equal(t034Audit.modelRecommendation?.signals.includes('architecture-redesign'), false)

  const runtimeInvestigation = analyzeTaskBrief('调查 Codex SDK 在 runtime 中处理 retry / resume 时的兼容性问题，验证现有恢复路径；不重构架构。')
  assert.equal(runtimeInvestigation.modelRecommendation?.model, 'gpt-5.6-terra')
  assert.equal(runtimeInvestigation.modelRecommendation?.reasoningEffort, 'high')

  const light = analyzeTaskBrief('修复 README 中一个拼写错误。')
  assert.equal(light.modelRecommendation?.model, 'gpt-5.6-luna')
  assert.equal(light.modelRecommendation?.reasoningEffort, 'medium')

  const architecture = analyzeTaskBrief('为模糊需求设计新的核心状态模型，比较多个架构方案并进行职责边界重构。')
  assert.equal(architecture.modelRecommendation?.model, 'gpt-5.6-sol')
  assert.equal(architecture.modelRecommendation?.reasoningEffort, 'high')

  const concurrencyArchitecture = analyzeTaskBrief('诊断多进程生命周期中的 race condition，并重新设计状态所有权与职责边界。')
  assert.equal(concurrencyArchitecture.modelRecommendation?.model, 'gpt-5.6-sol')
  assert.equal(concurrencyArchitecture.modelRecommendation?.reasoningEffort, 'high')

  const longBrief = [
    '目标：审计 NovaWing Demo reliability，并验证既有恢复路径。',
    '',
    ...Array.from({ length: 120 }, (_, index) => `${index + 1}. ${'这是一段用于模拟长 Task Brief 的审计背景。'.repeat(4)}`),
    '25. 这只是编号，不能被当作时间限制。',
    '26. 这也是编号，不能被当作时间限制。',
    '检查 Auto Push 是否存在风险。',
    'Soft Limit:',
    '10',
    'Hard Limit:',
    '20',
    'Auto Commit: OFF',
    'Auto Push: OFF',
    '不要 commit',
    '不要 push',
    'Allowed Paths:',
    'packages/development-guardian/**',
    'tests/**',
    'Forbidden Paths:',
    'package.json',
    'Constraints:',
    'Do not widen the Guardian write boundary.',
    'Acceptance Criteria:',
    'npm test passes.',
    'Do Not Do:',
    'Do not change quota routing.',
  ].join('\n')
  const longAnalysis = analyzeTaskBrief(longBrief)
  assert.equal(longBrief.length > 8_000, true)
  assert.match(longAnalysis.fields.taskInstructions, /^审计 NovaWing Demo reliability，并验证既有恢复路径。/u)
  assert.doesNotMatch(longAnalysis.fields.taskInstructions, /Soft Limit|Hard Limit|Allowed Paths|Forbidden Paths/u)
  assert.equal(longAnalysis.fields.softMinutes, 10)
  assert.equal(longAnalysis.fields.hardMinutes, 20)
  assert.equal(longAnalysis.fields.autoCommit, false)
  assert.equal(longAnalysis.fields.autoPush, false)
  assert.deepEqual(longAnalysis.fields.allowedPaths, ['packages/development-guardian/**', 'tests/**'])
  assert.deepEqual(longAnalysis.fields.forbiddenPaths, ['package.json'])
  assert.deepEqual(longAnalysis.fields.constraints, ['Do not widen the Guardian write boundary.'])
  assert.deepEqual(longAnalysis.fields.acceptanceCriteria, ['npm test passes.'])
  assert.deepEqual(longAnalysis.fields.doNotDo, ['Do not change quota routing.'])
  assert.ok(longAnalysis.warnings.some((warning) => warning.includes('超过 8000 字符')))

  assert.equal(analyzeTaskBrief('检查 Auto Push 是否存在风险。\nAuto Push: OFF').fields.autoPush, false)
  assert.equal(analyzeTaskBrief('不要 push').fields.autoPush, false)
  assert.equal(analyzeTaskBrief('只调查当前状态。').fields.autoPush, undefined)
  assert.equal(analyzeTaskBrief('Auto Push: ON').fields.autoPush, true)

  const multilineFields = analyzeTaskBrief(`Auto Commit:
OFF

Auto Push:
ON

Start:
Immediately`)
  assert.equal(multilineFields.fields.autoCommit, false)
  assert.equal(multilineFields.fields.autoPush, true)
  assert.equal(multilineFields.fields.startMode, 'immediate')
  assert.deepEqual(multilineFields.recognized.filter((field) => ['Auto Commit', 'Auto Push', 'Start Time'].includes(field)), ['Start Time', 'Auto Commit', 'Auto Push'])
  assert.equal(analyzeTaskBrief('Auto Commit: ON\nAuto Push: OFF\nStart: Immediately').fields.autoCommit, true)
  assert.equal(analyzeTaskBrief('Auto Commit: ON\nAuto Push: OFF\nStart: Immediately').fields.autoPush, false)
  assert.equal(analyzeTaskBrief('Auto Commit: ON\nAuto Push: OFF\nStart: Immediately').fields.startMode, 'immediate')
  assert.equal(analyzeTaskBrief('Auto Commit:\n允许 commit').fields.autoCommit, true)
  assert.equal(analyzeTaskBrief('Auto Push:\n明确允许 push').fields.autoPush, true)
  assert.equal(analyzeTaskBrief('Auto Commit:\n禁止 commit').fields.autoCommit, false)
  assert.equal(analyzeTaskBrief('Auto Push:\n不要 push').fields.autoPush, false)

  const t034Source = [
    'Workspace:', 'D:\\VSCode\\nova-wing', 'Task ID:', 'T034',
    'Allowed Paths:', 'docs/**', 'tests/**',
    'Forbidden Paths:', 'packages/development-guardian/codex-executor.ts',
    'Soft Limit:', '10', 'Hard Limit:', '20',
    'Model: GPT-5.6 Terra', 'Reasoning: High',
    'Auto Commit:', 'OFF', 'Auto Push:', 'OFF', 'Start:', 'Immediately', '',
    '目标：对 NovaWing 当前代码库进行技术面试现场 Demo 可靠性审计。',
    '重点检查 Launchpad、Reviewer、Guardian、Codex SDK、DeepSeek handoff、Retry/Resume、Verification、状态持久化、WebSocket、Health 等完整链路。',
    '寻找可能导致现场失败、卡死、状态错误、误报成功、无法恢复或需要人工救场的风险，按 P0/P1/P2 分级。',
    '第一阶段只调查并输出报告，不批量修复产品代码。',
    ...Array.from({ length: 180 }, () => '补充审计背景：每一个结论都应回到可复现的现场 Demo 风险与证据。'),
  ].join('\n')
  const t034 = analyzeTaskBrief(t034Source)
  assert.equal(t034.fields.targetRepo, 'D:\\VSCode\\nova-wing')
  assert.equal(t034.fields.taskId, 'T034')
  assert.equal(t034.fields.autoCommit, false)
  assert.equal(t034.fields.autoPush, false)
  assert.equal(t034.fields.startMode, 'immediate')
  assert.deepEqual(t034.fields.allowedPaths, ['docs/**', 'tests/**'])
  assert.equal(t034.fields.softMinutes, 10)
  assert.equal(t034.fields.hardMinutes, 20)
  assert.equal(t034.modelRecommendation?.model, 'gpt-5.6-terra')
  assert.equal(t034.modelRecommendation?.reasoningEffort, 'high')
  assert.match(t034.fields.taskInstructions, /技术面试现场 Demo 可靠性审计/u)
  assert.match(t034.fields.taskInstructions, /第一阶段只调查并输出报告/u)
  assert.doesNotMatch(t034.fields.taskInstructions, /Workspace|Task ID|Allowed Paths|Auto Commit|Auto Push/u)
})

test('Task Brief endpoint is authenticated, validates its envelope, and never starts a Work Session', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
    createWorkSession: fakeWorkSessionFactory(state), resolveEnvironment: async () => ({}),
  } })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    assert.equal((await postBrief(launchpad, { brief: 'Task ID: T040\n立即执行' }, auth)).status, 200)
    const longBrief = `目标：只保留这个核心目标。\n\n${'背景说明。'.repeat(2_000)}\nSoft Limit: 10\nHard Limit: 20\nAuto Push: OFF`
    const longResponse = await postBrief(launchpad, { brief: longBrief }, auth)
    assert.equal(longResponse.status, 200)
    const longAnalysis = await longResponse.json()
    assert.match(longAnalysis.fields.taskInstructions, /^只保留这个核心目标。/u)
    assert.equal(longAnalysis.fields.softMinutes, 10)
    assert.equal(longAnalysis.fields.hardMinutes, 20)
    assert.equal(longAnalysis.fields.autoPush, false)
    assert.ok(longAnalysis.warnings.some((warning: string) => warning.includes('超过 8000 字符')))
    assert.equal((await postBrief(launchpad, { brief: 'x', extra: true }, auth)).status, 400)
    assert.equal((await postBrief(launchpad, { brief: 'x' }, { origin: address.url })).status, 403)
    assert.equal(state.createCalls, 0)
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})

interface FakeWorkSessionState {
  createCalls: number
  startCalls: number
  controllerStartCalls: number
  closeCalls: number
  receivedServerPorts: number[]
  receivedConfigIds: string[]
  receivedExecutorModels: string[]
  receivedConfigs: TrustedWorkSessionConfig[]
  createdApps: Array<{
    close(): Promise<void>
    isLive(): boolean
    setActiveSession(active: boolean): void
  }>
}

function fakeWorkSessionFactory(
  state: FakeWorkSessionState,
  options: { controllerStarted?: boolean; failWith?: Error; sessionActive?: boolean } = {},
) {
  return async (config: TrustedWorkSessionConfig, input: { serverPort: 0 }) => {
    state.createCalls += 1
    state.receivedServerPorts.push(input.serverPort)
    state.receivedConfigIds.push(config.session.id)
    state.receivedExecutorModels.push(config.executor.model)
    state.receivedConfigs.push(config)
    if (options.failWith !== undefined) throw options.failWith
    let live = true
    let sessionActive = options.sessionActive ?? true
    const app = {
      controller: {
        start() {
          state.controllerStartCalls += 1
          return { started: options.controllerStarted ?? true }
        },
      },
      async start() {
        state.startCalls += 1
        return { url: 'http://127.0.0.1:54321' }
      },
      isLive() {
        return live
      },
      hasActiveSession() {
        return sessionActive
      },
      setActiveSession(active: boolean) {
        sessionActive = active
      },
      async close() {
        if (!live) return
        live = false
        sessionActive = false
        state.closeCalls += 1
      },
    }
    state.createdApps.push(app)
    return app
  }
}

function emptyFakeState(): FakeWorkSessionState {
  return {
    createCalls: 0,
    startCalls: 0,
    controllerStartCalls: 0,
    closeCalls: 0,
    receivedServerPorts: [],
    receivedConfigIds: [],
    receivedExecutorModels: [],
    receivedConfigs: [],
    createdApps: [],
  }
}

async function postStart(
  launchpad: NovaWingLaunchpad,
  body: unknown,
  headers: { token?: string; origin?: string } = {},
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers.token === undefined
        ? {}
        : { 'X-NovaWing-Launchpad-Token': headers.token }),
      ...(headers.origin === undefined ? {} : { Origin: headers.origin }),
    },
    body: JSON.stringify(body),
  })
}

async function postCreate(
  launchpad: NovaWingLaunchpad,
  body: unknown,
  headers: { token?: string; origin?: string } = {},
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers.token === undefined ? {} : { 'X-NovaWing-Launchpad-Token': headers.token }),
      ...(headers.origin === undefined ? {} : { Origin: headers.origin }),
    },
    body: JSON.stringify(body),
  })
}

async function postDelete(
  launchpad: NovaWingLaunchpad,
  body: unknown,
  headers: { token?: string; origin?: string } = {},
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers.token === undefined ? {} : { 'X-NovaWing-Launchpad-Token': headers.token }),
      ...(headers.origin === undefined ? {} : { Origin: headers.origin }),
    },
    body: JSON.stringify(body),
  })
}

async function postBranch(
  launchpad: NovaWingLaunchpad,
  targetRepo: string,
  headers: { token: string; origin: string },
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/branch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-NovaWing-Launchpad-Token': headers.token,
      Origin: headers.origin,
    },
    body: JSON.stringify({ targetRepo }),
  })
}

async function postBrief(
  launchpad: NovaWingLaunchpad,
  body: unknown,
  headers: { token?: string; origin?: string } = {},
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return fetch(`${address.url}/api/session/brief`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(headers.token === undefined ? {} : { 'X-NovaWing-Launchpad-Token': headers.token }),
      ...(headers.origin === undefined ? {} : { Origin: headers.origin }),
    },
    body: JSON.stringify(body),
  })
}

function composerRequest(requestId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    requestId,
    targetRepo: process.cwd(),
    tasks: [{ id: 'T011', goal: 'Implement a focused persistent model with deterministic tests.' }],
    guardian: { allowedPaths: ['packages/**', 'tests/**'] },
    ...overrides,
  }
}

await test('Launchpad discovery uses the trusted validator and ignores invalid JSON configs', async () => {
  const directory = await createConfigDirectory()
  try {
    await writeFile(join(directory, 'invalid.json'), '{"credential":"SECRET"}', 'utf8')
    await writeFile(join(directory, 'notes.txt'), JSON.stringify(trustedConfig()), 'utf8')
    const discovered = await discoverTrustedWorkSessionConfigs(directory)
    assert.equal(discovered.length, 1)
    assert.match(discovered[0]!.summary.configId, /^[a-f0-9]{32}$/u)
    assert.equal(discovered[0]!.summary.project, 'Nova-Wing')
    assert.equal(discovered[0]!.summary.taskId, 'T010')
    assert.equal(discovered[0]!.summary.goal, 'AgentRun Persistence')
    assert.equal(discovered[0]!.summary.reviewer, 'GPT Reviewer')
    assert.equal(discovered[0]!.summary.executor, 'claude-sonnet')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad config directory supports NOVAWING_CONFIG_DIR and the LOCALAPPDATA default', () => {
  assert.equal(
    defaultTrustedConfigDirectory({ NOVAWING_CONFIG_DIR: 'D:/trusted-configs' }, 'C:/Users/test'),
    join('D:/trusted-configs'),
  )
  assert.equal(
    defaultTrustedConfigDirectory({ LOCALAPPDATA: 'C:/Users/test/AppData/Local' }, 'C:/ignored'),
    join('C:/Users/test/AppData/Local', 'NovaWing', 'canary-configs'),
  )
})

await test('Launchpad binds only 127.0.0.1 on a dynamic port and renders safe config fields', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
    preflight: async () => ({
      overall: 'READY', canStart: true, checkedAt: '2026-09-05T00:00:00.000Z',
      dependencies: [
        { id: 'CORE', state: 'READY' }, { id: 'BRIDGE', state: 'READY' },
        { id: 'BRAIN', state: 'UNKNOWN' }, { id: 'EXECUTOR', state: 'READY' },
      ],
    }),
  } })
  try {
    const address = await launchpad.start()
    assert.equal(address.host, '127.0.0.1')
    assert.ok(address.port > 0)
    assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
    const html = await (await fetch(address.url)).text()
    assert.match(html, /NovaWing Launchpad/u)
    assert.match(html, /AgentRun Persistence/u)
    assert.match(html, /SYSTEM UNKNOWN/u)
    assert.match(html, /新建 Work Session/u)
    assert.match(html, /data-composer-tasks/u)
    assert.match(html, /data-task-id/u)
    assert.match(html, /data-task-goal/u)
    assert.match(html, /data-task-goal-count>0 \/ 8000/u)
    assert.match(html, /data-task-goal rows="6" maxlength="8000"/u)
    assert.match(html, /data-task-brief data-task-brief-max="20000" rows="7"/u)
    assert.match(html, /data-add-task/u)
    assert.match(html, /data-delete-config-id=/u)
    assert.match(html, />\s*删除\s*<\/button>/u)
    assert.match(html, /邮件通知（完成 \/ 失败 \/ 需人工）/u)
    assert.doesNotMatch(html, /name="autoPush"[^>]*disabled/u)
    const advanced = html.match(/<details>[\s\S]*?<\/details>/u)?.[0] ?? ''
    assert.doesNotMatch(advanced, /allowedPaths/u)
    assert.match(html, /name="allowedPaths"[^>]*required/u)
    assert.doesNotMatch(html, /expectedUrl|SMTP_|credential/u)
    const appJs = await (await fetch(`${address.url}/app.js`)).text()
    assert.match(appJs, /goldenPathEnabled:\s*true/u)
    assert.match(appJs, /确定删除这个 Work Session 吗？此操作只删除 NovaWing Launchpad 配置，不会删除项目代码。/u)
    assert.match(appJs, /Work Session 正在运行，请先结束后再删除。/u)
    assert.match(appJs, /Task Brief 超过 .*字符，未进行解析或截断。/u)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad renders DEGRADED and blocks before creating a Work Session when shell preflight fails', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const expected = 'D:\\Git\\bin\\bash.exe'
  const actual = 'C:\\Windows\\System32\\bash.exe'
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      preflight: async () => ({
        overall: 'ENVIRONMENT_REQUIRED', canStart: false,
        checkedAt: '2026-08-28T00:00:00.000Z',
        dependencies: [
          { id: 'CORE', state: 'DEGRADED' },
          {
            id: 'SHELL', state: 'UNAVAILABLE', failureType: 'SHELL_ENVIRONMENT_INVALID',
            safeMessage: 'shell invalid', expectedExecutable: expected, actualExecutable: actual,
            safeRemediation: 'restart runtime and Resume',
          },
          { id: 'BRAIN', state: 'UNAVAILABLE' },
          { id: 'EXECUTOR', state: 'UNAVAILABLE' },
        ],
      }),
    },
  })
  try {
    const address = await launchpad.start()
    const html = await (await fetch(address.url)).text()
    assert.match(html, /SYSTEM DEGRADED/u)
    assert.match(html, /NovaWing Core: DEGRADED/u)
    assert.match(html, /BRAIN: UNAVAILABLE/u)
    assert.match(html, /EXECUTOR: UNAVAILABLE/u)
    const configId = launchpad.getConfigs()[0]?.configId
    assert.ok(configId)
    const response = await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'DEPENDENCY_REQUIRED', classification: 'ENVIRONMENT_REQUIRED',
      failureType: 'SHELL_ENVIRONMENT_INVALID', dependency: 'SHELL', message: 'shell invalid',
      expectedExecutable: expected, actualExecutable: actual,
      safeRemediation: 'restart runtime and Resume',
    })
    assert.equal(state.createCalls, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad reports ready availability at cold start without a model call or active Task', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      preflight: async () => ({
        overall: 'READY', canStart: true,
        checkedAt: '2026-09-05T00:00:00.000Z',
        dependencies: [
          { id: 'CORE', state: 'READY' },
          { id: 'BRIDGE', state: 'READY' },
          { id: 'BRAIN', state: 'READY', safeMessage: 'Static Brain pipeline preflight passed.' },
          { id: 'EXECUTOR', state: 'READY' },
        ],
      }),
    },
  })
  try {
    const address = await launchpad.start()
    const html = await (await fetch(address.url)).text()
    assert.match(html, /SYSTEM READY/u)
    assert.match(html, /NovaWing Core: READY/u)
    assert.match(html, /BRAIN: READY/u)
    assert.match(html, /EXECUTOR: READY/u)
    assert.doesNotMatch(html, /SYSTEM DEGRADED/u)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer creates a fresh validated session from structured input and reads branch through git argv', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const gitCalls: Array<{ executable: string; args: readonly string[]; cwd: string }> = []
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner(executable, args, cwd) {
        gitCalls.push({ executable, args, cwd })
        return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' }
      },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const mismatch = await postCreate(launchpad, composerRequest('composer-create-branch-mismatch', {
      branch: 'feat/other',
    }), auth)
    assert.deepEqual(await mismatch.json(), {
      error: 'BRANCH_MISMATCH',
      message: 'Task Brief 中的分支与项目当前 Git 分支不一致。',
    })
    assert.equal(state.createCalls, 0)
    const response = await postCreate(launchpad, composerRequest('composer-create-request-0001', {
      branch: 'feat/composer',
      guardian: {
        allowedPaths: ['packages/**', 'tests/**'],
        acceptanceCriteria: ['D01 root cause is classified from evidence.', 'npm run typecheck'],
        acceptanceEvidenceBindings: [{ criterion: 'D01 root cause is classified from evidence.', requiredEvidence: ['npm test'] }],
      },
    }), auth)
    assert.equal(response.status, 202, JSON.stringify(await response.clone().json()))
    assert.deepEqual(await response.json(), { accepted: true, controlUrl: 'http://127.0.0.1:54321' })
    assert.equal(state.createCalls, 1)
    assert.equal(state.receivedConfigIds.length, 1)
    assert.match(state.receivedConfigIds[0]!, /^nova-wing-\d{12}-[a-f0-9]{6}$/u)
    assert.deepEqual(state.receivedExecutorModels, ['sonnet'])
    assert.equal(state.controllerStartCalls, 1)
    assert.equal(state.receivedConfigs[0]!.tasks[0]!.id, 'T011')
    assert.deepEqual(state.receivedConfigs[0]!.tasks[0]!.acceptanceEvidenceBindings, [
      { criterion: 'Implement the requested task.', requiredEvidence: ['git diff --check'] },
      { criterion: 'Run relevant deterministic tests.', requiredEvidence: ['npm test'] },
      { criterion: 'D01 root cause is classified from evidence.', requiredEvidence: ['npm test'] },
      { criterion: 'npm run typecheck', requiredEvidence: ['npm run typecheck'] },
    ])
    const composedTask = state.receivedConfigs[0]!.tasks[0]!
    const convergingTask = { id: composedTask.id, goal: composedTask.goal, acceptanceCriteria: composedTask.guardian.acceptanceCriteria, acceptanceEvidenceBindings: composedTask.acceptanceEvidenceBindings }
    const convergingRunner = new V2ControllerTaskRunner({ sessionId: 'composer-converges', branch: 'feat/composer', agents: [{ id: 'codex', available: true, quotaExhausted: false, degraded: false, capabilities: { coding: true, verification: true } }], dispatcher: {
      inspectRepository: async () => ({ repositoryIdentity: process.cwd(), branch: 'feat/composer', headSha: 'h', changedFiles: [], worktreeFingerprint: 'w' }),
      dispatch: async ({ action }) => action === 'VERIFY'
        ? { status: 'SUCCESS', verificationResults: [{ name: 'git diff --check', status: 'passed' }, { name: 'npm test', status: 'passed' }, { name: 'npm run typecheck', status: 'passed' }] }
        : { status: 'SUCCESS' },
    } })
    assert.equal((await convergingRunner.run(convergingTask)).status, 'COMPLETED')
    assert.equal(state.receivedConfigs[0]!.session.limits.maxTasks, 1)
    assert.deepEqual(state.receivedConfigs[0]!.session.goldenPath, { enabled: false })
    assert.deepEqual(state.receivedConfigs[0]!.notification, { email: { enabled: false } })
    assert.deepEqual(gitCalls, [
      { executable: 'git', args: ['branch', '--show-current'], cwd: process.cwd() },
      { executable: 'git', args: ['branch', '--show-current'], cwd: process.cwd() },
    ])
    const sessionId = state.receivedConfigIds[0]!
    const persistedPath = join(directory, `${sessionId}.json`)
    const persistedText = await readFile(persistedPath, 'utf8')
    const persisted = JSON.parse(persistedText) as TrustedWorkSessionConfig
    assert.equal(persisted.session.id, sessionId)
    assert.deepEqual(persisted, state.receivedConfigs[0])
    assert.doesNotMatch(persistedText, /"(?:token|password|credential|cookie|secret)"\s*:/iu)
    assert.equal(launchpad.getConfigs().filter((config) => config.taskId === 'T011').length, 1)

    await launchpad.close()
    const reopenedState = emptyFakeState()
    const reopened = await createNovaWingLaunchpad({
      configDirectory: directory,
      dependencies: { createWorkSession: fakeWorkSessionFactory(reopenedState) },
    })
    try {
      const restored = reopened.getConfigs().find((config) => config.taskId === 'T011')
      assert.ok(restored)
      const reopenedAddress = await reopened.start()
      const reopenResponse = await postStart(reopened, { configId: restored.configId }, {
        token: reopened.getTokenForTest(), origin: reopenedAddress.url,
      })
      assert.equal(reopenResponse.status, 202)
      assert.deepEqual(reopenedState.receivedConfigIds, [sessionId])
    } finally {
      await reopened.close()
    }
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer config persistence leaves no discoverable JSON file when atomic preparation fails', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'novawing-launchpad-file-'))
  const configDirectory = join(parent, 'not-a-directory')
  await writeFile(configDirectory, 'block persistence', 'utf8')
  try {
    await assert.rejects(persistComposedTrustedWorkSessionConfig(
      configDirectory,
      trustedConfig({ sessionId: 'nova-wing-202608250000-a1b2c3' }) as TrustedWorkSessionConfig,
    ))
    assert.equal((await readdir(parent)).filter((name) => name.endsWith('.json')).length, 0)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

await test('Composer includes completion email notification when enabled', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async resolveEnvironment() { return {} },
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('composer-create-request-email', { emailEnabled: true }), {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.deepEqual(state.receivedConfigs[0]!.notification, {
      email: { enabled: true, notifyOnCompleted: true },
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer creates ordered batch tasks with a shared Guardian policy and matching maxTasks', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('composer-create-request-batch', {
      tasks: [
        { id: 'T014', goal: 'Implement check_inventory Tool.' },
        { id: 'T015', goal: 'Implement constrained replacement decision.' },
        { id: 'T016', goal: 'Add deterministic coverage.' },
        { id: 'T017', goal: 'Document the result.' },
      ],
    }), { token: launchpad.getTokenForTest(), origin: address.url })
    assert.equal(response.status, 202)
    const config = state.receivedConfigs[0]!
    assert.deepEqual(config.tasks.map((task) => ({ id: task.id, goal: task.goal })), [
      { id: 'T014', goal: 'Implement check_inventory Tool.' },
      { id: 'T015', goal: 'Implement constrained replacement decision.' },
      { id: 'T016', goal: 'Add deterministic coverage.' },
      { id: 'T017', goal: 'Document the result.' },
    ])
    assert.equal(config.session.limits.maxTasks, 4)
    assert.deepEqual(config.tasks.map((task) => task.guardian.allowedPaths), [
      ['packages/**', 'tests/**'], ['packages/**', 'tests/**'], ['packages/**', 'tests/**'], ['packages/**', 'tests/**'],
    ])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer discovers one origin push URL read-only and carries its confirmed identity into auto push config', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const gitCalls: Array<{ executable: string; args: readonly string[]; cwd: string }> = []
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner(executable, args, cwd) {
        gitCalls.push({ executable, args, cwd })
        if (args[0] === 'remote') return { exitCode: 0, stdout: 'https://github.com/acme/nova-wing.git\n', stderr: '' }
        return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' }
      },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const discovery = await postBranch(launchpad, process.cwd(), auth)
    assert.deepEqual(await discovery.json(), {
      branch: 'feat/composer',
      pushRemoteStatus: 'available',
      pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    })
    const response = await postCreate(launchpad, composerRequest('composer-create-request-push', {
      autoPush: true,
      pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    }), auth)
    assert.equal(response.status, 202)
    assert.deepEqual(state.receivedConfigs[0]!.gitCheckpoint, {
      autoCommit: true,
      autoPush: true,
      pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    })
    assert.deepEqual(gitCalls[1], {
      executable: 'git', args: ['remote', 'get-url', '--push', '--all', 'origin'], cwd: process.cwd(),
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer remote discovery never exposes credential-bearing or ambiguous origin URLs', async () => {
  const directory = await createConfigDirectory()
  const cases: Array<{ remote: string; available: boolean }> = [
    { remote: 'git@github.com:acme/nova-wing.git\n', available: true },
    { remote: 'ssh://git@github.com/acme/nova-wing.git\n', available: true },
    { remote: 'https://user:pass@github.com/acme/nova-wing.git\n', available: false },
    { remote: 'https://ghp_xxx@github.com/acme/nova-wing.git\n', available: false },
    { remote: 'http://github.com/acme/nova-wing.git\n', available: false },
    { remote: 'https://github.com/acme/nova-wing.git?token=secret\n', available: false },
    { remote: 'https://github.com/acme/nova-wing.git#secret\n', available: false },
    { remote: 'https://github.com/acme/one.git\nhttps://github.com/acme/two.git\n', available: false },
  ]
  try {
    for (const entry of cases) {
      const launchpad = await createNovaWingLaunchpad({
        configDirectory: directory,
        dependencies: {
          async gitProcessRunner(_executable, args) {
            return args[0] === 'remote'
              ? { exitCode: 0, stdout: entry.remote, stderr: '' }
              : { exitCode: 0, stdout: 'feat/composer\n', stderr: '' }
          },
        },
      })
      try {
        const address = await launchpad.start()
        const response = await postBranch(launchpad, process.cwd(), {
          token: launchpad.getTokenForTest(), origin: address.url,
        })
        const body = await response.text()
        assert.equal(response.status, 200)
        assert.equal(JSON.parse(body).pushRemoteStatus, entry.available ? 'available' : 'unavailable')
        if (!entry.available) assert.doesNotMatch(body, /user|pass|ghp_xxx|token=secret|#secret|http:\/\//u)
      } finally {
        await launchpad.close()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer reuses a completed requestId only for the same canonical payload', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const orderedTasks = [
      { id: 'T011', goal: 'Implement a focused persistent model with deterministic tests.' },
      { id: 'T012', goal: 'Implement the follow-up validation.' },
    ]
    const first = await postCreate(launchpad, composerRequest('composer-create-request-0002', { tasks: orderedTasks }), auth)
    const repeated = await postCreate(launchpad, composerRequest('composer-create-request-0002', { tasks: orderedTasks }), auth)
    const second = await postCreate(launchpad, composerRequest('composer-create-request-0003'), auth)
    assert.equal(first.status, 202)
    assert.equal(repeated.status, 202)
    assert.equal(second.status, 202)
    assert.equal(state.createCalls, 2)
    assert.notEqual(state.receivedConfigIds[0], state.receivedConfigIds[1])
    const conflicting = await postCreate(launchpad, composerRequest('composer-create-request-0002', {
      tasks: [...orderedTasks].reverse(),
    }), auth)
    assert.equal(conflicting.status, 409)
    assert.deepEqual(await conflicting.json(), {
      error: 'IDEMPOTENCY_CONFLICT',
      message: '该 requestId 已用于不同的创建请求。',
    })
    assert.equal(state.createCalls, 2)
    const injected = await postCreate(launchpad, {
      ...composerRequest('composer-create-request-0004') as Record<string, unknown>, storageUrl: 'file:///tmp/old.db',
    }, auth)
    assert.equal(injected.status, 400)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer caps a long project basename in generated session ids', async () => {
  const directory = await createConfigDirectory()
  const targetRepo = join(directory, 'a'.repeat(100))
  await mkdir(targetRepo)
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state),
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('composer-create-request-0009', { targetRepo }), {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.match(state.receivedConfigIds[0]!, /^a{48}-\d{12}-[a-f0-9]{6}$/u)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad close waits for a pending Composer create before closing its app', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  let resolveCreate: (() => void) | undefined
  let signalCreateStarted: (() => void) | undefined
  const createGate = new Promise<void>((resolve) => { resolveCreate = resolve })
  const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve })
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      async createWorkSession(config, input) {
        state.createCalls += 1
        state.receivedServerPorts.push(input.serverPort)
        state.receivedConfigIds.push(config.session.id)
        state.receivedExecutorModels.push(config.executor.model)
        signalCreateStarted?.()
        await createGate
        return {
          controller: { start: () => ({ started: true }) },
          async start() { return { url: 'http://127.0.0.1:54321' } },
          isLive() { return true },
          hasActiveSession() { return true },
          async close() { state.closeCalls += 1 },
        }
      },
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  try {
    const address = await launchpad.start()
    const pendingRequest = postCreate(launchpad, composerRequest('composer-create-request-0010'), {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    await createStarted
    let closeFinished = false
    const closing = launchpad.close().then(() => { closeFinished = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closeFinished, false)
    resolveCreate?.()
    await closing
    await pendingRequest.catch(() => undefined)
    assert.equal(state.closeCalls, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad close bounds a Composer create that never resolves', async () => {
  const directory = await createConfigDirectory()
  let signalCreateStarted: (() => void) | undefined
  const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve })
  const shutdownTimeoutMs = 20
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      shutdownTimeoutMs,
      async createWorkSession() {
        signalCreateStarted?.()
        return new Promise<never>(() => undefined)
      },
      async gitProcessRunner() { return { exitCode: 0, stdout: 'feat/composer\n', stderr: '' } },
    },
  })
  let closeTimer: NodeJS.Timeout | undefined
  const keepAliveServer = http.createServer()
  await new Promise<void>((resolve) => keepAliveServer.listen(0, '127.0.0.1', resolve))
  try {
    const address = await launchpad.start()
    const pendingCreate = postCreate(launchpad, composerRequest('composer-create-request-0011'), {
      token: launchpad.getTokenForTest(), origin: address.url,
    }).catch(() => undefined)
    await createStarted
    const startedAt = Date.now()
    await Promise.race([
      launchpad.close(),
      new Promise<void>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Launchpad close exceeded its bounded shutdown timeout')), 500)
      }),
    ])
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    assert.ok(Date.now() - startedAt >= shutdownTimeoutMs, 'close should wait through the bounded shutdown timeout')
    void pendingCreate
  } finally {
    if (closeTimer !== undefined) clearTimeout(closeTimer)
    await launchpad.close()
    await new Promise<void>((resolve) => keepAliveServer.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Composer fails closed for invalid paths, non-git repositories, invalid limits, and missing allowed paths', async () => {
  const directory = await createConfigDirectory()
  const nonGit = await mkdtemp(join(tmpdir(), 'novawing-not-git-'))
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const invalidPath = await postCreate(launchpad, composerRequest('composer-create-request-0005', { targetRepo: 'relative/path' }), auth)
    assert.deepEqual(await invalidPath.json(), { error: 'INVALID_PROJECT_PATH', message: '项目目录必须是存在的绝对路径。' })
    const notGit = await postCreate(launchpad, composerRequest('composer-create-request-0006', { targetRepo: nonGit }), auth)
    assert.equal((await notGit.json() as { error: string }).error, 'NOT_A_GIT_REPOSITORY')
    const badLimits = await postCreate(launchpad, composerRequest('composer-create-request-0007', { softMinutes: 91, hardMinutes: 90 }), auth)
    assert.equal((await badLimits.json() as { error: string }).error, 'INVALID_LIMITS')
    const noPaths = await postCreate(launchpad, composerRequest('composer-create-request-0008', { guardian: {} }), auth)
    assert.equal((await noPaths.json() as { error: string }).error, 'MISSING_ALLOWED_PATHS')
    const emptyTasks = await postCreate(launchpad, composerRequest('composer-create-request-empty', { tasks: [] }), auth)
    assert.equal((await emptyTasks.json() as { error: string }).error, 'INVALID_REQUEST')
    const tooManyTasks = await postCreate(launchpad, composerRequest('composer-create-request-many', {
      tasks: Array.from({ length: 11 }, (_, index) => ({ id: `T${index}`, goal: 'Valid task goal.' })),
    }), auth)
    assert.equal((await tooManyTasks.json() as { error: string }).error, 'INVALID_REQUEST')
    const duplicateTasks = await postCreate(launchpad, composerRequest('composer-create-request-duplicate', {
      tasks: [{ id: 'T011', goal: 'First task.' }, { id: 'T011', goal: 'Second task.' }],
    }), auth)
    assert.equal((await duplicateTasks.json() as { error: string }).error, 'DUPLICATE_TASK_ID')
    const invalidGoal = await postCreate(launchpad, composerRequest('composer-create-request-invalid-goal', {
      tasks: [{ id: 'T011', goal: '   ' }],
    }), auth)
    assert.equal((await invalidGoal.json() as { error: string }).error, 'INVALID_TASK')
    const tooLongGoal = await postCreate(launchpad, composerRequest('composer-create-request-too-long', {
      tasks: [{ id: 'T011', goal: 'x'.repeat(8_001) }],
    }), auth)
    assert.deepEqual(await tooLongGoal.json(), {
      error: 'INVALID_TASK_TOO_LONG',
      message: 'Task 描述过长，最大 8000 字符。',
    })
    const missingPushRemote = await postCreate(launchpad, composerRequest('composer-create-request-0011', { autoPush: true }), auth)
    assert.equal((await missingPushRemote.json() as { error: string }).error, 'AUTO_PUSH_REMOTE_UNAVAILABLE')
    const pushWithoutCommit = await postCreate(launchpad, composerRequest('composer-create-request-0012', {
      autoPush: true, autoCommit: false, pushRemote: { name: 'origin', expectedUrl: 'https://github.com/acme/nova-wing.git' },
    }), auth)
    assert.equal((await pushWithoutCommit.json() as { error: string }).error, 'AUTO_PUSH_REQUIRES_AUTO_COMMIT')
    const malformedPushRemote = await postCreate(launchpad, composerRequest('composer-create-request-0013', {
      autoPush: true, pushRemote: { name: 'origin', expectedUrl: 'not a remote' },
    }), auth)
    assert.equal((await malformedPushRemote.json() as { error: string }).error, 'INVALID_PUSH_REMOTE')
    const unknownBindingRequest = composerRequest('composer-create-request-unknown-binding', {
      guardian: { allowedPaths: ['packages/**'], acceptanceCriteria: ['known'], acceptanceEvidenceBindings: [{ criterion: 'unknown', requiredEvidence: ['npm test'] }] },
    })
    assert.deepEqual((unknownBindingRequest as { guardian: { acceptanceEvidenceBindings: unknown } }).guardian.acceptanceEvidenceBindings, [{ criterion: 'unknown', requiredEvidence: ['npm test'] }])
    const unknownBinding = await postCreate(launchpad, unknownBindingRequest, auth)
    const unknownBindingBody = await unknownBinding.json() as { error?: string; issues?: Array<{ issueCode: string }> }
    assert.equal(unknownBindingBody.error, 'TASK_CONTRACT_INVALID', JSON.stringify(unknownBindingBody))
    assert.ok(unknownBindingBody.issues?.some((issue) => issue.issueCode === 'BINDING_IDENTITY_MISMATCH'))
    assert.equal(state.createCalls, 0)
    const duplicateBinding = await postCreate(launchpad, composerRequest('composer-create-request-duplicate-binding', {
      guardian: { allowedPaths: ['packages/**'], acceptanceCriteria: ['known'], acceptanceEvidenceBindings: [
        { criterion: 'known', requiredEvidence: ['npm test'] }, { criterion: 'known', requiredEvidence: ['git diff --check'] },
      ] },
    }), auth)
    assert.equal(duplicateBinding.status, 202, JSON.stringify(await duplicateBinding.clone().json()))
    assert.equal(state.createCalls, 1)
    assert.deepEqual(state.receivedConfigs[0]?.tasks[0]?.acceptanceEvidenceBindings?.slice(-1), [{
      criterion: 'known', requiredEvidence: ['npm test', 'git diff --check'],
    }])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
    await rm(nonGit, { recursive: true, force: true })
  }
})

await test('Launchpad rejects a foreign Host before serving bootstrap HTML', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const result = await requestWithHost(address.port, 'evil.example')
    assert.equal(result.status, 403)
    assert.doesNotMatch(result.body, new RegExp(launchpad.getTokenForTest(), 'u'))
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad mutation requires both same Origin and the ephemeral token', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    assert.equal((await postStart(launchpad, { configId }, { origin: address.url })).status, 403)
    assert.equal((await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(),
      origin: 'http://evil.example',
    })).status, 403)
    assert.equal((await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(),
    })).status, 403)
    assert.equal(state.createCalls, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Browser can submit only a discovered configId, never an arbitrary config path', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    assert.equal((await postStart(launchpad, { path: 'C:/whatever.json' }, auth)).status, 400)
    assert.equal((await postStart(launchpad, {
      configId: launchpad.getConfigs()[0]!.configId,
      path: 'C:/whatever.json',
    }, auth)).status, 400)
    assert.equal((await postStart(launchpad, { configId: '0'.repeat(32) }, auth)).status, 404)
    assert.equal(state.createCalls, 0)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Deleting a trusted config removes its file, Map entry, and rediscovered card', async () => {
  const directory = await createConfigDirectory()
  const configPath = join(directory, 'fly-weave.json')
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const response = await postDelete(launchpad, { configId }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    await assert.rejects(access(configPath), { code: 'ENOENT' })
    assert.deepEqual(launchpad.getConfigs(), [])
    const currentHtml = await (await fetch(address.url)).text()
    assert.doesNotMatch(currentHtml, /data-config-card=/u)
    assert.match(currentHtml, /没有发现可启动的 Work Session/u)
  } finally {
    await launchpad.close()
  }

  const reopened = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    assert.deepEqual(reopened.getConfigs(), [])
    const reopenedAddress = await reopened.start()
    const reopenedHtml = await (await fetch(reopenedAddress.url)).text()
    assert.doesNotMatch(reopenedHtml, /data-config-card=/u)
  } finally {
    await reopened.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Deleting one trusted config preserves every other config file and card', async () => {
  const directory = await createConfigDirectory()
  const keptPath = join(directory, 'keep.json')
  await writeFile(keptPath, JSON.stringify(trustedConfig({ sessionId: 'keep-session', goal: 'Keep this card' })), 'utf8')
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const deleted = launchpad.getConfigs().find((config) => config.goal === 'AgentRun Persistence')
    assert.ok(deleted)
    const response = await postDelete(launchpad, { configId: deleted.configId }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(launchpad.getConfigs().map((config) => config.goal), ['Keep this card'])
    await access(keptPath)
    await assert.rejects(access(join(directory, 'fly-weave.json')), { code: 'ENOENT' })
    const html = await (await fetch(address.url)).text()
    assert.match(html, /Keep this card/u)
    assert.doesNotMatch(html, /AgentRun Persistence/u)
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.json')).length, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Deleting an unknown configId fails safely without deleting any file', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const response = await postDelete(launchpad, { configId: '0'.repeat(32) }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'UNKNOWN_CONFIG' })
    await access(join(directory, 'fly-weave.json'))
    assert.equal(launchpad.getConfigs().length, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete API rejects every client-supplied path field and cannot redirect deletion', async () => {
  const directory = await createConfigDirectory()
  const otherPath = join(directory, 'other.json')
  await writeFile(otherPath, JSON.stringify(trustedConfig({ sessionId: 'other-session', goal: 'Other config' })), 'utf8')
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const configId = launchpad.getConfigs().find((config) => config.goal === 'AgentRun Persistence')!.configId
    const response = await postDelete(launchpad, {
      configId,
      configPath: otherPath,
      filename: '../other.json',
    }, auth)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' })
    await access(join(directory, 'fly-weave.json'))
    await access(otherPath)
    assert.equal(launchpad.getConfigs().length, 2)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete API requires both same Origin and the ephemeral token', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    assert.equal((await postDelete(launchpad, { configId }, { origin: address.url })).status, 403)
    assert.equal((await postDelete(launchpad, { configId }, {
      token: launchpad.getTokenForTest(), origin: 'http://evil.example',
    })).status, 403)
    await access(join(directory, 'fly-weave.json'))
    assert.equal(launchpad.getConfigs().length, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete API refuses pending starts and running apps without closing them', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  let releaseCreate: (() => void) | undefined
  let signalCreateStarted: (() => void) | undefined
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
  const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve })
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      async createWorkSession(config, input) {
        state.createCalls += 1
        state.receivedServerPorts.push(input.serverPort)
        state.receivedConfigIds.push(config.session.id)
        state.receivedExecutorModels.push(config.executor.model)
        signalCreateStarted?.()
        await createGate
        return {
          controller: { start: () => { state.controllerStartCalls += 1; return { started: true } } },
          async start() { state.startCalls += 1; return { url: 'http://127.0.0.1:54321' } },
          isLive() { return true },
          hasActiveSession() { return true },
          async close() { state.closeCalls += 1 },
        }
      },
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const configId = launchpad.getConfigs()[0]!.configId
    const pendingStart = postStart(launchpad, { configId }, auth)
    await createStarted
    const whileStarting = await postDelete(launchpad, { configId }, auth)
    assert.equal(whileStarting.status, 409)
    assert.deepEqual(await whileStarting.json(), { error: 'SESSION_ACTIVE' })
    await access(join(directory, 'fly-weave.json'))
    assert.equal(state.closeCalls, 0)

    releaseCreate?.()
    assert.equal((await pendingStart).status, 202)
    const whileRunning = await postDelete(launchpad, { configId }, auth)
    assert.equal(whileRunning.status, 409)
    assert.deepEqual(await whileRunning.json(), { error: 'SESSION_ACTIVE' })
    await access(join(directory, 'fly-weave.json'))
    assert.equal(state.closeCalls, 0)
  } finally {
    releaseCreate?.()
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete API permits a config after its control app has closed', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const configId = launchpad.getConfigs()[0]!.configId
    assert.equal((await postStart(launchpad, { configId }, auth)).status, 202)
    await state.createdApps[0]!.close()

    const response = await postDelete(launchpad, { configId }, auth)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    assert.equal(state.closeCalls, 1, 'closed apps are retired idempotently')
    assert.deepEqual(launchpad.getConfigs(), [])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete API retires a settled repository-drift zombie control app', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      // Models a recoverable control surface after fail-closed repository drift:
      // the listener remains open, but the resume operation has settled.
      createWorkSession: fakeWorkSessionFactory(state, { controllerStarted: false, sessionActive: false }),
    },
  })
  try {
    const address = await launchpad.start()
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const configId = launchpad.getConfigs()[0]!.configId
    assert.equal((await postStart(launchpad, { configId }, auth)).status, 202)

    const response = await postDelete(launchpad, { configId }, auth)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    assert.equal(state.closeCalls, 1)
    await assert.rejects(access(join(directory, 'fly-weave.json')), { code: 'ENOENT' })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete trusts a discovered direct-child config without launch-time schema revalidation', async () => {
  const directory = await createConfigDirectory()
  let loadCalls = 0
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      async loadConfig(configPath) {
        loadCalls += 1
        if (loadCalls > 1) throw new Error('legacy config no longer matches the current schema')
        return loadTrustedWorkSessionConfig(configPath)
      },
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postDelete(launchpad, { configId: launchpad.getConfigs()[0]!.configId }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    assert.equal(loadCalls, 1, 'delete must use the discovery-time trusted Map entry')
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Delete rejects an injected non-child configPath with a stable safe error code', async () => {
  const directory = await createConfigDirectory()
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'novawing-launchpad-outside-'))
  const outsidePath = join(outsideDirectory, 'outside.json')
  await writeFile(outsidePath, JSON.stringify(trustedConfig({ sessionId: 'outside-session' })), 'utf8')
  const discovered = await discoverTrustedWorkSessionConfigs(directory)
  discovered[0]!.configPath = outsidePath
  const launchpad = new NovaWingLaunchpad(discovered, directory)
  try {
    const address = await launchpad.start()
    const response = await postDelete(launchpad, { configId: launchpad.getConfigs()[0]!.configId }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 500)
    const text = await response.text()
    assert.deepEqual(JSON.parse(text), { error: 'DELETE_FAILED' })
    assert.doesNotMatch(text, /outside\.json|novawing-launchpad-outside/u)
    await access(outsidePath)
    await access(join(directory, 'fly-weave.json'))
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
    await rm(outsideDirectory, { recursive: true, force: true })
  }
})

await test('Delete API treats an already-missing config file as success and removes the ghost Map entry', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    await rm(join(directory, 'fly-weave.json'))
    const response = await postDelete(launchpad, { configId }, {
      token: launchpad.getTokenForTest(), origin: address.url,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { deleted: true })
    assert.deepEqual(launchpad.getConfigs(), [])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Browser delete confirmation removes only the successful card and reveals the empty state', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const appJs = await (await fetch(`${address.url}/app.js`)).text()
    const errorElement = { textContent: '' }
    let cardRemoved = false
    const card = {
      querySelector(selector: string) { return selector === '[data-launch-error]' ? errorElement : undefined },
      remove() { cardRemoved = true },
    }
    const sessionList = {
      hidden: false,
      querySelector(selector: string) {
        return selector === '[data-config-card]' && !cardRemoved ? card : undefined
      },
    }
    const emptyState = { hidden: true }
    let deleteListener: (() => Promise<void>) | undefined
    const deleteButton = {
      dataset: { deleteConfigId: configId },
      disabled: false,
      textContent: '删除',
      addEventListener(type: string, listener: () => Promise<void>) {
        if (type === 'click') deleteListener = listener
      },
      closest(selector: string) { return selector === '[data-config-card]' ? card : undefined },
    }
    let confirmMessage = ''
    let confirmAllowed = false
    let submittedBody: unknown
    const document = {
      getElementById(id: string) {
        return id === 'novawing-bootstrap'
          ? { textContent: JSON.stringify({ launchToken: launchpad.getTokenForTest(), serverOrigin: address.url }) }
          : undefined
      },
      querySelectorAll(selector: string) {
        if (selector === '[data-delete-config-id]') return [deleteButton]
        return []
      },
      querySelector(selector: string) {
        if (selector === '[data-session-list]') return sessionList
        if (selector === '[data-empty-state]') return emptyState
        return undefined
      },
    }
    const browserFetch = async (path: string, init: RequestInit): Promise<Response> => {
      submittedBody = JSON.parse(String(init.body)) as unknown
      return fetch(`${address.url}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Origin: address.url },
      })
    }
    vm.runInNewContext(appJs, {
      document,
      fetch: browserFetch,
      window: {
        confirm(message: string) { confirmMessage = message; return confirmAllowed },
        location: { assign() { throw new Error('delete must not navigate') } },
      },
    })
    assert.ok(deleteListener)
    await deleteListener()
    assert.equal(confirmMessage, '确定删除这个 Work Session 吗？此操作只删除 NovaWing Launchpad 配置，不会删除项目代码。')
    assert.equal(submittedBody, undefined)
    assert.equal(cardRemoved, false)
    assert.equal(sessionList.hidden, false)
    assert.equal(emptyState.hidden, true)

    confirmAllowed = true
    await deleteListener()
    assert.deepEqual(submittedBody, { configId })
    assert.equal(cardRemoved, true)
    assert.equal(sessionList.hidden, true)
    assert.equal(emptyState.hidden, false)
    assert.equal(errorElement.textContent, '')
    assert.deepEqual(launchpad.getConfigs(), [])
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launchpad revalidates the config, passes serverPort=0, and returns the real control URL', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  let loadCalls = 0
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      async loadConfig(path) {
        loadCalls += 1
        return loadTrustedWorkSessionConfig(path)
      },
      createWorkSession: fakeWorkSessionFactory(state),
      async resolveEnvironment() { return { SAFE_MODEL_NAME: 'test' } },
    },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const response = await postStart(launchpad, { configId }, {
      token: launchpad.getTokenForTest(),
      origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), {
      accepted: true,
      controlUrl: 'http://127.0.0.1:54321',
    })
    assert.equal(loadCalls, 2, 'discovery plus launch-time revalidation')
    assert.equal(state.receivedConfigs[0]!.session.controlPlane, undefined)
    assert.equal((await loadTrustedWorkSessionConfig(join(directory, 'fly-weave.json'))).session.controlPlane, undefined)
    assert.deepEqual(state.receivedServerPorts, [0])
    assert.deepEqual(state.receivedConfigIds, ['launchpad-test'])
    assert.equal(state.controllerStartCalls, 1)
  } finally {
    await launchpad.close()
    assert.equal(state.closeCalls, 1)
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Duplicate clicks reuse one Work Session app and one control URL', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: { createWorkSession: fakeWorkSessionFactory(state) },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const first = await postStart(launchpad, { configId }, auth)
    const second = await postStart(launchpad, { configId }, auth)
    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    assert.equal(state.createCalls, 1)
    assert.equal(state.startCalls, 1)
    assert.equal(state.controllerStartCalls, 1)
    assert.deepEqual(await second.json(), {
      accepted: true,
      controlUrl: 'http://127.0.0.1:54321',
      alreadyStarted: true,
    })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('A durable restored session opens its control surface without starting a duplicate run', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state, { controllerStarted: false }),
    },
  })
  try {
    const address = await launchpad.start()
    const response = await postStart(launchpad, { configId: launchpad.getConfigs()[0]!.configId }, {
      token: launchpad.getTokenForTest(),
      origin: address.url,
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), {
      accepted: true,
      controlUrl: 'http://127.0.0.1:54321',
      alreadyStarted: true,
    })
    assert.equal(state.createCalls, 1)
    assert.equal(state.controllerStartCalls, 1)
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Launch failure returns only a safe product error and permits a later retry', async () => {
  const directory = await createConfigDirectory()
  const state = emptyFakeState()
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeWorkSessionFactory(state, {
        failWith: new Error('SMTP_PASSWORD=raw-secret credential failure'),
      }),
    },
  })
  try {
    const address = await launchpad.start()
    const configId = launchpad.getConfigs()[0]!.configId
    const auth = { token: launchpad.getTokenForTest(), origin: address.url }
    const first = await postStart(launchpad, { configId }, auth)
    const second = await postStart(launchpad, { configId }, auth)
    assert.equal(first.status, 500)
    assert.equal(second.status, 500)
    assert.deepEqual(await first.json(), { error: 'Work Session 启动失败' })
    assert.equal(state.createCalls, 2)
    const deleted = await postDelete(launchpad, { configId }, auth)
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { deleted: true })
  } finally {
    await launchpad.close()
    await rm(directory, { recursive: true, force: true })
  }
})

await test('Browser detection prefers Edge and falls back to Chrome', async () => {
  const env = {
    PROGRAMFILES: 'C:/Program Files',
    'PROGRAMFILES(X86)': 'C:/Program Files (x86)',
  }
  const edge = await findBrowserExecutable(env, async () => true)
  assert.equal(edge?.kind, 'edge')
  assert.match(edge?.executable ?? '', /Program Files \(x86\).*Microsoft.*Edge.*msedge\.exe/u)

  const chrome = await findBrowserExecutable(env, async (path) => path.includes('Google'))
  assert.equal(chrome?.kind, 'chrome')
  assert.match(chrome?.executable ?? '', /Program Files.*Google.*Chrome.*chrome\.exe/u)
})

await test('App Mode uses spawn argv without a shell and browser absence does not crash', async () => {
  const calls: Array<{
    executable: string
    args: readonly string[]
    shell: boolean
    detached: boolean
  }> = []
  let unrefCalled = false
  const spawnBrowser: BrowserProcessSpawner = (executable, args, options) => {
    calls.push({ executable, args, shell: options.shell, detached: options.detached })
    return {
      once() { return undefined },
      unref() { unrefCalled = true },
    }
  }
  const env = { 'PROGRAMFILES(X86)': 'C:/Program Files (x86)' }
  const opened = await openLaunchpadInAppMode('http://127.0.0.1:43199', {
    env,
    pathExists: async () => true,
    spawnBrowser,
  })
  assert.deepEqual(opened, { opened: true, browser: 'edge' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args.slice(0, 2), [
    '--app=http://127.0.0.1:43199',
    '--new-window',
  ])
  assert.equal(calls[0]!.shell, false)
  assert.equal(calls[0]!.detached, true)
  assert.equal(unrefCalled, true)

  let spawnCalled = false
  const unavailable = await openLaunchpadInAppMode('http://127.0.0.1:43199', {
    env,
    pathExists: async () => false,
    spawnBrowser() {
      spawnCalled = true
      throw new Error('must not spawn')
    },
  })
  assert.deepEqual(unavailable, { opened: false })
  assert.equal(spawnCalled, false)
})

await test('Repository exposes the launchpad npm script and relocatable hidden VBS entry', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(
    packageJson.scripts['guardian:launchpad'],
    'npm run build && node scripts/guardian-launchpad.mjs',
  )
  const vbs = await readFile(join(process.cwd(), 'NovaWing.vbs'), 'utf8')
  assert.match(vbs, /WScript\.ScriptFullName/u)
  assert.match(vbs, /shell\.Run command, 0, False/u)
  assert.doesNotMatch(vbs, /D:\\VSCode\\nova-wing/iu)
})

function requestWithHost(port: number, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: { Host: hostHeader },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', rejectRequest)
    request.end()
  })
}

test('new Launchpad HTTP creation persists Golden default and production completes without Controller decisions', async () => {
  const root = await codexTestRepo()
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { 'test:source': 'node --test tests/source.test.js' } }, null, 2))
  await writeFile(join(root, 'tests', 'source.test.js'), 'import test from "node:test"\nimport assert from "node:assert/strict"\ntest("source", () => assert.ok(true))\n')
  execFileSync('git', ['add', '.'], { cwd: root, windowsHide: true })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture: add source verifier'], { cwd: root, windowsHide: true })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-launchpad-v2-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  let codexCalls = 0
  const states: TaskStateV2[] = []
  const phases: string[] = []
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory, dependencies: {
    resolveEnvironment: async () => ({ LOCALAPPDATA: directory }),
    preflight: (targetRepo, controlPlane) => {
      assert.equal(controlPlane, 'v2')
      return runProductionDependencyPreflight({ ...(targetRepo === undefined ? {} : { targetRepo }), controlPlane, executorModes: ['codex'],
        inspectCodex: async () => undefined, accessFile: async () => undefined,
        env: { NOVAWING_ASK_BRIDGE_PATH: 'missing-ask-bridge.exe' },
        commandRunner: async (request) => ({ exitCode: request.executable === 'missing-ask-bridge.exe' ? 1 : 0,
          stdout: request.args.at(-1)?.includes('BASH_VERSION') ? '5.2.37|MINGW64|msys' : 'ok', stderr: '' }),
      })
    },
    gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
    createWorkSession: (config, input) => createProductionWorkSessionUi(config, {
      ...input,
      createRuntime(value) { runtime = value; return new FakeRuntime(value.definition) },
      createBrain() { throw new Error('AskBridge transport unavailable') },
      createV2Dispatcher: ({ defaultDispatcher }) => ({
        inspectRepository: defaultDispatcher.inspectRepository,
        async dispatch({ action, task }) {
          if (action === 'EXECUTE') {
            codexCalls++
            await writeFile(join(root, 'src', 'a.ts'), 'export const value = 2\n')
            return { status: 'SUCCESS', changedFiles: ['src/a.ts'], providerHistory: ['codex'] }
          }
          if (action === 'VERIFY') return { status: 'SUCCESS', verificationResults: task.verificationPlan!.steps.map((step) => ({
            name: step.command,
            stepId: step.id,
            command: step.command,
            cwd: step.cwd,
            status: 'passed',
          })) }
          return { status: 'BLOCKED', blockers: [`unexpected ${action}`] }
        },
      }),
    }),
  } })
  try {
    const address = await launchpad.start()
    const response = await postCreate(launchpad, composerRequest('launchpad-production-v2-default', {
      targetRepo: root, tasks: [{ id: 'D01', goal: 'Fix a focused source helper' }],
      guardian: { allowedPaths: ['src/**'], acceptanceCriteria: ['source helper behavior passes its focused test'] },
      directPathEnabled: true, goldenPathEnabled: true, autoCommit: false,
    }), { token: launchpad.getTokenForTest(), origin: address.url })
    assert.equal(response.status, 202, await response.text())
    const discovered = await discoverTrustedWorkSessionConfigs(directory)
    assert.equal(discovered.length, 1)
    assert.equal(discovered[0]!.config.session.controlPlane, 'v2')
    const serialized = JSON.parse(await readFile(discovered[0]!.configPath, 'utf8'))
    assert.equal(serialized.session.controlPlane, 'v2')
    assert.deepEqual(serialized.session.goldenPath, { enabled: true })
    assert.equal(runtime!.definition.controlPlane, 'v2')
    assert.equal(runtime!.definition.goldenPath?.enabled, true)
    assert.ok(runtime!.taskRunner instanceof GoldenPathTaskRunner)
    const events = new TaskEventLogV2()
    const result = await runtime!.taskRunner.run(runtime!.definition.tasks[0]!, undefined, undefined, {
      persistTaskStateV2: async (state) => { states.push(structuredClone(state)) },
      onProgress: (event) => { phases.push(event.phase) },
      taskEventLog: events,
    })
    assert.equal(codexCalls, 1)
    assert.equal(result.status, 'COMPLETED', JSON.stringify({
      humanRequired: result.humanRequired,
      requiredSteps: result.taskStateV2?.verificationPlan?.steps,
      verificationResults: result.taskStateV2?.verificationState.results,
    }))
    assert.equal(events.count('CONTROLLER_DECIDED'), 0)
    assert.equal(result.taskStateV2?.identity.taskId, 'D01')
    assert.notEqual(result.status, 'BRAIN_INFRASTRUCTURE_FAILED')
    assert.doesNotMatch(phases.join(' '), /REVIEW|BRAIN/i)
    // Launchpad has no evidence-binding editor yet; execution is not a claim of semantic completion.
  } finally {
    await launchpad.close()
    await rm(root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('DOGFOOD-001 Quick Fill replaces or clears stale project, task and permission fields', async () => {
  const directory = await createConfigDirectory()
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await launchpad.start()
    const script = await (await fetch(`${address.url}/app.js`)).text()
    const start = script.indexOf('const applyBriefAnalysis =')
    const end = script.indexOf("briefFill.addEventListener", start)
    assert.ok(start >= 0 && end > start)
    const targetRepo = { value: 'old-repo' }
    const branch = { value: 'old-branch' }
    const taskId = { value: 'OLD' }
    const elements = Object.fromEntries(['allowedPaths', 'forbiddenPaths', 'constraints', 'acceptanceCriteria', 'acceptanceEvidenceBindings', 'doNotDo'].map((key) => [key, { value: 'old' }]))
    const briefResult = { textContent: '' }
    const context = vm.createContext({ targetRepo, branch, form: { elements }, briefResult,
      taskRows: () => [{ querySelector: () => taskId }], discoverTargetRepo() {}, updatePushRemote() {}, updateSchedule() {},
    })
    vm.runInContext(script.slice(start, end) + ';globalThis.apply = applyBriefAnalysis', context)
    vm.runInContext("apply({ fields: { targetRepo: 'new-repo', taskId: 'D01', allowedPaths: ['src/**'] } }, true)", context)
    assert.equal(targetRepo.value, 'new-repo')
    assert.equal(taskId.value, 'D01')
    assert.equal(elements.allowedPaths!.value, 'src/**')
    assert.equal(branch.value, '')
    vm.runInContext('apply({ fields: {} }, false)', context)
    assert.equal(targetRepo.value, 'new-repo', 'model advice alone does not modify fields')
    vm.runInContext('apply({ fields: {} }, true)', context)
    assert.equal(targetRepo.value, '')
    assert.equal(taskId.value, '')
    for (const field of Object.values(elements)) assert.equal(field.value, '')
    assert.match(briefResult.textContent, /已清空/)
    assert.match(script, /catch \(cause\) \{\s*applyBriefAnalysis\(\{ fields: \{\} \}, true\)/)
    assert.match(script, /TASK_CONTRACT_INVALID/)
    assert.match(script, /issue\.issueCode/)
  } finally { await launchpad.close(); await rm(directory, { recursive: true, force: true }) }
})
