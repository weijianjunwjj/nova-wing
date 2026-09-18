/**
 * NovaWing v0.2.6 — real dogfood: one-click create with Automatic Preflight Repair.
 *
 * It drives the REAL Launchpad HTTP create endpoint against a real throwaway git
 * repository with a REAL-001-shaped contract (acceptance criteria and no evidence
 * bindings), and reports exactly what happened.
 *
 * What is real:
 *   - the Launchpad server, its composer payload validation, and POST /api/session/create;
 *   - Task Contract preflight and the whole repair cascade (deterministic agent,
 *     mechanical validation, re-preflight) INCLUDING the live Codex repair model
 *     when the deterministic agent cannot judge a criterion;
 *   - createProductionWorkSessionUi + WorkSessionRuntime + the persisted Session,
 *     its Task Event Log, and the Task Run Analytics projection.
 *
 * What is scripted (documented, and irrelevant to the create-flow claim):
 *   - the executor/model response at the documented `createV2Dispatcher` seam, so
 *     the dogfood does not consume live executor quota. The claim under test is
 *     "one click → automatic repair → Session RUNNING", not model cognition.
 *
 * Safety: everything happens under .tmp/dogfood-026. It never pushes, merges, tags,
 * or touches the operator's real artifacts, and it never fabricates a channel result.
 *
 * Usage:
 *   npm run build && node scripts/dogfood-v026-preflight-repair.mjs
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

import { createNovaWingLaunchpad } from '../dist/packages/development-guardian/work-session/launchpad/server.js'
import { createProductionWorkSessionUi } from '../dist/packages/development-guardian/work-session/production.js'
import { resolveProductionSmtpEnvironment } from '../dist/packages/development-guardian/work-session/local-smtp-secrets.js'
import { TaskRunAnalyticsStore, defaultTaskRunAnalyticsPath } from '../dist/packages/development-guardian/work-session/task-run-analytics.js'

const execFileAsync = promisify(execFile)
const runId = `v026-${new Date().toISOString().replace(/[:.]/gu, '-')}`
const work = resolve('.tmp', 'dogfood-026', runId)
const repo = join(work, 'repo')
const configDirectory = join(work, 'configs')
const dataDir = join(work, 'data')

// The REAL-001 brief: eight acceptance criteria with no evidence bindings. The
// composer prepends its two standing policy criteria, so the request carries the
// eight task-specific ones.
const REAL_001_CRITERIA = [
  'AC1 请求进行期间重复点击不会产生第二次 ticket 创建请求。',
  'AC2 请求进行期间提交按钮显示明确的提交中状态并不可重复提交。',
  'AC3 请求成功后用户可以看到明确成功反馈。',
  'AC4 请求失败后提交状态恢复，用户可以再次尝试提交，并有明确失败反馈。',
  'AC5 相关自动测试覆盖重复提交、成功和失败恢复路径。',
  'AC6 相关自动测试全部通过。',
  'AC7 项目现有必要静态检查通过。',
  'AC8 repository diff 无 whitespace error。',
]

async function git(args, cwd = repo) {
  return await execFileAsync('git', args, { cwd, windowsHide: true })
}

async function seedRepository() {
  await mkdir(join(repo, 'apps', 'web'), { recursive: true })
  await mkdir(join(repo, 'tests'), { recursive: true })
  await writeFile(join(repo, 'package.json'), `${JSON.stringify({
    name: 'fly-weave-dogfood-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test tests', typecheck: 'node --test tests' },
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(repo, 'apps', 'web', 'ticket-form.js'), [
    'export function createTicketForm(root) {',
    '  return { root, submitting: false }',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(repo, 'tests', 'ticket-submit.test.js'), [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { createTicketForm } from '../apps/web/ticket-form.js'",
    '',
    "test('ticket form starts idle', () => {",
    "  assert.equal(createTicketForm({}).submitting, false)",
    '})',
    '',
  ].join('\n'), 'utf8')
  await git(['init', '-q', '-b', 'dogfood/real-001-style'])
  await git(['add', '-A'])
  await git(['-c', 'user.name=Dogfood', '-c', 'user.email=dogfood@example.invalid', 'commit', '-qm', 'fixture baseline'])
}

/** The scripted executor holds its first dispatch so RUNNING stays observable. */
let releaseExecutor
let executorHeld = false
const executorGate = new Promise((resolveGate) => { releaseExecutor = resolveGate })

