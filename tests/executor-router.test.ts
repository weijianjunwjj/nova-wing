import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTestRepo } from './codex-test-fixture.js'
import { ExecutorRouter, type ExecutorHandoffContext, type ExecutorRouterOptions, type RouterCodexExecutor } from '../packages/development-guardian/executor-router.js'
import { CodingExecutionStore } from '../packages/development-guardian/work-session/coding-execution-store.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import { readWorkspaceGit } from '../packages/development-guardian/codex-workspace-tools.js'
import { computeWorktreeFingerprint, parseGitStatus } from '../packages/development-guardian/work-session/worktree-fingerprint.js'
import type { DelegationPacket, ExecutionReport, GuardianTask } from '../packages/development-guardian/model.js'
import type { ExecutorMode } from '../packages/development-guardian/coding-executor-config.js'
import type { ProviderSessionState, RepositoryCheckpoint } from '../packages/development-guardian/work-session/checkpoint.js'

const task: GuardianTask = { id: 'T1', goal: 'Test task', state: 'READY', iteration: 0, maxIterations: 3,
  allowedPaths: ['src/**'], forbiddenPaths: ['secrets/**'], constraints: ['No API changes'], doNotDo: ['No reset'], acceptanceCriteria: ['Pass tests'] }
const packet: DelegationPacket = { goal: task.goal, verdict: 'revise', instructions: ['Fix the remaining failure'], constraints: [], doNotDo: [], verification: ['npm test'] }
const good = (): ExecutionReport => ({ summary: 'Completed', changedFiles: [], commandsRun: [], verificationResults: [], blockers: [] })

async function fixture(mode: ExecutorMode = 'auto', code?: string) {
  const cwd = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'novawing-executor-data-'))
  const store = new CodingExecutionStore(join(data, 'executor.sqlite'))
  let codexCalls = 0
  let dsCalls = 0
  let handoff: ExecutorHandoffContext | undefined
  let recovery: RepositoryCheckpoint | undefined
  let restored: ProviderSessionState | undefined
  const codex: RouterCodexExecutor = {
    async execute() {
      codexCalls++
      codex.lastError = code === undefined ? undefined : classifyCodexError({ code })
      return { ...good(), blockers: codex.lastError ? [codex.lastError.message] : [] }
    }, restoreProviderState(state) { restored = state },
  }
  const options: ExecutorRouterOptions = {
    cwd, taskKey: 'session:T1', store, mode,
    createCodex: () => codex,
    createDeepSeek(context) {
      handoff = context
      return { execute: async () => { dsCalls++; return good() }, setRecoveryCheckpoint(c) { recovery = c } }
    },
  }
  return { cwd, data, store, options, codex, get codexCalls() { return codexCalls }, get dsCalls() { return dsCalls },
    get handoff() { return handoff }, get recovery() { return recovery }, get restored() { return restored },
    close: async () => { await rm(cwd, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) } }
}

for (const [mode, code, expected] of [
  ['auto', undefined, 'codex'], ['auto', 'quota_exhausted', 'deepseek'],
  ['codex', 'quota_exhausted', 'codex'], ['deepseek', undefined, 'deepseek'],
  ['auto', 'auth_required', 'codex'], ['auto', 'model_not_found', 'codex'],
  ['auto', 'configuration_error', 'codex'], ['auto', 'ECONNRESET', 'codex'], ['auto', 'unexpected', 'codex'],
] as const) test(`router ${mode} / ${code ?? 'available'} selects ${expected}`, async () => {
  const f = await fixture(mode, code)
  try {
    const report = await new ExecutorRouter(f.options).execute({ task, packet })
    assert.equal(report.execution?.activeExecutor, expected)
    assert.equal(f.dsCalls, expected === 'deepseek' ? 1 : 0)
    assert.equal(f.codexCalls, mode === 'deepseek' ? 0 : code === 'ECONNRESET' ? 2 : 1)
    if (mode === 'codex' && code) assert.equal(report.blockers.length, 1)
  } finally { await f.close() }
})

