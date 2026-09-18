/**
 * NovaWing v0.2.6 certification scenarios.
 *
 * S58–S65: Automatic Preflight Repair — one operator click repairs a mechanical
 *          Task Contract and starts the Session, bounded and fail-closed.
 * S66–S69: Notification per-channel delivery status — one failing channel can
 *          never report a channel that was accepted as failed.
 */
import { join } from 'node:path'

import {
  createNovaWingLaunchpad,
  discoverTrustedWorkSessionConfigs,
} from '../../../packages/development-guardian/work-session/launchpad/server.js'
import type { RepairAgent } from '../../../packages/development-guardian/work-session/launchpad/repair-agent.js'
import { createLlmRepairAgent } from '../../../packages/development-guardian/work-session/launchpad/repair-agent-llm.js'
import type { RepairAuditEntry, RepairAuditSink } from '../../../packages/development-guardian/work-session/launchpad/repair-audit.js'
import type { RepairNotification, RepairNotifier } from '../../../packages/development-guardian/work-session/launchpad/repair-notifier.js'
import type { TrustedWorkSessionConfig } from '../../../packages/development-guardian/work-session/production.js'
import { WorkSessionRuntime } from '../../../packages/development-guardian/work-session/runtime.js'
import { readExecutionLedger } from '../../../packages/development-guardian/work-session/execution-ledger.js'
import { createWindowsTaskRunNotifier } from '../../../packages/development-guardian/work-session/task-run-notifier.js'
import { SmtpWorkSessionNotifier } from '../../../packages/development-guardian/work-session/smtp-notifier.js'
import { createTaskStateV2 } from '../../../packages/development-guardian/work-session/task-state-v2.js'
import { projectTaskRun } from '../../../packages/development-guardian/work-session/task-run-analytics.js'
import { renderLaunchpadHtml, LAUNCHPAD_APP_JS } from '../../../packages/development-guardian/work-session/launchpad/view.js'
import { APP_JS } from '../../../packages/development-guardian/work-session/control-ui/view.js'
import type { CertificationScenario, ScenarioContext } from './scenario.js'
import { initFixtureRepo, removeTree, storageUrl } from './util.js'

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
  return fetch(`${address.url}/api/session/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest(), Origin: address.url },
    body: JSON.stringify(body),
  })
}

function request(requestId: string, repo: string, guardian: Record<string, unknown>) {
  return {
    requestId,
    targetRepo: repo,
    tasks: [{ id: 'REAL-001', goal: '为用户创建接口补充输入参数校验。' }],
    autoCommit: false,
    guardian: { allowedPaths: ['apps/api/**'], ...guardian },
  }
}

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
    /** A model stand-in the scenario can replace; certification never reaches a live provider. */
    llmAgent(): RepairAgent {
      return {
        id: 'cert-v026-llm-agent',
        async repair() {
          llmCalls += 1
          return { classification: 'REPAIR_REJECTED', reason: 'certification model stand-in declines' }
        },
      }
    },
  }
}

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

/** A criterion the deterministic agent cannot judge, but a model can bind. */
const LLM_ONLY_CRITERION = 'AC1 label formatting matches every specified example'

type LaunchpadDependencies = NonNullable<NonNullable<Parameters<typeof createNovaWingLaunchpad>[0]>['dependencies']>

async function withLaunchpad(
  ctx: ScenarioContext,
  dependencies: LaunchpadDependencies,
  run: (launchpad: Awaited<ReturnType<typeof createNovaWingLaunchpad>>) => Promise<void>,
): Promise<void> {
  const configs = join(ctx.dirs.root, 'configs')
  const launchpad = await createNovaWingLaunchpad({ configDirectory: configs, dependencies })
  try {
    await launchpad.start()
    await run(launchpad)
  } finally {
    await launchpad.close().catch(() => undefined)
    await removeTree(configs)
  }
}

const gitStub = async () => ({ exitCode: 0, stdout: 'main\n', stderr: '' })

export const s58: CertificationScenario = {
  id: 'S58', title: 'REAL-001 shape: eight unbound criteria repair and start in one click', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test', typecheck: 'node --test' } }) })
    // The verbatim REAL-001 acceptance criteria: mostly not test-shaped, so the
    // deterministic agent declines them and the model binds them.
    const criteria = [
      'AC1 请求进行期间重复点击不会产生第二次 ticket 创建请求。',
      'AC2 请求进行期间提交按钮显示明确的提交中状态并不可重复提交。',
      'AC3 请求成功后用户可以看到明确成功反馈。',
      'AC4 请求失败后提交状态恢复，用户可以再次尝试提交，并有明确失败反馈。',
      'AC5 相关自动测试覆盖重复提交、成功和失败恢复路径。',
      'AC6 相关自动测试全部通过。',
      'AC7 项目现有必要静态检查通过。',
      'AC8 repository diff 无 whitespace error。',
    ]
    const created: TrustedWorkSessionConfig[] = []
    const rec = recordingRepairDeps()
    await withLaunchpad(ctx, {
      gitProcessRunner: gitStub,
      createWorkSession: fakeApp((config) => { created.push(config) }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: scriptedLlmAgent([
        ...criteria.slice(0, 6).map((criterion) => ({ criterion, requiredEvidence: ['npm test'] })),
        { criterion: criteria[6]!, requiredEvidence: ['npm run typecheck'] },
        { criterion: criteria[7]!, requiredEvidence: ['git diff --check'] },
      ]),
      repairProvider: { id: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    }, async (launchpad) => {
      const response = await postCreate(launchpad, request(`cert-s58-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: criteria,
      }))
      const responseText = await response.text()
      h.check(response.status === 202, `one click repairs all eight criteria and launches (got ${response.status} ${responseText})`)
      const body = JSON.parse(responseText) as { accepted?: boolean; repaired?: boolean }
      h.check(body.accepted === true && body.repaired === true, 'the single create request reports a repaired launch')
      h.check(created.length === 1, 'exactly one Session is created')
      const bindings = created[0]?.tasks[0]?.acceptanceEvidenceBindings ?? []
      h.check(criteria.every((criterion) => bindings.some((binding) => binding.criterion === criterion && binding.requiredEvidence.length > 0)),
        'every REAL-001 criterion carries an evidence binding after automatic repair')
      h.check(created[0]?.tasks[0]?.guardian.acceptanceCriteria.length === criteria.length + 2,
        'the repaired contract adds the two standing policy criteria exactly once')
      h.check(bindings.length === criteria.length + 2, 'the persisted bindings cover the policy criteria too')
      const entry = rec.audit[0]
      h.check(entry?.automatic === true, 'the audit records an unattended repair')
      h.check(entry?.classification === 'REPAIRED' && entry?.sessionStarted === true, 'the attempt is recorded as a launched repair')
      h.check(entry?.llmInvoked === true, 'the model was consulted for the criteria the deterministic agent cannot judge')
      h.check((await discoverTrustedWorkSessionConfigs(join(ctx.dirs.root, 'configs'))).length === 1, 'only the repaired valid contract is persisted')
    })
  },
}

