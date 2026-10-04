import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import {
  createLlmRepairAgent,
  createNovaWingLaunchpad,
  isAutoRepairableIssueSet,
  MAX_AUTO_REPAIR_CYCLES,
  projectTaskRun,
  WorkSessionRuntime,
  type RepairAgent,
  type RepairAuditEntry,
  type RepairAuditSink,
  type RepairModelRunner,
  type RepairNotification,
  type RepairNotifier,
  type TrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'
import { createTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import type { TaskContractIssue } from '../packages/development-guardian/work-session/launchpad/contract-preflight.js'

async function repoFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-auto-repair-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

interface RecordedLaunch {
  configs: TrustedWorkSessionConfig[]
}

function fakeApp(recorded: RecordedLaunch) {
  return async (config: TrustedWorkSessionConfig) => {
    recorded.configs.push(config)
    return {
      controller: { start: () => ({ started: true }) },
      start: async () => ({ url: 'http://127.0.0.1:54321' }),
      isLive: () => true,
      hasActiveSession: () => true,
      close: async () => undefined,
    }
  }
}

interface RecordingDeps {
  notifications: RepairNotification[]
  audit: RepairAuditEntry[]
  llmCalls: number
}

function recordingNotifier(recorded: RecordingDeps): RepairNotifier {
  return { notify: async (notification) => { recorded.notifications.push(notification) } }
}

function recordingAudit(recorded: RecordingDeps): RepairAuditSink {
  return { record: async (entry) => { recorded.audit.push(entry) } }
}

function scriptedLlmAgent(runner: RepairModelRunner): RepairAgent {
  return createLlmRepairAgent({
    runner,
    describeRepository: async () => ({ packageScripts: { test: 'node --test' }, testFileCandidates: [], topLevelEntries: [], hasPytestConfig: false, hasVenvPython: false }),
    isRuntimeAvailable: () => true,
  })
}

function decliningLlmAgent(recorded: RecordingDeps): RepairAgent {
  return {
    id: 'test-declining-llm',
    async repair() {
      recorded.llmCalls += 1
      return { classification: 'REPAIR_REJECTED', reason: 'test LLM agent declines' }
    },
  }
}

/** A criterion the deterministic agent cannot judge, but a model can bind. */
const LLM_ONLY_CRITERION = 'AC1 label formatting matches every specified example'

function composerRequest(requestId: string, repo: string, guardian: Record<string, unknown>): unknown {
  return {
    requestId,
    targetRepo: repo,
    tasks: [{ id: 'D01', goal: 'Fix a focused source helper.' }],
    autoCommit: false,
    guardian: { allowedPaths: ['src/**'], ...guardian },
  }
}

async function postJson(launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>, path: string, body: unknown): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return sessionFetch(`${address.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': await mintSession(launchpad), Origin: address.url },
    body: JSON.stringify(body),
  })
}

test('the auto-repairable taxonomy is exactly the existing safe mechanical set', () => {
  const issue = (issueCode: TaskContractIssue['issueCode']): TaskContractIssue => ({ issueCode, reason: 'x' })
  assert.equal(isAutoRepairableIssueSet([]), false)
  assert.equal(isAutoRepairableIssueSet([issue('MISSING_EVIDENCE_BINDING')]), true)
  assert.equal(isAutoRepairableIssueSet([issue('UNRESOLVED_PLACEHOLDER'), issue('TEST_PATH_NOT_FOUND')]), true)
  assert.equal(isAutoRepairableIssueSet([issue('VERIFIER_APPROVAL_REQUIRED')]), false, 'approval is a human decision')
  assert.equal(isAutoRepairableIssueSet([issue('DUPLICATE_CRITERION')]), false, 'a semantic conflict is not mechanical')
  assert.equal(isAutoRepairableIssueSet([issue('BINDING_IDENTITY_MISMATCH')]), false)
  assert.equal(isAutoRepairableIssueSet([issue('MISSING_EVIDENCE_BINDING'), issue('VERIFIER_APPROVAL_REQUIRED')]), false, 'one unsafe issue blocks the whole automatic path')
})

test('an unattended create consults the model only when the deterministic agent cannot finish', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-auto-repair-configs-'))
  const recorded: RecordedLaunch = { configs: [] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: scriptedLlmAgent(async () => ({ text: JSON.stringify({ acceptanceEvidenceBindings: [{ criterion: LLM_ONLY_CRITERION, requiredEvidence: ['npm test'] }] }) })),
      repairProvider: { id: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    },
  })
  try {
    await startOperator(launchpad)
    const response = await postJson(launchpad, '/api/session/create', composerRequest('auto-repair-llm-0001', repo, {
      acceptanceCriteria: [LLM_ONLY_CRITERION],
    }))
    const responseText = await response.text()
    assert.equal(response.status, 202, responseText)
    assert.equal(recorded.configs.length, 1)
    assert.equal(recorded.configs[0]!.tasks[0]!.acceptanceEvidenceBindings?.find((binding) => binding.criterion === LLM_ONLY_CRITERION)?.requiredEvidence[0], 'npm test')
    const entry = deps.audit[0]!
    assert.equal(entry.automatic, true)
    assert.deepEqual(entry.stages.map((stage) => stage.agent), ['deterministic', 'llm'])
    assert.equal(entry.llmInvoked, true)
    assert.equal(entry.autoRepair?.cycles, 2)
    assert.equal(entry.autoRepair?.maxCycles, MAX_AUTO_REPAIR_CYCLES)
    assert.equal(entry.autoRepair?.exhausted, false)
    assert.deepEqual(entry.autoRepair?.events.map((event) => event.event), [
      'AUTO_REPAIR_STARTED', 'AUTO_REPAIR_DETERMINISTIC', 'AUTO_REPAIR_LLM_STARTED', 'AUTO_REPAIR_VALIDATED', 'AUTO_REPAIR_SUCCEEDED',
    ])
    assert.equal(entry.autoRepair?.events.find((event) => event.event === 'AUTO_REPAIR_LLM_STARTED')?.provider?.model, 'gpt-5.6-terra')
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('the automatic cascade stops at its bounded cycle count and reports AUTO_REPAIR_EXHAUSTED', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-auto-repair-configs-'))
  const recorded: RecordedLaunch = { configs: [] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  let stageCalls = 0
  const countingLlmAgent: RepairAgent = {
    id: 'test-counting-llm',
    async repair() {
      deps.llmCalls += 1
      stageCalls += 1
      return { classification: 'REPAIR_REJECTED', reason: `declined on cycle ${stageCalls}` }
    },
  }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: countingLlmAgent,
    },
  })
  try {
    await startOperator(launchpad)
    const response = await postJson(launchpad, '/api/session/create', composerRequest('auto-repair-exhausted-0002', repo, {
      acceptanceCriteria: [LLM_ONLY_CRITERION],
    }))
    assert.equal(response.status, 400)
    const body = await response.json() as {
      error?: string
      repairable?: boolean
      issues?: Array<{ issueCode: string }>
      autoRepair?: { result?: string; cycles?: number; maxCycles?: number; exhausted?: boolean }
    }
    assert.equal(body.error, 'TASK_CONTRACT_INVALID')
    assert.equal(body.repairable, true, 'the operator fallback stays available')
    assert.ok(body.issues?.some((item) => item.issueCode === 'MISSING_EVIDENCE_BINDING'))
    assert.equal(body.autoRepair?.result, 'AUTO_REPAIR_EXHAUSTED')
    assert.equal(body.autoRepair?.cycles, MAX_AUTO_REPAIR_CYCLES)
    assert.equal(body.autoRepair?.maxCycles, MAX_AUTO_REPAIR_CYCLES)
    assert.equal(body.autoRepair?.exhausted, true)
    assert.equal(deps.llmCalls, 1, 'the model is consulted once, never in a spin loop')
    assert.equal(recorded.configs.length, 0, 'no Session is created from an unrepaired contract')
    assert.equal(deps.audit[0]!.autoRepair?.exhausted, true)
    assert.equal(deps.audit[0]!.stages.length, MAX_AUTO_REPAIR_CYCLES)
    assert.equal(deps.audit[0]!.autoRepair?.events.at(-1)?.event, 'AUTO_REPAIR_FAILED')
    assert.equal(deps.audit[0]!.autoRepair?.events.at(-1)?.reason, 'AUTO_REPAIR_EXHAUSTED')
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unsafe semantic issue never enters the automatic cascade', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-auto-repair-configs-'))
  const recorded: RecordedLaunch = { configs: [] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: decliningLlmAgent(deps),
    },
  })
  try {
    await startOperator(launchpad)
    const response = await postJson(launchpad, '/api/session/create', composerRequest('auto-repair-unsafe-0003', repo, {
      acceptanceCriteria: ['custom proof'],
      acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
    }))
    assert.equal(response.status, 400)
    const body = await response.json() as { issues?: Array<{ issueCode: string }>; autoRepair?: unknown }
    assert.ok(body.issues?.some((item) => item.issueCode === 'VERIFIER_APPROVAL_REQUIRED'))
    assert.equal(body.autoRepair, undefined, 'no unattended repair is attempted')
    assert.equal(deps.audit.length, 0, 'no repair attempt is audited')
    assert.equal(deps.llmCalls, 0, 'the model is never asked to grant approval')
    assert.equal(recorded.configs.length, 0)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

async function projectPreflightRepair(sessionId: string, automatic: boolean): Promise<{
  aiRepairCount: number
  humanActionCount: number
  humanDecisionCount: number
  repairTriggeredByUser: number
  zeroHumanCompletion: boolean | null
}> {
  const temp = await mkdtemp(join(tmpdir(), 'novawing-preflight-repair-'))
  const definition = {
    id: sessionId, targetRepo: process.cwd(), branch: 'main',
    tasks: [{ id: 'T1', goal: 'fixed goal' }],
    limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
  }
  const runtime = new WorkSessionRuntime({
    definition,
    storageUrl: pathToFileURL(join(temp, 'session.db')).href,
    taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
    preflightRepair: { automatic },
    notificationRetryDelayMs: 0,
  })
  try {
    const state = await runtime.start()
    const base = createTaskStateV2(definition, definition.tasks[0]!)
    return projectTaskRun({
      definition,
      task: { ...base, status: 'COMPLETED', currentAction: 'COMPLETE' },
      state,
      events: state.taskEventLogs?.['T1'] ?? [],
      finalStatus: 'COMPLETED',
    }).summary
  } finally {
    await runtime.close()
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

test('an automatic contract repair is AI repair, not a human action or decision', async () => {
  const automatic = await projectPreflightRepair('auto-preflight', true)
  assert.equal(automatic.aiRepairCount, 1)
  assert.equal(automatic.repairTriggeredByUser, 0)
  assert.equal(automatic.humanActionCount, 0)
  assert.equal(automatic.humanDecisionCount, 0)
  assert.equal(automatic.zeroHumanCompletion, true, 'the v0.2.5 zero-human definition is unchanged')
})

test('an operator retry is one human action, still counted as AI repair', async () => {
  const manual = await projectPreflightRepair('manual-preflight', false)
  assert.equal(manual.aiRepairCount, 1)
  assert.equal(manual.repairTriggeredByUser, 1)
  assert.equal(manual.humanActionCount, 1)
  assert.equal(manual.humanDecisionCount, 0, 'a retry click is not a semantic decision')
  assert.equal(manual.zeroHumanCompletion, false)
})