test('quota handoff preserves two real edits, Task identity, known tests, feedback and scoped verification', async () => {
  const f = await fixture('auto', 'quota_exhausted')
  try {
    f.codex.execute = async () => {
      await writeFile(join(f.cwd, 'src/a.ts'), 'export const value = 2\n')
      await writeFile(join(f.cwd, 'src/b.ts'), 'export const partial = true\n')
      f.codex.lastError = classifyCodexError({ code: 'quota_exhausted' })
      return { ...good(), summary: 'Two files changed; tests still failing', changedFiles: ['src/a.ts', 'src/b.ts'],
        commandsRun: ['git status'], blockers: [f.codex.lastError.message] }
    }
    const withEvidence = { ...task, approvedVerificationCommand: 'npm run scoped-test', lastReport: { ...good(),
      verificationResults: [{ name: 'test A', status: 'passed' as const }, { name: 'test B', status: 'failed' as const, details: 'assertion failed' }] } }
    const report = await new ExecutorRouter(f.options).execute({ task: withEvidence, packet })
    assert.equal(report.execution?.activeExecutor, 'deepseek')
    assert.equal(f.handoff?.task.id, 'T1')
    assert.deepEqual(f.handoff?.changedFiles, ['src/a.ts', 'src/b.ts'])
    assert.equal(f.handoff?.knownTestResults.length, 2)
    assert.deepEqual(f.handoff?.unresolvedFailures, ['assertion failed'])
    assert.equal(f.handoff?.approvedVerificationCommand, 'npm run scoped-test')
    assert.deepEqual(f.handoff?.reviewerFeedback, packet)
    assert.deepEqual(f.handoff?.task.allowedPaths, task.allowedPaths)
    assert.match(f.handoff!.workingTree, /src\/b.ts/)
    assert.ok(f.recovery?.worktreeFingerprint)
    assert.match(await readFile(join(f.cwd, 'src/a.ts'), 'utf8'), /value = 2/)
    assert.match(await readFile(join(f.cwd, 'src/b.ts'), 'utf8'), /partial/)
  } finally { await f.close() }
})