export const s59: CertificationScenario = {
  id: 'S59', title: 'A complete deterministic repair never consults the model', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const rec = recordingRepairDeps()
    await withLaunchpad(ctx, {
      gitProcessRunner: gitStub,
      createWorkSession: fakeApp(() => undefined),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: rec.llmAgent(),
    }, async (launchpad) => {
      const response = await postCreate(launchpad, request(`cert-s59-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['Tests pass'],
      }))
      h.check(response.status === 202, 'deterministic automatic repair launches')
      h.check(rec.llmCalls === 0, 'the model is never consulted')
      const entry = rec.audit[0]
      h.check(entry?.llmInvoked === false, 'the audit records that the model was not consulted')
      h.check(entry?.stages.map((stage) => stage.agent).join(',') === 'deterministic', 'only the deterministic stage ran')
      h.check(entry?.autoRepair?.cycles === 1, 'the cascade stopped after its first cycle')
      h.check(entry?.autoRepair?.events.some((event) => event.event === 'AUTO_REPAIR_SUCCEEDED') === true, 'the audit records AUTO_REPAIR_SUCCEEDED')
    })
  },
}

export const s60: CertificationScenario = {
  id: 'S60', title: 'Deterministic repair insufficient → model repair → launch', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    const created: TrustedWorkSessionConfig[] = []
    const rec = recordingRepairDeps()
    await withLaunchpad(ctx, {
      gitProcessRunner: gitStub,
      createWorkSession: fakeApp((config) => { created.push(config) }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: scriptedLlmAgent([{ criterion: LLM_ONLY_CRITERION, requiredEvidence: ['npm test'] }]),
      repairProvider: { id: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    }, async (launchpad) => {
      const response = await postCreate(launchpad, request(`cert-s60-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: [LLM_ONLY_CRITERION],
      }))
      const responseText = await response.text()
      h.check(response.status === 202, `the model resolves the criterion and the launch happens (got ${response.status} ${responseText})`)
      h.check(created.length === 1, 'exactly one Session is created')
      h.check(created[0]?.tasks[0]?.acceptanceEvidenceBindings?.some((binding) => binding.criterion === LLM_ONLY_CRITERION && binding.requiredEvidence.includes('npm test')) === true,
        'the model binding reaches the persisted Session')
      const entry = rec.audit[0]
      h.check(entry?.stages.map((stage) => stage.agent).join(',') === 'deterministic,llm', 'both strategies ran in order')
      h.check(entry?.llmInvoked === true, 'the audit records the model consultation')
      h.check(entry?.autoRepair?.cycles === 2, 'the second cycle is the model')
      h.check(entry?.autoRepair?.events.some((event) => event.event === 'AUTO_REPAIR_LLM_STARTED') === true, 'the audit records AUTO_REPAIR_LLM_STARTED')
      h.check(entry?.autoRepair?.events.some((event) => event.event === 'AUTO_REPAIR_VALIDATED' && event.validation?.ok === true) === true,
        'the audit records a passing mechanical validation')
    })
  },
}

