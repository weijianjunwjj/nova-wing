import { mintSession, startOperator, sessionFetch } from './operator-session.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  classifyRepairErrorCode,
  createDeterministicRepairAgent,
  createLlmRepairAgent,
  createNovaWingLaunchpad,
  parseEffectiveRepairContract,
  parseRepairProposalJson,
  RepairProviderUnavailableError,
  validateMechanicalRepair,
  type RepairAgent,
  type RepairAgentOutcome,
  type RepairAuditEntry,
  type RepairAuditSink,
  type RepairContext,
  type RepairErrorCode,
  type RepairModelRunner,
  type RepairNotification,
  type RepairNotifier,
  type TrustedWorkSessionConfig,
} from 'nova-wing/development-guardian'
import {
  preflightTaskContract,
  resolveRepairTestEntry,
  type TaskContractIssue,
} from '../packages/development-guardian/work-session/launchpad/contract-preflight.js'
import type { AcceptanceEvidenceBinding } from '../packages/development-guardian/work-session/risk-evidence.js'

async function repoFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

function issue(issueCode: TaskContractIssue['issueCode'], criterion?: string): TaskContractIssue {
  return { issueCode, reason: 'deterministic preflight reason', ...(criterion === undefined ? {} : { criterion }) }
}

function repairContext(input: {
  targetRepo: string
  acceptanceCriteria: readonly string[]
  acceptanceEvidenceBindings?: readonly AcceptanceEvidenceBinding[]
  issues: readonly TaskContractIssue[]
  errorCode?: RepairErrorCode
}): RepairContext {
  return {
    errorCode: input.errorCode ?? 'TASK_CONTRACT_INVALID',
    issues: input.issues,
    contract: {
      acceptanceCriteria: input.acceptanceCriteria,
      acceptanceEvidenceBindings: input.acceptanceEvidenceBindings ?? [],
    },
    targetRepo: input.targetRepo,
    frozen: {},
  }
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

/**
 * A stand-in LLM agent. Tests never let the real model run: the deterministic
 * path must be provable on its own, and a scenario that expects no model call
 * asserts `llmCalls` stayed at zero.
 */
function recordingLlmAgent(
  recorded: RecordingDeps,
  outcome: RepairAgentOutcome = { classification: 'REPAIR_REJECTED', reason: 'test LLM agent declines' },
): RepairAgent {
  return {
    id: 'test-llm-agent',
    async repair() {
      recorded.llmCalls += 1
      return outcome
    },
  }
}

async function postJson(
  launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>,
  path: string,
  body: unknown,
): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return sessionFetch(`${address.url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': await mintSession(launchpad),
      Origin: address.url,
    },
    body: JSON.stringify(body),
  })
}

function composerRequest(requestId: string, repo: string, guardian: Record<string, unknown>): unknown {
  return {
    requestId,
    targetRepo: repo,
    tasks: [{ id: 'D01', goal: 'Fix a focused source helper.' }],
    autoCommit: false,
    guardian: { allowedPaths: ['src/**'], ...guardian },
  }
}

test('classifies raw preflight issues into the five product repair codes', () => {
  assert.equal(classifyRepairErrorCode([issue('MISSING_EVIDENCE_BINDING')]), 'MISSING_EVIDENCE_BINDING')
  assert.equal(classifyRepairErrorCode([issue('UNRESOLVED_PLACEHOLDER')]), 'PLACEHOLDER_UNRESOLVED')
  assert.equal(classifyRepairErrorCode([issue('VERIFIER_APPROVAL_REQUIRED')]), 'APPROVAL_PREFLIGHT_REQUIRED')
  assert.equal(classifyRepairErrorCode([issue('PACKAGE_SCRIPT_NOT_FOUND')]), 'INVALID_VERIFIER')
  assert.equal(classifyRepairErrorCode([issue('EMPTY_VERIFIER_COMMAND')]), 'INVALID_VERIFIER')
  assert.equal(classifyRepairErrorCode([issue('TEST_PATH_NOT_FOUND')]), 'INVALID_VERIFIER')
  assert.equal(classifyRepairErrorCode([issue('BINDING_IDENTITY_MISMATCH')]), 'TASK_CONTRACT_INVALID')
  assert.equal(classifyRepairErrorCode([]), undefined)
})

test('mechanical validation rejects a reworded, widened, or non-allowlisted repair', () => {
  const allowed = ['npm test', 'git diff --check']
  const original = { acceptanceCriteria: ['Tests pass'], acceptanceEvidenceBindings: [] as readonly AcceptanceEvidenceBinding[] }

  const reworded = {
    acceptanceCriteria: ['All tests pass'],
    acceptanceEvidenceBindings: [{ criterion: 'All tests pass', requiredEvidence: ['npm test'] }],
  }
  const rewordedResult = validateMechanicalRepair(original, reworded, allowed)
  assert.equal(rewordedResult.ok, false)
  if (!rewordedResult.ok) assert.ok(rewordedResult.reasons.some((reason) => reason.includes('rewords')))

  const bound = {
    acceptanceCriteria: ['Tests pass'],
    acceptanceEvidenceBindings: [{ criterion: 'Tests pass', requiredEvidence: ['npm test'] }],
  }
  const widened = {
    acceptanceCriteria: ['Tests pass'],
    acceptanceEvidenceBindings: [{ criterion: 'Tests pass', requiredEvidence: ['npm test'], requiresApproval: true }],
  }
  assert.equal(validateMechanicalRepair(bound, widened, allowed).ok, false)

  const nonAllowlisted = {
    acceptanceCriteria: ['Tests pass'],
    acceptanceEvidenceBindings: [{ criterion: 'Tests pass', requiredEvidence: ['rm -rf /'] }],
  }
  assert.equal(validateMechanicalRepair(bound, nonAllowlisted, allowed).ok, false)
})

test('deterministic agent binds missing evidence and resolves an unresolved placeholder', async () => {
  const root = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const checkRepo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { check: 'node --test' } }) })
  try {
    assert.equal(await resolveRepairTestEntry(root), 'npm test')
    assert.equal(await resolveRepairTestEntry(checkRepo), 'npm run check')

    const agent = createDeterministicRepairAgent()
    const missing = await agent.repair(repairContext({
      targetRepo: root,
      acceptanceCriteria: ['Tests pass'],
      issues: [issue('MISSING_EVIDENCE_BINDING', 'Tests pass')],
      errorCode: 'MISSING_EVIDENCE_BINDING',
    }))
    assert.equal(missing.classification, 'REPAIRED')
    assert.deepEqual(missing.proposal?.acceptanceEvidenceBindings, [{ criterion: 'Tests pass', requiredEvidence: ['npm test'] }])

    const placeholderPreflight = await preflightTaskContract({
      targetRepo: checkRepo,
      acceptanceCriteria: ['AC1 invalid input => npm test -- <对应测试>'],
      acceptanceEvidenceBindings: [],
    })
    assert.equal(placeholderPreflight.ok, false)
    if (placeholderPreflight.ok) return
    assert.ok(placeholderPreflight.issues.some((item) => item.issueCode === 'UNRESOLVED_PLACEHOLDER'))

    const effective = parseEffectiveRepairContract({ acceptanceCriteria: ['AC1 invalid input => npm test -- <对应测试>'], acceptanceEvidenceBindings: [] })
    const repaired = await agent.repair(repairContext({
      targetRepo: checkRepo,
      acceptanceCriteria: effective.acceptanceCriteria,
      acceptanceEvidenceBindings: effective.acceptanceEvidenceBindings,
      issues: placeholderPreflight.issues,
      errorCode: 'PLACEHOLDER_UNRESOLVED',
    }))
    assert.equal(repaired.classification, 'REPAIRED')
    assert.deepEqual(repaired.proposal?.acceptanceEvidenceBindings, [{ criterion: 'AC1 invalid input', requiredEvidence: ['npm run check'] }])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(checkRepo, { recursive: true, force: true })
  }
})

test('deterministic agent refuses approval and reports unknown issues as NovaWing product bugs', async () => {
  const root = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  try {
    const agent = createDeterministicRepairAgent()
    const approval = await agent.repair(repairContext({
      targetRepo: root,
      acceptanceCriteria: ['custom proof'],
      acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
      issues: [issue('VERIFIER_APPROVAL_REQUIRED', 'custom proof')],
      errorCode: 'APPROVAL_PREFLIGHT_REQUIRED',
    }))
    assert.equal(approval.classification, 'REPAIR_REJECTED')

    const unknown = await agent.repair(repairContext({
      targetRepo: root,
      acceptanceCriteria: ['Tests pass'],
      issues: [{ issueCode: 'UNEXPECTED_CODE' as TaskContractIssue['issueCode'], reason: 'x' }],
    }))
    assert.equal(unknown.classification, 'NOVAWING_PRODUCT_BUG')
    assert.ok(unknown.structuredRepairTask)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('v0.2.6 create auto-repairs a missing evidence binding and launches in one request', async () => {
  const repo = await repoFixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'src/index.ts': 'export const x = 1\n',
  })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: recordingLlmAgent(deps),
    },
  })
  try {
    await startOperator(launchpad)
    // The operator clicks 创建并启动 exactly once; no second request is made.
    const create = await postJson(launchpad, '/api/session/create', composerRequest('ai-repair-missing-0001', repo, {
      acceptanceCriteria: ['Tests pass'],
    }))
    const createText = await create.text()
    assert.equal(create.status, 202, createText)
    const createBody = JSON.parse(createText) as { accepted?: boolean; repaired?: boolean; controlUrl?: string }
    assert.equal(createBody.accepted, true)
    assert.equal(createBody.repaired, true)
    assert.equal(typeof createBody.controlUrl, 'string')
    assert.equal(recorded.configs.length, 1)
    assert.equal(recorded.configs[0]!.session.controlPlane, 'v2')
    assert.ok(recorded.configs[0]!.tasks[0]!.acceptanceEvidenceBindings?.some((binding) => binding.criterion === 'Tests pass' && binding.requiredEvidence.includes('npm test')))

    assert.equal(deps.notifications.filter((notification) => notification.kind === 'SUCCESS').length, 1)
    assert.equal(deps.audit.length, 1)
    assert.equal(deps.audit[0]!.classification, 'REPAIRED')
    assert.equal(deps.audit[0]!.sessionStarted, true)
    assert.equal(deps.audit[0]!.automatic, true, 'the audit marks the repair as unattended')
    assert.equal(deps.audit[0]!.deterministicAttempted, true)
    assert.equal(deps.audit[0]!.llmInvoked, false, 'a complete deterministic repair never calls the model')
    assert.equal(deps.llmCalls, 0)
    assert.deepEqual(deps.audit[0]!.stages.map((stage) => stage.agent), ['deterministic'])
    assert.deepEqual(deps.audit[0]!.autoRepair?.events.map((event) => event.event), [
      'AUTO_REPAIR_STARTED', 'AUTO_REPAIR_DETERMINISTIC', 'AUTO_REPAIR_VALIDATED', 'AUTO_REPAIR_SUCCEEDED',
    ])
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('the manual repair endpoint remains available as an operator fallback', async () => {
  const repo = await repoFixture({
    'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
    'src/index.ts': 'export const x = 1\n',
  })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: recordingLlmAgent(deps),
    },
  })
  try {
    await startOperator(launchpad)
    const repair = await postJson(launchpad, '/api/session/repair', composerRequest('ai-repair-manual-0001', repo, {
      acceptanceCriteria: ['Tests pass'],
    }))
    const repairText = await repair.text()
    assert.equal(repair.status, 202, repairText)
    const repairBody = JSON.parse(repairText) as { accepted?: boolean; repaired?: boolean; controlUrl?: string }
    assert.equal(repairBody.accepted, true)
    assert.equal(repairBody.repaired, true)
    assert.equal(recorded.configs.length, 1)
    assert.equal(deps.audit.length, 1)
    assert.equal(deps.audit[0]!.automatic, undefined, 'an operator click is not an automatic repair')
    assert.equal(deps.audit[0]!.llmInvoked, false)
    assert.equal(deps.llmCalls, 0)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('manual repair cannot guess an unsafe acceptance verifier when mixed with a repairable missing binding', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const acceptanceCriteria = [
    '如果需要可以考虑运行 npm test，但不要执行全量测试',
    'AC1 label formatting matches every specified example',
  ]
  const guessedOutcome: RepairAgentOutcome = {
    classification: 'REPAIRED',
    proposal: {
      acceptanceCriteria,
      acceptanceEvidenceBindings: acceptanceCriteria.map((criterion) => ({ criterion, requiredEvidence: ['npm test'] })),
      repairs: ['Guessed npm test for every criterion.'],
    },
  }
  let deterministicCalls = 0
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairAgent: { id: 'unsafe-guessing-deterministic-agent', async repair() { deterministicCalls += 1; return guessedOutcome } },
      repairLlmAgent: recordingLlmAgent(deps, guessedOutcome),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
    },
  })
  try {
    const preflight = await preflightTaskContract({ targetRepo: repo, acceptanceCriteria, acceptanceEvidenceBindings: [] })
    assert.equal(preflight.ok, false)
    if (!preflight.ok) assert.deepEqual(preflight.issues.map((entry) => entry.issueCode), ['UNSAFE_VERIFIER_EXTRACTION', 'MISSING_EVIDENCE_BINDING'])
    await startOperator(launchpad)
    const response = await postJson(launchpad, '/api/session/repair', composerRequest('unsafe-verifier-manual-repair', repo, { acceptanceCriteria }))
    assert.equal(response.status, 400)
    const result = await response.json() as { error?: string; issues?: Array<{ issueCode: string }> }
    assert.equal(result.error, 'TASK_CONTRACT_INVALID')
    assert.ok(result.issues?.some((entry) => entry.issueCode === 'UNSAFE_VERIFIER_EXTRACTION'), JSON.stringify(result))
    assert.ok(result.issues?.every((entry) => entry.issueCode !== 'VERIFIER_APPROVAL_REQUIRED'), JSON.stringify(result))
    assert.equal(deterministicCalls, 0, 'A repairable issue must not bypass an unsafe command boundary.')
    assert.equal(deps.llmCalls, 0, 'The model must not choose a verifier for the ambiguous acceptance text.')
    assert.equal(recorded.configs.length, 0)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('the LLM repair agent rejects mixed unsafe verifier issues before invoking its model', async () => {
  const acceptanceCriteria = ['如果需要可以考虑运行 npm test，但不要执行全量测试', 'AC1 label formatting matches every specified example']
  let modelCalls = 0
  const agent = scriptedLlmAgent(async () => {
    modelCalls += 1
    return { text: JSON.stringify({ acceptanceEvidenceBindings: acceptanceCriteria.map((criterion) => ({ criterion, requiredEvidence: ['npm test'] })) }) }
  })
  const result = await agent.repair(repairContext({
    targetRepo: process.cwd(), acceptanceCriteria,
    issues: [issue('UNSAFE_VERIFIER_EXTRACTION', acceptanceCriteria[0]), issue('MISSING_EVIDENCE_BINDING', acceptanceCriteria[1])],
  }))
  assert.equal(result.classification, 'REPAIR_REJECTED')
  assert.equal(result.proposal, undefined)
  assert.equal(modelCalls, 0)
})

test('failed repair preserves the original Task, records the attempt, and notifies failure', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: recordingLlmAgent(deps),
    },
  })
  try {
    await startOperator(launchpad)
    const body = composerRequest('ai-repair-approval-0002', repo, {
      acceptanceCriteria: ['custom proof'],
      acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
    })
    const repair = await postJson(launchpad, '/api/session/repair', body)
    assert.equal(repair.status, 400)
    const result = await repair.json() as {
      error?: string
      repairErrorCode?: string
      issues?: Array<{ issueCode: string }>
      repairAttempt?: { classification: string; reason?: string; llmInvoked?: boolean }
    }
    assert.equal(result.error, 'TASK_CONTRACT_INVALID')
    assert.equal(result.repairErrorCode, 'APPROVAL_PREFLIGHT_REQUIRED')
    assert.ok(result.issues?.some((item) => item.issueCode === 'VERIFIER_APPROVAL_REQUIRED'))
    assert.equal(result.repairAttempt?.classification, 'REPAIR_REJECTED')
    assert.equal(result.repairAttempt?.llmInvoked, false, 'approval is a human decision, not a model request')
    assert.equal(recorded.configs.length, 0)
    assert.equal(deps.llmCalls, 0)
    assert.equal(deps.notifications.filter((notification) => notification.kind === 'FAILURE').length, 1)
    assert.equal(deps.audit.length, 1)
    assert.equal(deps.audit[0]!.classification, 'REPAIR_REJECTED')
    assert.equal(deps.audit[0]!.sessionStarted, false)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('the orchestrator rejects a malicious agent that rewrites semantics', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const malicious: RepairAgent = {
    id: 'malicious-agent',
    async repair() {
      return {
        classification: 'REPAIRED',
        proposal: {
          acceptanceCriteria: ['A completely different criterion'],
          acceptanceEvidenceBindings: [{ criterion: 'A completely different criterion', requiredEvidence: ['npm test'] }],
          repairs: ['rewrote the criterion'],
        },
      }
    },
  }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairAgent: malicious,
      repairLlmAgent: recordingLlmAgent(deps),
      repairAudit: recordingAudit(deps),
      repairNotifier: recordingNotifier(deps),
    },
  })
  try {
    await startOperator(launchpad)
    const repair = await postJson(launchpad, '/api/session/repair', composerRequest('ai-repair-malicious-0003', repo, {
      acceptanceCriteria: ['Tests pass'],
    }))
    assert.equal(repair.status, 400)
    const result = await repair.json() as { repairAttempt?: { classification: string; reason?: string } }
    assert.equal(result.repairAttempt?.classification, 'REPAIR_REJECTED')
    assert.match(result.repairAttempt?.reason ?? '', /LLM repair returned no usable evidence binding|declines/u)
    assert.equal(recorded.configs.length, 0)
    assert.equal(deps.audit.length, 1)
    const deterministicStage = deps.audit[0]!.stages.find((stage) => stage.agent === 'deterministic')
    assert.equal(deterministicStage?.classification, 'REPAIR_REJECTED')
    assert.match(deterministicStage?.reason ?? '', /unsafe repair rejected/u)
    assert.equal(deterministicStage?.validation?.ok, false)
    assert.equal(deps.llmCalls, 1, 'the model is consulted only after the deterministic agent fails')
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

function proposalRunner(bindings: readonly { criterion: string; requiredEvidence: readonly string[] }[]): RepairModelRunner {
  return async () => ({ text: JSON.stringify({ acceptanceEvidenceBindings: bindings }) })
}

function scriptedLlmAgent(runner: RepairModelRunner): RepairAgent {
  return createLlmRepairAgent({
    runner,
    describeRepository: async () => ({ packageScripts: { test: 'node --test' }, testFileCandidates: [], topLevelEntries: [], hasPytestConfig: false, hasVenvPython: false }),
    isRuntimeAvailable: () => true,
  })
}

test('a criterion deterministic repair cannot judge is bound by the model and launched', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const criterion = 'AC1 label formatting matches every specified example'
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: scriptedLlmAgent(proposalRunner([{ criterion, requiredEvidence: ['npm test'] }])),
      repairProvider: { id: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    },
  })
  try {
    await startOperator(launchpad)
    const repair = await postJson(launchpad, '/api/session/repair', composerRequest('ai-repair-llm-0004', repo, {
      acceptanceCriteria: [criterion],
    }))
    assert.equal(repair.status, 202, await repair.text())
    assert.equal(recorded.configs.length, 1)
    assert.equal(recorded.configs[0]!.session.controlPlane, 'v2')
    assert.ok(recorded.configs[0]!.tasks[0]!.acceptanceEvidenceBindings
      ?.some((binding) => binding.criterion === criterion && binding.requiredEvidence.includes('npm test')))

    assert.equal(deps.audit.length, 1)
    const entry = deps.audit[0]!
    assert.equal(entry.deterministicAttempted, true)
    assert.equal(entry.llmInvoked, true)
    assert.deepEqual(entry.stages.map((stage) => stage.agent), ['deterministic', 'llm'])
    assert.equal(entry.stages[0]!.classification, 'REPAIR_REJECTED')
    assert.equal(entry.stages[1]!.classification, 'REPAIRED')
    assert.equal(entry.stages[1]!.validation?.ok, true)
    assert.equal(entry.stages[1]!.reflightPassed, true)
    assert.equal(entry.provider?.model, 'gpt-5.6-terra')
    assert.ok(entry.proposal?.acceptanceCriteria.includes(criterion))
    assert.equal(entry.sessionStarted, true)
    assert.equal(deps.notifications.filter((notification) => notification.kind === 'SUCCESS').length, 1)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unavailable repair provider preserves the original Task and reports PROVIDER_UNAVAILABLE', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: scriptedLlmAgent(async () => {
        throw new RepairProviderUnavailableError('codex login missing', 'Codex Local is not authenticated')
      }),
    },
  })
  try {
    await startOperator(launchpad)
    const criterion = 'AC1 label formatting matches every specified example'
    const repair = await postJson(launchpad, '/api/session/repair', composerRequest('ai-repair-llm-0005', repo, {
      acceptanceCriteria: [criterion],
    }))
    assert.equal(repair.status, 400)
    const result = await repair.json() as {
      error?: string
      issues?: Array<{ issueCode: string }>
      repairAttempt?: { classification?: string; reason?: string; llmInvoked?: boolean }
    }
    assert.equal(result.error, 'TASK_CONTRACT_INVALID')
    assert.equal(result.repairAttempt?.classification, 'PROVIDER_UNAVAILABLE')
    assert.equal(result.repairAttempt?.reason, 'Codex Local is not authenticated')
    assert.equal(result.repairAttempt?.llmInvoked, true)
    assert.ok(result.issues?.some((issue) => issue.issueCode === 'MISSING_EVIDENCE_BINDING'), 'the original issue is preserved')
    assert.equal(recorded.configs.length, 0, 'no Session is created when the provider is unavailable')
    assert.equal(deps.audit[0]!.classification, 'PROVIDER_UNAVAILABLE')
    assert.equal(deps.audit[0]!.sessionStarted, false)
    assert.equal(deps.notifications.filter((notification) => notification.kind === 'FAILURE').length, 1)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('a model proposal naming an unknown criterion is rejected', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      repairLlmAgent: scriptedLlmAgent(proposalRunner([
        { criterion: 'a completely different criterion', requiredEvidence: ['npm test'] },
      ])),
    },
  })
  try {
    await startOperator(launchpad)
    const repair = await postJson(launchpad, '/api/session/repair', composerRequest('ai-repair-llm-0006', repo, {
      acceptanceCriteria: ['AC1 label formatting matches every specified example'],
    }))
    assert.equal(repair.status, 400)
    const result = await repair.json() as { repairAttempt?: { classification?: string; reason?: string } }
    assert.equal(result.repairAttempt?.classification, 'REPAIR_REJECTED')
    assert.match(result.repairAttempt?.reason ?? '', /unknown criterion/u)
    assert.equal(recorded.configs.length, 0)
    assert.equal(deps.audit[0]!.stages[1]!.classification, 'REPAIR_REJECTED')
    assert.equal(deps.audit[0]!.sessionStarted, false)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('a verifier awaiting human approval cannot be replaced by the model', async () => {
  const repo = await repoFixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const recorded = { configs: [] as TrustedWorkSessionConfig[] }
  const deps: RecordingDeps = { notifications: [], audit: [], llmCalls: 0 }
  const labelCriterion = 'AC1 label formatting matches every specified example'
  const launchpad = await createNovaWingLaunchpad({
    configDirectory: directory,
    dependencies: {
      createWorkSession: fakeApp(recorded),
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      repairNotifier: recordingNotifier(deps),
      repairAudit: recordingAudit(deps),
      // The model "fixes" the missing binding but also swaps the explicit,
      // approval-required proof for a weaker allowlisted command.
      repairLlmAgent: scriptedLlmAgent(proposalRunner([
        { criterion: labelCriterion, requiredEvidence: ['npm test'] },
        { criterion: 'custom proof', requiredEvidence: ['npm test'] },
      ])),
    },
  })
  try {
    await startOperator(launchpad)
    const repair = await postJson(launchpad, '/api/session/repair', composerRequest('ai-repair-llm-0007', repo, {
      acceptanceCriteria: [labelCriterion, 'custom proof'],
      acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
    }))
    assert.equal(repair.status, 400)
    const result = await repair.json() as { repairAttempt?: { classification?: string; reason?: string } }
    assert.equal(result.repairAttempt?.classification, 'REPAIR_REJECTED')
    assert.match(result.repairAttempt?.reason ?? '', /requires human approval/u)
    assert.equal(recorded.configs.length, 0)
    const llmStage = deps.audit[0]!.stages.find((stage) => stage.agent === 'llm')
    assert.equal(llmStage?.validation?.ok, false)
    assert.ok(llmStage?.validation?.reasons.some((reason) => reason.includes('requires human approval')))
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(repo, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('the Launchpad serves an AI repair affordance wired to the repair endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-ai-repair-configs-'))
  const launchpad = await createNovaWingLaunchpad({ configDirectory: directory })
  try {
    const address = await startOperator(launchpad)
    const html = await (await sessionFetch(address.url)).text()
    assert.match(html, /data-composer-repair hidden>AI 修复并重试<\/button>/u)
    // v0.2.6: a repairable contract shows staged progress instead of an immediate red block.
    assert.match(html, /data-composer-progress/u)
    const appJs = await (await sessionFetch(`${address.url}/app.js`)).text()
    assert.match(appJs, /fetch\('\/api\/session\/repair'/u)
    assert.match(appJs, /result\.repairable === true/u)
    assert.match(appJs, /repairButton\.hidden = false/u)
    assert.match(appJs, /正在检查 Task Contract/u)
    assert.match(appJs, /正在自动修复配置/u)
    assert.match(appJs, /autoRepairMessage/u)
  } finally {
    await launchpad.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('repair proposal parsing fails closed on every malformed shape', () => {
  assert.equal(parseRepairProposalJson('').ok, false)
  assert.equal(parseRepairProposalJson('not json').ok, false)
  assert.equal(parseRepairProposalJson('[]').ok, false)
  assert.equal(parseRepairProposalJson('{"acceptanceEvidenceBindings":[]}').ok, true)
  assert.equal(parseRepairProposalJson('{"acceptanceEvidenceBindings":[],"goals":["x"]}').ok, false)
  assert.equal(parseRepairProposalJson('{"acceptanceEvidenceBindings":[{"criterion":"","requiredEvidence":["npm test"]}]}').ok, false)
  assert.equal(parseRepairProposalJson('{"acceptanceEvidenceBindings":[{"criterion":"a","requiredEvidence":[]}]}').ok, false)
  assert.equal(parseRepairProposalJson('{"acceptanceEvidenceBindings":[{"criterion":"a","requiredEvidence":["npm test"],"requiresApproval":true}]}').ok, false)
  const fenced = parseRepairProposalJson('```json\n{"acceptanceEvidenceBindings":[{"criterion":"a","requiredEvidence":["npm test"]}]}\n```')
  assert.equal(fenced.ok, true)
  if (fenced.ok) assert.deepEqual(fenced.bindings, [{ criterion: 'a', requiredEvidence: ['npm test'] }])
})