test('one-shot controlled quota injection uses classifier, Router handoff, ownership transfer and sticky DeepSeek', async () => {
  const f = await fixture('auto')
  try {
    await writeFile(join(f.cwd, 'src/a.ts'), 'export const inheritedFromCodex = true\n')
    const status = await readWorkspaceGit(f.cwd, 'status')
    const entries = parseGitStatus(status)
    const diff = await readWorkspaceGit(f.cwd, 'diff')
    const prior = { ...good(), summary: 'Inherited from Codex: type definitions and risk classification',
      changedFiles: ['src/a.ts'], commandsRun: ['git status', 'git diff', 'read_file src/a.ts'] }
    f.store.save(f.options.taskKey, { mode: 'auto', activeExecutor: 'codex', history: ['codex'],
      model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
    { type: 'executor_completed', executor: 'codex', timestamp: '2026-09-02T00:00:00.000Z' })
    f.store.requestControlledQuotaInjection(f.options.taskKey, {
      injectionId: 'injection-1', kind: 'codex_quota_exhausted', taskId: 'T1',
      requestedAt: '2026-09-02T00:01:00.000Z', status: 'pending',
      expectedWorktreeFingerprint: await computeWorktreeFingerprint(f.cwd, entries),
      expectedChangedFiles: ['src/a.ts'], expectedDiffBytes: Buffer.byteLength(diff),
    })

    const report = await new ExecutorRouter(f.options).execute({ task: { ...task, lastReport: prior }, packet })

    assert.equal(f.codexCalls, 0, 'injection never invokes Codex')
    assert.equal(f.dsCalls, 1)
    assert.equal(report.execution?.activeExecutor, 'deepseek')
    assert.deepEqual(report.execution?.history, ['codex', 'deepseek'])
    assert.equal(report.execution?.failoverReason, 'codex_quota_exhausted')
    assert.equal(f.handoff?.codexExecutionSummary, prior.summary)
    assert.equal(f.store.controlledQuotaInjection(f.options.taskKey)?.status, 'consumed')
    const transfer = f.store.events(f.options.taskKey).slice(1).map((event) => event.type)
    assert.deepEqual(transfer.slice(0, 5), ['executor_error', 'executor_ownership_released',
      'executor_failed_over', 'executor_ownership_acquired', 'executor_started'])
    assert.equal(f.store.events(f.options.taskKey).find((event) => event.type === 'executor_failed_over')?.testInjected, true)
    await new ExecutorRouter(f.options).execute({ task: { ...task, lastReport: prior }, packet })
    assert.equal(f.codexCalls, 0)
    assert.equal(f.dsCalls, 2, 'sticky continuation stays on DeepSeek')
  } finally { await f.close() }
})

test('large Codex diff survives provider error and sticky DeepSeek recovery without a second writer', async () => {
  const f = await fixture('auto', 'quota_exhausted')
  const t031 = { ...task, id: 'T031', goal: `large handoff drill:${'criteria '.repeat(9_000)}` }
  const taskKey = '["handoff-drill","T031"]'
  const options = { ...f.options, taskKey }
  const inherited = `export const inherited = ${JSON.stringify('x'.repeat(70_000))}\n`
  let codexInvocations = 0
  try {
    f.codex.execute = async () => {
      codexInvocations++
      await writeFile(join(f.cwd, 'src/a.ts'), inherited)
      f.codex.lastError = classifyCodexError({ code: 'quota_exhausted' })
      return { ...good(), summary: 'Inherited from Codex', changedFiles: ['src/a.ts'], commandsRun: ['git status'],
        blockers: [f.codex.lastError.message] }
    }
    options.createDeepSeek = (context) => ({ execute: async () => {
      assert.equal(context?.task.id, 'T031')
      assert.ok(JSON.stringify(context).length > 65_000)
      assert.deepEqual(context?.changedFiles, ['src/a.ts'])
      throw Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' })
    } })

    await assert.rejects(new ExecutorRouter(options).execute({ task: t031, packet }), /ENAMETOOLONG/u)
    assert.deepEqual(f.store.read(taskKey)?.history, ['codex', 'deepseek'])
    assert.equal(f.store.read(taskKey)?.activeExecutor, 'deepseek')
    assert.equal(codexInvocations, 1)
    await assert.rejects(new ExecutorRouter(options).execute({ task: t031, packet }), /ownership unavailable/u)

    const resolved = await realpath(f.cwd)
    const workspace = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    assert.equal(f.store.recoverOwnership(workspace, taskKey), true)
    let recoveredHandoff: ExecutorHandoffContext | undefined
    options.createDeepSeek = (context) => {
      recoveredHandoff = context
      return { execute: async () => good() }
    }
    const recovered = await new ExecutorRouter(options).execute({ task: t031, packet })
    assert.equal(recovered.execution?.activeExecutor, 'deepseek')
    assert.deepEqual(recovered.execution?.history, ['codex', 'deepseek'])
    assert.equal(recoveredHandoff?.task.id, 'T031')
    assert.ok(JSON.stringify(recoveredHandoff).length > 65_000)
    assert.deepEqual(recoveredHandoff?.changedFiles, ['src/a.ts'])
    assert.equal(await readFile(join(f.cwd, 'src/a.ts'), 'utf8'), inherited)
    assert.equal(codexInvocations, 1, 'provider recovery never routes sticky T031 back to Codex')
    assert.deepEqual(f.store.events(taskKey).filter(event => event.type === 'executor_failed_over').map(event => [event.from, event.to]),
      [['codex', 'deepseek']])
  } finally { await f.close() }
})

test('scope violation dominates quota: no rollback and no DeepSeek takeover', async () => {
  const f = await fixture('auto', 'quota_exhausted')
  try {
    f.codex.execute = async () => {
      f.codex.lastError = classifyCodexError({ code: 'quota_exhausted' })
      return { ...good(), changedFiles: ['outside.ts'], blockers: [f.codex.lastError.message, 'changed file is outside allowed scope: outside.ts'] }
    }
    const report = await new ExecutorRouter(f.options).execute({ task, packet })
    assert.equal(f.dsCalls, 0)
    assert.equal(report.execution?.activeExecutor, 'codex')
  } finally { await f.close() }
})

test('active turn holds workspace ownership despite quota update; no simultaneous executor', async () => {
  const f = await fixture()
  let finish!: () => void
  let entered!: () => void
  const active = new Promise<void>((resolve) => { entered = resolve })
  const barrier = new Promise<void>((resolve) => { finish = resolve })
  try {
    f.codex.execute = async () => {
      f.codex.lastError = classifyCodexError({ code: 'quota_exhausted' })
      f.store.markQuota(f.codex.lastError, Date.now(), 60_000)
      entered()
      await barrier
      return { ...good(), blockers: [f.codex.lastError!.message] }
    }
    const running = new ExecutorRouter(f.options).execute({ task, packet })
    await active
    assert.equal(f.dsCalls, 0)
    await assert.rejects(new ExecutorRouter({ ...f.options, taskKey: 'other', mode: 'deepseek' }).execute({ task, packet }), /ownership unavailable/)
    finish()
    await running
    assert.equal(f.dsCalls, 1)
  } finally { finish(); await f.close() }
})

test('durable sticky failover survives new router and store; future Tasks re-probe after cooldown', async () => {
  const f = await fixture('auto', 'quota_exhausted')
  let now = Date.parse('2026-08-31T00:00:00Z')
  try {
    const options = { ...f.options, clock: () => now, quotaProbeCooldownMs: 60_000 }
    await new ExecutorRouter(options).execute({ task, packet })
    const reopened = new CodingExecutionStore(f.store.path)
    await new ExecutorRouter({ ...options, store: reopened }).execute({ task, packet })
    assert.equal(f.codexCalls, 1)
    assert.equal(f.handoff?.task.id, 'T1', 'handoff survives runtime restart with sticky routing')
    await new ExecutorRouter({ ...options, taskKey: 'session:T2' }).execute({ task: { ...task, id: 'T2' }, packet })
    assert.equal(f.codexCalls, 1)
    now += 60_001
    f.codex.execute = async () => { f.codex.lastError = undefined; return good() }
    const newTask = await new ExecutorRouter({ ...options, taskKey: 'session:T3' }).execute({ task: { ...task, id: 'T3' }, packet })
    assert.equal(newTask.execution?.activeExecutor, 'codex')
    assert.equal(f.store.availability().state, 'available')
    const old = await new ExecutorRouter(options).execute({ task, packet })
    assert.equal(old.execution?.activeExecutor, 'deepseek')
    assert.deepEqual(old.execution?.history, ['codex', 'deepseek'])
  } finally { await f.close() }
})

test('unconfirmed termination retains ownership and prevents retry/failover', async () => {
  const f = await fixture('auto', 'quota_exhausted')
  try {
    f.codex.hasReleasedExecutionOwnership = () => false
    const report = await new ExecutorRouter(f.options).execute({ task, packet })
    assert.equal(f.dsCalls, 0)
    assert.match(report.blockers.join(' '), /termination is unconfirmed/)
    await assert.rejects(new ExecutorRouter(f.options).execute({ task, packet }), /ownership unavailable/)
  } finally { await f.close() }
})

test('explicit recovery releases only the matching Task workspace ownership', async () => {
  const f = await fixture()
  try {
    const resolved = await realpath(f.cwd)
    const workspace = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    f.codex.hasReleasedExecutionOwnership = () => false
    await new ExecutorRouter(f.options).execute({ task, packet })
    assert.equal(f.store.recoverOwnership(workspace, 'other-task'), false)
    await assert.rejects(new ExecutorRouter(f.options).execute({ task, packet }), /ownership unavailable/)
    assert.equal(f.store.recoverOwnership(workspace, f.options.taskKey), true)
    f.codex.hasReleasedExecutionOwnership = () => true
    await new ExecutorRouter(f.options).execute({ task, packet })
    assert.equal(f.store.events(f.options.taskKey).some(event => event.type === 'executor_ownership_recovered'), true)
  } finally { await f.close() }
})

test('reliable quota reset timestamp suppresses new Tasks until reset without a five-hour guess', async () => {
  const f = await fixture()
  let now = Date.parse('2026-08-31T00:00:00Z')
  try {
    const reset = now + 123_000
    f.store.markQuota(classifyCodexError({ code: 'quota_exhausted', reset_at: reset / 1000 }, now), now, 60_000)
    const options = { ...f.options, clock: () => now }
    await new ExecutorRouter(options).execute({ task, packet })
    assert.equal(f.codexCalls, 0)
    now = reset
    await new ExecutorRouter({ ...options, taskKey: 'after-reset' }).execute({ task: { ...task, id: 'T2' }, packet })
    assert.equal(f.codexCalls, 1)
    assert.equal(f.store.availability().state, 'available')
  } finally { await f.close() }
})

test('Codex thread identity is persisted before completion and passed back on restart', async () => {
  const f = await fixture()
  try {
    let created = 0
    const options = { ...f.options, createCodex: (onThread: (id: string, resumed: boolean) => void) => {
      const executor = f.codex
      executor.execute = async () => { onThread('durable-thread', created++ > 0); return good() }
      return executor
    } }
    await new ExecutorRouter(options).execute({ task, packet })
    assert.equal(f.store.read(options.taskKey)?.codexThreadId, 'durable-thread')
    await new ExecutorRouter(options).execute({ task, packet })
    assert.equal(f.restored?.codingExecution?.codexThreadId, 'durable-thread')
    assert.deepEqual(f.store.events(options.taskKey).filter((e) => e.type.startsWith('codex_thread')).map((e) => e.type),
      ['codex_thread_started', 'codex_thread_resumed'])
  } finally { await f.close() }
})

test('confirmed no-op retry replaces only the stale Codex thread identity', async () => {
  const f = await fixture()
  try {
    f.store.save(f.options.taskKey, {
      mode: 'auto', activeExecutor: 'codex', history: ['codex'],
      model: 'gpt-5.6-sol', reasoningEffort: 'medium', codexThreadId: 'stale-no-op-thread',
      lastError: 'NO_OP_EXECUTION: workspace inspection missing', lastErrorKind: 'no_op_execution',
    })
    const router = new ExecutorRouter(f.options)
    await router.preflight({ ...task, state: 'HUMAN_REQUIRED', recoveryContinuation: true,
      resumeInput: { approval: true } })
    const persisted = f.store.read(f.options.taskKey)
    assert.equal(persisted?.codexThreadId, undefined)
    assert.equal(persisted?.lastError, undefined)
    assert.equal(persisted?.lastErrorKind, undefined)
    assert.equal(persisted?.activeExecutor, 'codex')
    assert.deepEqual(persisted?.history, ['codex'])
    assert.equal(f.restored?.codingExecution?.codexThreadId, undefined)
    assert.equal(f.store.events(f.options.taskKey).at(-1)?.type, 'codex_thread_replaced')
  } finally { await f.close() }
})

test('Direct no-op auto retry replaces only the stale Codex thread identity', async () => {
  const f = await fixture()
  try {
    f.store.save(f.options.taskKey, {
      mode: 'auto', activeExecutor: 'codex', history: ['codex'],
      model: 'gpt-5.6-sol', reasoningEffort: 'medium', codexThreadId: 'stale-direct-thread',
      lastError: 'NO_OP_EXECUTION: workspace inspection missing', lastErrorKind: 'no_op_execution',
    })
    const router = new ExecutorRouter(f.options)
    assert.equal(router.prepareNoOpRetry(), true)
    const persisted = f.store.read(f.options.taskKey)
    assert.equal(persisted?.codexThreadId, undefined)
    assert.equal(persisted?.lastError, undefined)
    assert.equal(persisted?.lastErrorKind, undefined)
    assert.equal(persisted?.activeExecutor, 'codex')
    assert.deepEqual(persisted?.history, ['codex'])
    assert.equal(f.store.events(f.options.taskKey).at(-1)?.type, 'codex_thread_replaced')
  } finally { await f.close() }
})