export const s61: CertificationScenario = {
  id: 'S61', title: 'An unsafe semantic issue is never auto-repaired', group: 'risk',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    let createCalls = 0
    const rec = recordingRepairDeps()
    await withLaunchpad(ctx, {
      gitProcessRunner: gitStub,
      createWorkSession: fakeApp(() => { createCalls++ }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: rec.llmAgent(),
    }, async (launchpad) => {
      const response = await postCreate(launchpad, request(`cert-s61-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: ['custom proof'],
        acceptanceEvidenceBindings: [{ criterion: 'custom proof', requiredEvidence: ['node -e "process.exit(0)"'] }],
      }))
      h.check(response.status === 400, 'a verifier awaiting human approval still fails closed')
      const body = await response.json() as { error?: string; repairable?: boolean; issues?: Array<{ issueCode?: string }>; autoRepair?: unknown }
      h.check(body.error === 'TASK_CONTRACT_INVALID', 'the structured error is preserved')
      h.check(body.issues?.some((issue) => issue.issueCode === 'VERIFIER_APPROVAL_REQUIRED') === true, 'the original issue is returned')
      h.check(body.autoRepair === undefined, 'no automatic repair was attempted for a semantic decision')
      h.check(createCalls === 0, 'no Session is created')
      h.check(rec.audit.length === 0, 'no repair attempt is audited')
      h.check(rec.llmCalls === 0, 'the model is never asked to grant approval')
    })
  },
}

export const s62: CertificationScenario = {
  id: 'S62', title: 'Automatic repair stops at the cycle bound and reports exhaustion', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const repo = join(ctx.dirs.repo)
    await initFixtureRepo(repo, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })
    let createCalls = 0
    const rec = recordingRepairDeps()
    await withLaunchpad(ctx, {
      gitProcessRunner: gitStub,
      createWorkSession: fakeApp(() => { createCalls++ }),
      repairNotifier: rec.notifier,
      repairAudit: rec.auditSink,
      repairLlmAgent: scriptedLlmAgent([{ criterion: 'a criterion that is not in the contract', requiredEvidence: ['npm test'] }]),
    }, async (launchpad) => {
      const response = await postCreate(launchpad, request(`cert-s62-${ctx.dirs.runId.replace(/[^a-z0-9_-]/giu, '')}`, repo, {
        acceptanceCriteria: [LLM_ONLY_CRITERION],
      }))
      h.check(response.status === 400, 'a contract that cannot be repaired fails closed')
      const body = await response.json() as {
        autoRepair?: { result?: string; cycles?: number; maxCycles?: number; exhausted?: boolean }
        issues?: Array<{ issueCode?: string }>
      }
      h.check(body.autoRepair?.result === 'AUTO_REPAIR_EXHAUSTED', 'exhaustion is named explicitly')
      h.check(body.autoRepair?.maxCycles === 2 && body.autoRepair.cycles === 2, 'the cycle bound is two and was reached')
      h.check(body.autoRepair?.exhausted === true, 'the response reports exhaustion')
      h.check(body.issues?.some((issue) => issue.issueCode === 'MISSING_EVIDENCE_BINDING') === true, 'the remaining issue is returned')
      h.check(createCalls === 0, 'no Session is created')
      const entry = rec.audit[0]
      h.check(entry?.autoRepair?.exhausted === true, 'the audit records exhaustion')
      h.check(entry?.stages.length === 2, 'exactly two repair cycles ran, never a third')
      h.check(rec.llmCalls === 0, 'the injected scripted agent replaces the live provider')
    })
  },
}

interface PreflightRepairProjection {
  aiRepairCount: number
  humanActionCount: number
  humanDecisionCount: number
  repairTriggeredByUser: number
  zeroHumanCompletion: boolean | null
}

async function projectPreflightRepair(
  ctx: ScenarioContext,
  sessionId: string,
  automatic: boolean,
): Promise<PreflightRepairProjection> {
  const definition = {
    id: sessionId, targetRepo: ctx.dirs.repo, branch: 'main',
    tasks: [{ id: 'T1', goal: 'fixed goal' }],
    limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
  }
  const url = storageUrl(join(ctx.dirs.data, sessionId))
  const runtime = new WorkSessionRuntime({
    definition,
    storageUrl: url,
    taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
    preflightRepair: { automatic },
    notificationRetryDelayMs: 0,
  })
  try {
    const state = await runtime.start()
    const base = createTaskStateV2(definition, definition.tasks[0]!)
    const task = { ...base, status: 'COMPLETED' as const, currentAction: 'COMPLETE' as const }
    return projectTaskRun({
      definition,
      task,
      state,
      events: state.taskEventLogs?.['T1'] ?? [],
      finalStatus: 'COMPLETED',
    }).summary
  } finally {
    await runtime.close()
  }
}

export const s63: CertificationScenario = {
  id: 'S63', title: 'Automatic repair adds no human action or human decision', group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(join(ctx.dirs.repo), { 'README.md': '# repo\n' })
    const automatic = await projectPreflightRepair(ctx, 'S63-auto', true)
    const manual = await projectPreflightRepair(ctx, 'S63-manual', false)
    h.check(automatic.humanActionCount === 0 && automatic.humanDecisionCount === 0, 'an unattended repair records no human action or decision')
    h.check(automatic.zeroHumanCompletion === true, 'a one-click start still counts as zero-human completion')
    h.check(manual.humanActionCount === 1 && manual.humanDecisionCount === 0, 'an operator retry is one human action, not a semantic decision')
    h.check(manual.zeroHumanCompletion === false, 'zero-human completion is disabled by the operator click')
  },
}

export const s64: CertificationScenario = {
  id: 'S64', title: 'Automatic and manual contract repairs are counted as AI repair', group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(join(ctx.dirs.repo), { 'README.md': '# repo\n' })
    const automatic = await projectPreflightRepair(ctx, 'S64-auto', true)
    const manual = await projectPreflightRepair(ctx, 'S64-manual', false)
    h.check(automatic.aiRepairCount === 1, 'the automatic repair is counted as AI repair')
    h.check(automatic.repairTriggeredByUser === 0, 'an automatic repair is not attributed to the operator')
    h.check(manual.aiRepairCount === 1, 'the manual repair is also counted as AI repair')
    h.check(manual.repairTriggeredByUser === 1, 'only the operator-triggered repair is attributed to the operator')
  },
}

export const s65: CertificationScenario = {
  id: 'S65', title: 'A repairable contract never flashes a red error before it launches', group: 'control',
  async run(ctx) {
    const h = ctx.h
    const html = renderLaunchpadHtml({
      configs: [], launchToken: 'cert-token', serverOrigin: 'http://127.0.0.1:1',
      initialExecutorMode: 'codex',
    })
    h.check(html.includes('data-composer-progress'), 'the composer shows staged progress instead of an immediate error block')
    h.check(html.includes('data-composer-error'), 'the final error surface still exists for unrecoverable contracts')
    h.check(LAUNCHPAD_APP_JS.includes('正在检查 Task Contract'), 'the progress copy starts with the contract check')
    h.check(LAUNCHPAD_APP_JS.includes('正在自动修复配置'), 'the progress copy names the automatic repair')
    h.check(LAUNCHPAD_APP_JS.includes('正在启动 Session'), 'the progress copy ends with the Session start')
    h.check(LAUNCHPAD_APP_JS.includes('autoRepairMessage'), 'only a final unrepaired contract renders the repair detail')
    h.check(ctx.dirs.scenarioId === 'S65', 'scenario context is available')
  },
}

interface NotificationRuntimeResult {
  overallStatus?: string
  channels?: readonly { channel: string; status: string }[]
  ledgerOverall?: string
  ledgerChannels?: readonly { channel: string; status: string }[]
  emailAttempts: number
  ledgerEventType?: string
}

async function deliverCompleted(
  ctx: ScenarioContext,
  sessionId: string,
  options: { emailFails: boolean; desktopFails: boolean },
): Promise<NotificationRuntimeResult> {
  let emailAttempts = 0
  const email = new SmtpWorkSessionNotifier({
    transport: { sendMail: async () => { emailAttempts += 1; if (options.emailFails) throw new Error('smtp 550 refused'); return { accepted: true } } },
    from: 'nova@example.invalid',
    to: 'operator@example.invalid',
  })
  const desktop = createWindowsTaskRunNotifier({
    platform: 'win32',
    timeoutMs: 5_000,
    spawnToast: async () => { if (options.desktopFails) throw new Error('toast exited 1') },
  })
  const definition = {
    id: sessionId, targetRepo: ctx.dirs.repo, branch: 'main',
    tasks: [{ id: 'T1', goal: 'complete one task' }],
    limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
  }
  const url = storageUrl(join(ctx.dirs.data, sessionId))
  const runtime = new WorkSessionRuntime({
    definition,
    storageUrl: url,
    taskRunner: { async run() { return { status: 'COMPLETED' as const } } },
    notificationChannels: [
      { channel: 'EMAIL', notifier: email },
      { channel: 'DESKTOP', notifier: desktop },
    ],
    notifyOnCompleted: true,
    notificationRetryDelayMs: 0,
  })
  try {
    await runtime.start()
    await runtime.getNotificationPromise()
    const delivery = runtime.getLastNotificationDelivery()
    return {
      ...(delivery?.overallStatus === undefined ? {} : { overallStatus: delivery.overallStatus }),
      ...(delivery?.channels === undefined ? {} : { channels: delivery.channels }),
      emailAttempts,
    }
  } finally {
    await runtime.close()
  }
  // The ledger is read after the runtime closes so the WAL is flushed.
}

async function readNotificationLedger(ctx: ScenarioContext, sessionId: string): Promise<{ ledgerEventType?: string; ledgerOverall?: string; ledgerChannels?: readonly { channel: string; status: string }[] }> {
  const events = readExecutionLedger(storageUrl(join(ctx.dirs.data, sessionId)), sessionId)
  // The discriminated union only carries notification fields on its notification members.
  const event = events.find((candidate) => candidate.eventType === 'NOTIFICATION_SENT' || candidate.eventType === 'NOTIFICATION_FAILED')
  if (event === undefined || (event.eventType !== 'NOTIFICATION_SENT' && event.eventType !== 'NOTIFICATION_FAILED')) {
    return {}
  }
  return {
    ledgerEventType: event.eventType,
    ...(event.notificationOverall === undefined ? {} : { ledgerOverall: event.notificationOverall }),
    ...(event.notificationChannels === undefined
      ? {}
      : { ledgerChannels: event.notificationChannels.map((channel) => ({ channel: channel.channel, status: channel.status })) }),
  }
}

export const s66: CertificationScenario = {
  id: 'S66', title: 'Email and Desktop both delivered → ALL_SUCCEEDED', group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(join(ctx.dirs.repo), { 'README.md': '# repo\n' })
    const delivered = await deliverCompleted(ctx, 'S66-both-sent', { emailFails: false, desktopFails: false })
    h.check(delivered.overallStatus === 'ALL_SUCCEEDED', 'the aggregate is ALL_SUCCEEDED')
    h.check(delivered.channels?.every((channel) => channel.status === 'SENT') === true, 'every channel reports SENT')
    const ledger = await readNotificationLedger(ctx, 'S66-both-sent')
    h.check(ledger.ledgerEventType === 'NOTIFICATION_SENT', 'the overall ledger event is NOTIFICATION_SENT')
    h.check(ledger.ledgerOverall === 'ALL_SUCCEEDED', 'the ledger carries the per-channel aggregate')
    h.check(ledger.ledgerChannels?.some((channel) => channel.channel === 'EMAIL' && channel.status === 'SENT') === true, 'the ledger keeps the email channel truth')
    h.check(ledger.ledgerChannels?.some((channel) => channel.channel === 'DESKTOP' && channel.status === 'SENT') === true, 'the ledger keeps the desktop channel truth')
  },
}

export const s67: CertificationScenario = {
  id: 'S67', title: 'Email delivered and Desktop failed → PARTIAL_SUCCESS', group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(join(ctx.dirs.repo), { 'README.md': '# repo\n' })
    const delivered = await deliverCompleted(ctx, 'S67-partial', { emailFails: false, desktopFails: true })
    h.check(delivered.overallStatus === 'PARTIAL_SUCCESS', 'the aggregate is PARTIAL_SUCCESS, never a plain failure')
    h.check(delivered.channels?.some((channel) => channel.channel === 'EMAIL' && channel.status === 'SENT') === true, 'the accepted email stays SENT')
    h.check(delivered.channels?.some((channel) => channel.channel === 'DESKTOP' && channel.status === 'FAILED') === true, 'the desktop channel reports its own failure')
    h.check(delivered.emailAttempts === 1, 'the desktop retry never re-sends the accepted email')
    const ledger = await readNotificationLedger(ctx, 'S67-partial')
    h.check(ledger.ledgerEventType === 'NOTIFICATION_SENT', 'the overall event does not collapse to NOTIFICATION_FAILED')
    h.check(ledger.ledgerOverall === 'PARTIAL_SUCCESS', 'the ledger keeps the partial aggregate')
    h.check(ledger.ledgerChannels?.some((channel) => channel.channel === 'EMAIL' && channel.status === 'SENT') === true,
      'the durable record still proves the email was sent')
  },
}

export const s68: CertificationScenario = {
  id: 'S68', title: 'Every channel failed → ALL_FAILED', group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(join(ctx.dirs.repo), { 'README.md': '# repo\n' })
    const delivered = await deliverCompleted(ctx, 'S68-all-failed', { emailFails: true, desktopFails: true })
    h.check(delivered.overallStatus === 'ALL_FAILED', 'the aggregate is ALL_FAILED')
    h.check(delivered.channels?.every((channel) => channel.status === 'FAILED') === true, 'every channel reports FAILED')
    const ledger = await readNotificationLedger(ctx, 'S68-all-failed')
    h.check(ledger.ledgerEventType === 'NOTIFICATION_FAILED', 'the overall ledger event is NOTIFICATION_FAILED')
    h.check(ledger.ledgerOverall === 'ALL_FAILED', 'the ledger carries the failing aggregate')
  },
}

export const s69: CertificationScenario = {
  id: 'S69', title: 'An SMTP-accepted email keeps Email SENT when Desktop fails', group: 'control',
  async run(ctx) {
    const h = ctx.h
    await initFixtureRepo(join(ctx.dirs.repo), { 'README.md': '# repo\n' })
    const delivered = await deliverCompleted(ctx, 'S69-smtp-accepted', { emailFails: false, desktopFails: true })
    const email = delivered.channels?.find((channel) => channel.channel === 'EMAIL')
    h.check(email?.status === 'SENT', 'the transport accepted the message, so the email channel is SENT')
    h.check(delivered.overallStatus === 'PARTIAL_SUCCESS', 'the whole notification is not reported as failed')
    h.check(delivered.emailAttempts === 1, 'the accepted message is never re-sent by the other channel retry')
    h.check(APP_JS.includes("PARTIAL_SUCCESS: '部分成功'"), 'the operator sees 部分成功, never the raw enum')
    h.check(APP_JS.includes("FAILED: '发送失败'"), 'a failed channel renders as 发送失败')
  },
}
