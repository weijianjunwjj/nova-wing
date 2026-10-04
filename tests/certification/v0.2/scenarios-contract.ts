import { mintSession, startOperator, sessionFetch } from '../../operator-session.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createNovaWingLaunchpad,
  discoverTrustedWorkSessionConfigs,
} from '../../../packages/development-guardian/work-session/launchpad/server.js'
import {
  parseTaskContractBindingDsl,
  preflightTaskContract,
} from '../../../packages/development-guardian/work-session/launchpad/contract-preflight.js'
import { analyzeTaskBrief } from '../../../packages/development-guardian/work-session/launchpad/task-brief.js'
import type { RepairAgent } from '../../../packages/development-guardian/work-session/launchpad/repair-agent.js'
import { createLlmRepairAgent } from '../../../packages/development-guardian/work-session/launchpad/repair-agent-llm.js'
import { RepairProviderUnavailableError } from '../../../packages/development-guardian/work-session/launchpad/repair-model.js'
import type { RepairAuditEntry, RepairAuditSink } from '../../../packages/development-guardian/work-session/launchpad/repair-audit.js'
import type { RepairNotification, RepairNotifier } from '../../../packages/development-guardian/work-session/launchpad/repair-notifier.js'
import type { TrustedWorkSessionConfig } from '../../../packages/development-guardian/work-session/production.js'
import type { CertificationScenario } from './scenario.js'
import { initFixtureRepo, removeTree } from './util.js'

function fakeApp(onCreate: (config: TrustedWorkSessionConfig) => void) {
  return async (config: TrustedWorkSessionConfig) => {
    onCreate(config)
    return {
      controller: { start: () => ({ started: true }) },
      start: async () => ({ url: 'http://127.0.0.1:54321' }),
      isLive: () => true,
      hasActiveSession: () => true,
      close: async () => undefined,
    }
  }
}

async function postCreate(launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>, body: unknown): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return sessionFetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': await mintSession(launchpad), Origin: address.url },
    body: JSON.stringify(body),
  })
}

function request(requestId: string, repo: string, guardian: Record<string, unknown>) {
  return {
    requestId,
    targetRepo: repo,
    tasks: [{ id: 'FW-001', goal: '为用户创建接口补充输入参数校验。' }],
    autoCommit: false,
    guardian: { allowedPaths: ['apps/api/**'], ...guardian },
  }
}

export const s17: CertificationScenario = {
  id: 'S17', title: 'Contract placeholder auto-repair', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, {
      'package.json': JSON.stringify({ name: 'fly-weave-like', scripts: { test: 'node scripts/test.mjs' } }),
      'scripts/test.mjs': "spawn(python, ['-m', 'pytest', ...process.argv.slice(2)])\n",
      'pytest.ini': '[pytest]\ntestpaths = apps/api/tests\n',
      'apps/api/main.py': 'customer_email: str\n',
      'apps/api/tests/test_ticket_intake.py': 'def test_ticket_intake(): pass\n',
    })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    let created: TrustedWorkSessionConfig | undefined
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp((config) => { created = config }),
    } })
    try {
      await startOperator(launchpad)
      const brief = analyzeTaskBrief(`Goal:\n为用户创建接口补充输入参数校验。\n\nAcceptance Criteria:\nAC1 Invalid email is rejected with HTTP 400 => npm test -- --runInBand <对应测试>\n\nAllowed Paths:\napps/api/**`)
      h.check(brief.fields.acceptanceCriteria?.[0] === 'AC1 Invalid email is rejected with HTTP 400', 'natural-language brief composes the criterion independently from its verifier')
      const response = await postCreate(launchpad, request(`cert-s17-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: brief.fields.acceptanceCriteria,
        acceptanceEvidenceBindings: brief.fields.acceptanceEvidenceBindings,
      }))
      h.check(response.status === 202, `repaired contract creates Session (got ${response.status} ${await response.text()})`)
      h.check(created !== undefined, 'Work Session construction occurs only after preflight PASS')
      h.check(created?.tasks[0]?.acceptanceEvidenceBindings?.some((binding) => binding.criterion === 'AC1 Invalid email is rejected with HTTP 400' && binding.requiredEvidence.length === 1 && binding.requiredEvidence[0] === 'npm test') === true,
        'placeholder and incompatible --runInBand are replaced by repository-authoritative npm test entry')
      h.check((await discoverTrustedWorkSessionConfigs(configs)).length === 1, 'only the repaired valid contract is persisted')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s18: CertificationScenario = {
  id: 'S18', title: 'Unresolvable contract blocked before Session', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'README.md': '# no deterministic test entry\n' })
    const configs = join(ctx.dirs.root, 'configs')
    let createCalls = 0
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => { createCalls++ }),
    } })
    try {
      await startOperator(launchpad)
      const response = await postCreate(launchpad, request(`cert-s18-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['AC1 Invalid email is rejected with HTTP 400 => npm test -- <对应测试>'],
      }))
      const body = await response.json() as { error?: string; issues?: Array<{ issueCode?: string }> }
      h.check(response.status === 400 && body.error === 'TASK_CONTRACT_INVALID', 'Launchpad returns structured TASK_CONTRACT_INVALID')
      h.check(body.issues?.some((issue) => issue.issueCode === 'UNRESOLVED_PLACEHOLDER') === true, 'response identifies the unresolved placeholder')
      h.check(createCalls === 0, 'no Work Session is constructed')
      h.check((await discoverTrustedWorkSessionConfigs(configs)).length === 0, 'no invalid config is persisted')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s19: CertificationScenario = {
  id: 'S19', title: 'Verifier approval discovered before EXECUTE', group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const result = await preflightTaskContract({ targetRepo: repo, acceptanceCriteria: ['custom proof'],
      acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }] })
    h.check(!result.ok, 'approval-required contract does not pass creation preflight')
    h.check(result.verifiers[0]?.classification === 'APPROVAL_REQUIRED', 'verifier is classified APPROVAL_REQUIRED before runtime')
    h.check(!result.ok && result.issues.some((issue) => issue.issueCode === 'VERIFIER_APPROVAL_REQUIRED'), 'required exact command is surfaced as a structured preflight issue')
  },
}