function scriptedDispatcher() {
  return {
    inspectRepository: async () => {
      const [branch, head] = await Promise.all([git(['branch', '--show-current']), git(['rev-parse', 'HEAD'])])
      return {
        repositoryIdentity: repo,
        branch: branch.stdout.trim(),
        headSha: head.stdout.trim(),
        changedFiles: [],
        worktreeFingerprint: head.stdout.trim(),
      }
    },
    dispatch: async () => {
      executorHeld = true
      await executorGate
      return { status: 'SUCCESS' }
    },
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function emailChannelState() {
  try {
    await resolveProductionSmtpEnvironment({ notification: { email: { enabled: true } } })
    return { enabled: true }
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : 'SMTP 不可用' }
  }
}

async function readPersistedConfig() {
  const files = (await readdir(configDirectory).catch(() => [])).filter((name) => name.endsWith('.json'))
  for (const name of files) {
    const config = JSON.parse(await readFile(join(configDirectory, name), 'utf8'))
    if (config?.session?.targetRepo === repo) return { name, config }
  }
  return undefined
}

const report = {
  runId, work, repo, email: {}, legend: {}, create: {}, session: {}, analytics: {}, notes: [],
}

try {
  await seedRepository()
  await mkdir(configDirectory, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const email = await emailChannelState()
  report.email = email
  if (!email.enabled) report.notes.push(`邮件渠道未启用（${email.reason ?? '未知原因'}）；本轮只验证创建流程。`)

  let created
  const repairAudit = []
  const launchpad = await createNovaWingLaunchpad({
    configDirectory,
    dependencies: {
      repairAudit: { record: async (entry) => { repairAudit.push(entry) } },
      createWorkSession: async (config, options) => {
        const app = await createProductionWorkSessionUi(config, {
          ...options,
          createV2Dispatcher: () => scriptedDispatcher(),
          v2Agents: [{
            id: 'dogfood-implementer',
            identity: { agent: 'dogfood-implementer', provider: 'codex', runtimeIdentity: `session:${config.session.id}:dogfood-implementer` },
            available: true, quotaExhausted: false, degraded: false,
            capabilities: { coding: true, reasoning: true, verification: true, review: true },
          }],
        })
        created = app
        return app
      },
    },
  })

  try {
    const address = await launchpad.start()
    report.legend = {
      real: ['Launchpad HTTP create', 'Task Contract preflight', 'repair cascade', 'live Codex repair model when consulted', 'production runtime', 'persisted Session', 'Task Event Log', 'Task Run Analytics'],
      scripted: ['executor response at the createV2Dispatcher seam'],
    }

    const requestBody = {
      requestId: `dogfood-v026-${runId}`,
      targetRepo: repo,
      tasks: [{ id: 'REAL-001', goal: '为用户创建接口补充输入参数校验。' }],
      branch: 'dogfood/real-001-style',
      scheduled_start_at: null,
      schedule_source: 'immediate',
      executorModel: 'sonnet',
      executorMode: 'codex',
      codexModel: 'gpt-5.6-terra',
      codexReasoningEffort: 'high',
      softMinutes: 45,
      hardMinutes: 90,
      autoCommit: false,
      autoPush: false,
      emailEnabled: email.enabled,
      guardian: {
        allowedPaths: ['apps/web/**', 'tests/**'],
        acceptanceCriteria: REAL_001_CRITERIA,
      },
    }

    const started = Date.now()
    const response = await fetch(`${address.url}/api/session/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NovaWing-Launchpad-Token': launchpad.getTokenForTest(),
        Origin: address.url,
      },
      body: JSON.stringify(requestBody),
    })
    const text = await response.text()
    report.create = {
      status: response.status,
      body: text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text,
      elapsedMs: Date.now() - started,
      httpRequests: 1,
      humanClicks: 1,
    }
    if (response.status !== 202) throw new Error(`create failed: ${response.status} ${text}`)
    const parsed = JSON.parse(text)

    let state
    for (let attempt = 0; attempt < 300; attempt++) {
      state = created?.runtime?.getDurableState?.()
      if (executorHeld && state?.state === 'RUNNING') break
      await sleep(50)
    }
    const taskId = Object.keys(state?.taskStatesV2 ?? {})[0] ?? 'REAL-001'
    const taskLog = state?.taskEventLogs?.[taskId] ?? []
    report.session = {
      sessionId: state?.sessionId ?? null,
      state: state?.state ?? null,
      currentTaskId: state?.currentTaskId ?? null,
      taskStatus: state?.taskStatesV2?.[taskId]?.status ?? null,
      currentAction: state?.taskStatesV2?.[taskId]?.currentAction ?? null,
      acceptanceEvidenceBindings: (state?.taskStatesV2?.[taskId]?.completion?.bindings ?? []).map((binding) => ({
        criterion: binding.criterion,
        requiredEvidence: binding.requiredEvidence,
      })),
      seededAiRepairEvents: taskLog.filter((event) => event.type.startsWith('AI_REPAIR')).map((event) => event.type),
      seededHumanActions: taskLog.filter((event) => event.type === 'HUMAN_ACTION_RECORDED').length,
      executorDispatched: taskLog.some((event) => event.type === 'AGENT_DISPATCHED' && event.action === 'EXECUTE'),
      controlUrlIssued: typeof parsed.controlUrl === 'string',
    }

    const persisted = await readPersistedConfig()
    if (persisted !== undefined) {
      report.session.persistedCriterionCount = persisted.config.tasks?.[0]?.guardian?.acceptanceCriteria?.length ?? 0
      report.session.persistedBindings = (persisted.config.tasks?.[0]?.acceptanceEvidenceBindings ?? []).map((binding) => ({
        criterion: binding.criterion,
        requiredEvidence: binding.requiredEvidence,
      }))
    }

    report.repairAudit = repairAudit.map((entry) => ({
      automatic: entry.automatic ?? false,
      classification: entry.classification,
      llmInvoked: entry.llmInvoked,
      sessionStarted: entry.sessionStarted,
      deterministicAttempted: entry.deterministicAttempted,
      provider: entry.provider ?? null,
      stages: entry.stages.map((stage) => ({ agent: stage.agent, classification: stage.classification, validation: stage.validation ?? null, reflightPassed: stage.reflightPassed ?? null })),
      autoRepair: entry.autoRepair === undefined
        ? null
        : {
            maxCycles: entry.autoRepair.maxCycles,
            cycles: entry.autoRepair.cycles,
            exhausted: entry.autoRepair.exhausted,
            events: entry.autoRepair.events.map((event) => event.event),
          },
    }))

    releaseExecutor()
    await sleep(2_000)

    const store = new TaskRunAnalyticsStore(defaultTaskRunAnalyticsPath({ ...process.env, NOVAWING_DATA_DIR: dataDir }))
    try {
      report.analytics = store.findBySession(report.session.sessionId ?? '').map((row) => ({
        taskId: row.taskId,
        finalStatus: row.finalStatus,
        aiRepairCount: row.aiRepairCount,
        humanActionCount: row.humanActionCount,
        humanDecisionCount: row.humanDecisionCount,
        repairTriggeredByUser: row.repairTriggeredByUser,
        zeroHumanCompletion: row.zeroHumanCompletion,
      }))
    } finally {
      store.close()
    }

    report.verdict = {
      oneClickStart: report.create.status === 202 && report.create.httpRequests === 1,
      repaired: parsed.repaired === true,
      running: report.session.state === 'RUNNING',
      allCriteriaBound: REAL_001_CRITERIA.every((criterion) =>
        (report.session.persistedBindings ?? []).some((binding) => binding.criterion === criterion && binding.requiredEvidence.length > 0)),
      zeroHumanExtraInteraction: report.session.seededHumanActions === 0,
      // The AI repair is recorded in the real persisted Task Event Log, which is
      // exactly what the Task Run Analytics projection counts.
      aiRepairRecordedInSessionState: report.session.seededAiRepairEvents.includes('AI_REPAIR_STARTED'),
      // Informational: a terminal row only exists once the Session reaches COMPLETED/FAILED.
      analyticsRowProjected: report.analytics.length > 0,
    }
    if (!report.verdict.analyticsRowProjected) {
      report.notes.push('本 Session 按设计停留在 RUNNING，因此没有终态 Analytics 行；AI 修复事实已写入真实持久化 Task Event Log。')
    }
    console.log(JSON.stringify(report, null, 2))
  } finally {
    releaseExecutor()
    await launchpad.close().catch(() => undefined)
  }
} catch (error) {
  report.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
} finally {
  await writeFile(join(resolve('.tmp', 'dogfood-026'), `${runId}-report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined)
  if (process.env.NOVAWING_DOGFOOD_KEEP !== '1') await rm(work, { recursive: true, force: true }).catch(() => undefined)
}
