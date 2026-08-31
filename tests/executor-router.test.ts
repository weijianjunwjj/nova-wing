import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTestRepo } from './codex-test-fixture.js'
import { ExecutorRouter, type ExecutorHandoffContext, type ExecutorRouterOptions, type RouterCodexExecutor } from '../packages/development-guardian/executor-router.js'
import { CodingExecutionStore } from '../packages/development-guardian/work-session/coding-execution-store.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
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