export const s20: CertificationScenario = {
  id: 'S20', title: 'Verifier containing => parses correctly', group: 'compatibility',
  run(ctx) {
    const parsed = parseTaskContractBindingDsl('mapping remains exact => node -e "console.log(\'x => y\')"')
    ctx.h.check(parsed?.criterionText === 'mapping remains exact', 'criterion uses only the first delimiter')
    ctx.h.check(parsed?.verifierCommand === 'node -e "console.log(\'x => y\')"', 'literal => remains inside the structured verifier command')
    return Promise.resolve()
  },
}

async function postRepair(launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>, body: unknown): Promise<Response> {
  const address = launchpad.getAddress()
  if (address === undefined) throw new Error('Launchpad is not listening')
  return sessionFetch(`${address.url}/api/session/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': await mintSession(launchpad), Origin: address.url },
    body: JSON.stringify(body),
  })
}

/** Injected notifier/audit keep certification side-effect free and observable. */
function recordingRepairDeps() {
  const notifications: RepairNotification[] = []
  const audit: RepairAuditEntry[] = []
  let llmCalls = 0
  const notifier: RepairNotifier = { notify: async (notification) => { notifications.push(notification) } }
  const auditSink: RepairAuditSink = { record: async (entry) => { audit.push(entry) } }
  return {
    notifications,
    audit,
    notifier,
    auditSink,
    get llmCalls() { return llmCalls },
    /** A model stand-in: certification never reaches a live provider. */
    llmAgent(): RepairAgent {
      return {
        id: 'cert-llm-agent',
        async repair() {
          llmCalls += 1
          return { classification: 'REPAIR_REJECTED', reason: 'certification model stand-in declines' }
        },
      }
    },
  }
}

/** A scripted model runner returning one fixed structured proposal. */
function scriptedLlmAgent(bindings: readonly { criterion: string; requiredEvidence: readonly string[] }[]): RepairAgent {
  return createLlmRepairAgent({
    runner: async () => ({ text: JSON.stringify({ acceptanceEvidenceBindings: bindings }) }),
    describeRepository: async () => ({
      packageScripts: { test: 'node --test' }, testFileCandidates: [], topLevelEntries: [],
      hasPytestConfig: false, hasVenvPython: false,
    }),
    isRuntimeAvailable: () => true,
  })
}

export const s21: CertificationScenario = {
  id: 'S21', title: 'One-click create auto-repairs a missing evidence binding', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    const created: TrustedWorkSessionConfig[] = []
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp((config) => { created.push(config) }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: rec.llmAgent(),
    } })
    try {
      await startOperator(launchpad)
      // A single POST /api/session/create — the operator never sees a red screen.
      const response = await postCreate(launchpad, request(`cert-s21-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['Tests pass'],
      }))
      const responseText = await response.text()
      h.check(response.status === 202, `create repairs the contract and launches (got ${response.status} ${responseText})`)
      const body = JSON.parse(responseText) as { repaired?: boolean; accepted?: boolean }
      h.check(body.accepted === true && body.repaired === true, 'the response reports a repaired launch')
      h.check(created.length === 1, 'exactly one Session is created by the single click')
      h.check(created[0]?.tasks[0]?.acceptanceEvidenceBindings?.some((binding) => binding.criterion === 'Tests pass' && binding.requiredEvidence.includes('npm test')) === true,
        'missing criterion is bound to the repository test entry')
      h.check(rec.llmCalls === 0, 'a complete deterministic repair never consults the model')
      h.check(rec.audit[0]?.automatic === true, 'the audit records an unattended repair')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s22: CertificationScenario = {
  id: 'S22', title: 'One-click create resolves a verifier placeholder', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { check: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    const created: TrustedWorkSessionConfig[] = []
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp((config) => { created.push(config) }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: rec.llmAgent(),
    } })
    try {
      await startOperator(launchpad)
      const create = await postCreate(launchpad, request(`cert-s22-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['AC1 invalid input => npm test -- <对应测试>'],
      }))
      h.check(create.status === 202, `create resolves the placeholder and launches (got ${create.status} ${await create.text()})`)
      h.check(created[0]?.tasks[0]?.acceptanceEvidenceBindings?.some((binding) => binding.criterion === 'AC1 invalid input' && binding.requiredEvidence.includes('npm run check')) === true,
        'placeholder is replaced with the repository check entry')
      h.check(rec.llmCalls === 0, 'the deterministic agent resolved the placeholder without the model')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s23: CertificationScenario = {
  id: 'S23', title: 'Unsafe semantic repair is rejected', group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    let createCalls = 0
    const malicious: RepairAgent = {
      id: 'cert-malicious-agent',
      async repair() {
        return {
          classification: 'REPAIRED',
          proposal: {
            acceptanceCriteria: ['A rewired criterion'],
            acceptanceEvidenceBindings: [{ criterion: 'A rewired criterion', requiredEvidence: ['npm test'] }],
            repairs: ['rewrote the criterion'],
          },
        }
      },
    }
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => { createCalls++ }),
      repairAgent: malicious,
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: rec.llmAgent(),
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s23-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['Tests pass'],
      }))
      h.check(repair.status === 400, 'semantic rewrite is rejected')
      const body = await repair.json() as { repairAttempt?: { classification?: string; reason?: string } }
      h.check(body.repairAttempt?.classification === 'REPAIR_REJECTED', 'rejection is surfaced as REPAIR_REJECTED')
      h.check(createCalls === 0, 'no Session is created from an unsafe repair')
      const deterministicStage = rec.audit[0]?.stages.find((stage) => stage.agent === 'deterministic')
      h.check(/unsafe repair rejected/u.test(deterministicStage?.reason ?? ''), 'the deterministic stage names the unsafe repair')
      h.check(deterministicStage?.validation?.ok === false, 'mechanical validation rejected the rewrite')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s24: CertificationScenario = {
  id: 'S24', title: 'Successful retry launches a V2 Session', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    const created: TrustedWorkSessionConfig[] = []
    const s24Rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp((config) => { created.push(config) }),
      repairNotifier: s24Rec.notifier,
      repairAudit: s24Rec.auditSink,
      repairLlmAgent: s24Rec.llmAgent(),
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s24-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['Tests pass'],
      }))
      h.check(repair.status === 202, 'retry launches a Session')
      const result = await repair.json() as { repaired?: boolean; controlUrl?: string }
      h.check(result.repaired === true && typeof result.controlUrl === 'string', 'retry reports a repaired launch with a control URL')
      h.check(created[0]?.session.controlPlane === 'v2', 'retried Session opts into the V2 control plane')
      const persisted = await discoverTrustedWorkSessionConfigs(configs)
      h.check(persisted.length === 1, 'only the repaired config is persisted')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s25: CertificationScenario = {
  id: 'S25', title: 'Failed repair preserves the original Task', group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    let createCalls = 0
    const s25Rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => { createCalls++ }),
      repairNotifier: s25Rec.notifier,
      repairAudit: s25Rec.auditSink,
      repairLlmAgent: s25Rec.llmAgent(),
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s25-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['custom proof'],
        acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
      }))
      h.check(repair.status === 400, 'unrepairable contract keeps the original error')
      const result = await repair.json() as { error?: string; issues?: Array<{ issueCode?: string }>; repairAttempt?: { classification?: string; llmInvoked?: boolean } }
      h.check(result.error === 'TASK_CONTRACT_INVALID', 'original error code is preserved')
      h.check(result.issues?.some((issue) => issue.issueCode === 'VERIFIER_APPROVAL_REQUIRED') === true, 'original issues are preserved')
      h.check(result.repairAttempt?.classification === 'REPAIR_REJECTED', 'repair attempt is surfaced')
      h.check(result.repairAttempt?.llmInvoked === false, 'approval cannot be delegated to a model')
      h.check(s25Rec.llmCalls === 0, 'a human approval issue never reaches the model')
      h.check(createCalls === 0, 'no Session is created')
      h.check((await discoverTrustedWorkSessionConfigs(configs)).length === 0, 'no invalid config is persisted')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s26: CertificationScenario = {
  id: 'S26', title: 'Repair success and failure emit desktop notifications', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const noTest = join(ctx.dirs.root, 'notest')
    await initFixtureRepo(noTest, { 'package.json': JSON.stringify({ scripts: {} }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => undefined),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: rec.llmAgent(),
    } })
    try {
      await startOperator(launchpad)
      const ok = await postRepair(launchpad, request(`cert-s26a-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['Tests pass'],
      }))
      h.check(ok.status === 202, 'successful repair launches')
      const fail = await postRepair(launchpad, request(`cert-s26b-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, noTest, {
        acceptanceCriteria: ['custom proof'],
        acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
      }))
      h.check(fail.status === 400, 'failed repair preserves the error')
      h.check(rec.notifications.some((notification) => notification.kind === 'SUCCESS'), 'success emits a desktop notification')
      h.check(rec.notifications.some((notification) => notification.kind === 'FAILURE'), 'failure emits a desktop notification')
      h.check(rec.audit.length === 2, 'every repair attempt is audited')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

/** A criterion the deterministic agent cannot judge, but a model can bind. */
const LLM_ONLY_CRITERION = 'AC1 label formatting matches every specified example'

export const s27: CertificationScenario = {
  id: 'S27', title: 'LLM repair binds a criterion deterministic repair cannot judge', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    const created: TrustedWorkSessionConfig[] = []
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp((config) => { created.push(config) }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: scriptedLlmAgent([{ criterion: LLM_ONLY_CRITERION, requiredEvidence: ['npm test'] }]),
      repairProvider: { id: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s27-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: [LLM_ONLY_CRITERION],
      }))
      h.check(repair.status === 202, 'the model resolves the criterion and the retry launches')
      h.check(rec.llmCalls === 0, 'the injected agent is scripted; no live provider is contacted in certification')
      h.check(created.length === 1, 'exactly one Session is created')
      h.check(created[0]?.tasks[0]?.acceptanceEvidenceBindings?.some((binding) => binding.criterion === LLM_ONLY_CRITERION && binding.requiredEvidence.includes('npm test')) === true,
        'the model binding reaches the persisted Session')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s28: CertificationScenario = {
  id: 'S28', title: 'Unavailable repair provider preserves the original Task', group: 'recovery',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    let createCalls = 0
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => { createCalls++ }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: createLlmRepairAgent({
        runner: async () => { throw new RepairProviderUnavailableError('no login', 'Codex Local is not authenticated') },
        describeRepository: async () => ({ packageScripts: {}, testFileCandidates: [], topLevelEntries: [], hasPytestConfig: false, hasVenvPython: false }),
        isRuntimeAvailable: () => true,
      }),
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s28-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: [LLM_ONLY_CRITERION],
      }))
      h.check(repair.status === 400, 'an unavailable provider fails closed')
      const body = await repair.json() as { error?: string; issues?: Array<{ issueCode?: string }>; repairAttempt?: { classification?: string; llmInvoked?: boolean; reason?: string } }
      h.check(body.error === 'TASK_CONTRACT_INVALID', 'the original error is preserved')
      h.check(body.issues?.some((issue) => issue.issueCode === 'MISSING_EVIDENCE_BINDING') === true, 'the original issue is preserved')
      h.check(body.repairAttempt?.classification === 'PROVIDER_UNAVAILABLE', 'the provider failure is named explicitly')
      h.check(body.repairAttempt?.llmInvoked === true, 'the attempt records that the model was consulted')
      h.check(body.repairAttempt?.reason === 'Codex Local is not authenticated', 'the safe provider reason is surfaced')
      h.check(createCalls === 0, 'no Session is created')
      h.check((await discoverTrustedWorkSessionConfigs(configs)).length === 0, 'no config is persisted')
      h.check(rec.notifications.some((notification) => notification.kind === 'FAILURE'), 'the failure is notified')
      h.check(rec.audit[0]?.classification === 'PROVIDER_UNAVAILABLE', 'the audit records PROVIDER_UNAVAILABLE')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s29: CertificationScenario = {
  id: 'S29', title: 'A model proposal cannot weaken an approval-required verifier', group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    let createCalls = 0
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => { createCalls++ }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      // The model "fixes" the missing binding but also downgrades the explicit
      // approval-required proof to a weaker allowlisted command.
      repairLlmAgent: scriptedLlmAgent([
        { criterion: LLM_ONLY_CRITERION, requiredEvidence: ['npm test'] },
        { criterion: 'custom proof', requiredEvidence: ['npm test'] },
      ]),
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s29-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: [LLM_ONLY_CRITERION, 'custom proof'],
        acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
      }))
      h.check(repair.status === 400, 'a trust-weakening repair is rejected')
      const body = await repair.json() as { repairAttempt?: { classification?: string; reason?: string } }
      h.check(body.repairAttempt?.classification === 'REPAIR_REJECTED', 'the attempt is rejected')
      h.check(/requires human approval/u.test(body.repairAttempt?.reason ?? ''), 'the rejection names the protected verifier')
      const llmStage = rec.audit[0]?.stages.find((stage) => stage.agent === 'llm')
      h.check(llmStage?.validation?.ok === false, 'mechanical validation rejected the model proposal')
      h.check(createCalls === 0, 'no Session is created')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}

export const s30: CertificationScenario = {
  id: 'S30', title: 'Repair audit records both agents, the provider, proposal and retry result', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const configs = join(ctx.dirs.root, 'configs')
    await mkdir(configs, { recursive: true })
    const rec = recordingRepairDeps()
    const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies: {
      gitProcessRunner: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
      createWorkSession: fakeApp(() => undefined),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: scriptedLlmAgent([{ criterion: LLM_ONLY_CRITERION, requiredEvidence: ['npm test'] }]),
      repairProvider: { id: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    } })
    try {
      await startOperator(launchpad)
      const repair = await postRepair(launchpad, request(`cert-s30-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: [LLM_ONLY_CRITERION],
      }))
      h.check(repair.status === 202, 'the repair launches')
      const entry = rec.audit[0]
      h.check(entry !== undefined, 'the attempt is audited')
      h.check(entry?.deterministicAttempted === true, 'audit records the deterministic attempt')
      h.check(entry?.llmInvoked === true, 'audit records that the model was consulted')
      h.check(entry?.provider?.id === 'codex' && entry?.provider?.model === 'gpt-5.6-terra', 'audit records provider and model')
      h.check(entry?.proposal?.acceptanceCriteria.includes(LLM_ONLY_CRITERION) === true, 'audit records the applied proposal')
      h.check(entry?.stages.map((stage) => stage.agent).join(',') === 'deterministic,llm', 'audit records both agents in order')
      h.check(entry?.stages[1]?.validation?.ok === true, 'audit records the validation result')
      h.check(entry?.stages[1]?.reflightPassed === true, 'audit records the re-preflight result')
      h.check(entry?.reflightPassed === true && entry?.sessionStarted === true, 'audit records the retry result')
      h.check(entry?.notification.success === true, 'audit records the notification outcome')
    } finally {
      await launchpad.close().catch(() => undefined)
      await removeTree(configs)
    }
  },
}
