import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, realpath, rm, symlink, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createProductionWorkSessionUi, validateTrustedWorkSessionConfig } from '../packages/development-guardian/work-session/production.js'
import type { WorkSessionRuntimeConfig } from '../packages/development-guardian/work-session/runtime.js'
import { TaskEventLogV2 } from '../packages/development-guardian/work-session/task-observability.js'
import { FakeRuntime } from './work-session-w005-a-helpers.js'
import { scopeBlockers } from '../packages/development-guardian/claude-code-executor.js'
import type { Thread, ThreadEvent } from '@openai/codex-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CodexExecutor } from '../packages/development-guardian/codex-executor.js'
import { CodexWorkspaceTools } from '../packages/development-guardian/codex-workspace-tools.js'
import type { GuardianTask } from '../packages/development-guardian/model.js'
import { codexTestRepo } from './codex-test-fixture.js'

const task: GuardianTask = { id: 'T1', goal: 'Implement scoped change', state: 'READY', iteration: 0,
  maxIterations: 3, allowedPaths: ['src/**'], forbiddenPaths: ['src/private/**'] }
const packet = { goal: task.goal, verdict: 'proceed' as const, instructions: [], constraints: [], doNotDo: [], verification: [] }
function executor(root: string, probe: (client: Client) => Promise<void>, summary = 'Completed') {
  return new CodexExecutor({ cwd: root, preflight: async () => ({ executable: 'fake', mcpNames: [] }),
    createCodex: options => {
      const thread = { runStreamed: async () => ({ events: (async function* () {
        const url = /url="([^"]+)"/u.exec(options.configOverrides!.at(-1)!)![1]!
        const client = new Client({ name: 'scope-result-fixture', version: '1' })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Parameters<Client['connect']>[0])
          await probe(client)
        } finally { await client.close() }
        yield { type: 'item.completed', item: { id: 'summary', type: 'agent_message', text: summary } } as ThreadEvent
        yield { type: 'turn.completed', usage: {} } as ThreadEvent
      })() }) } as unknown as Thread
      return { startThread: () => thread, resumeThread: () => thread }
    } })
}

test('absolute repo scope accepts a relative write', async () => {
  const root = await codexTestRepo()
  try {
    const tools = await CodexWorkspaceTools.create(root, { ...task, allowedPaths: [await realpath(root)] })
    await tools.call('write_file', { path: 'server/domain.js', content: 'export const implemented = true\n' })
    await tools.revoke()
    assert.match(await readFile(join(root, 'server/domain.js'), 'utf8'), /implemented/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const count of [1, 12]) test(`successful inspection followed by ${count} rejected writes cannot succeed`, async () => {
  const root = await codexTestRepo()
  try {
    const report = await executor(root, async client => {
      await client.callTool({ name: 'git_status', arguments: {} })
      for (let i = 0; i < count; i++) {
        const result = await client.callTool({ name: 'write_file', arguments: { path: 'src/private/secret.ts', content: 'denied' } })
        assert.equal(result.isError, true)
      }
    }).execute({ task, packet })
    assert.ok(report.blockers.length > 0, 'successful reads must not erase mutation failures')
    assert.deepEqual(report.changedFiles, [])
    assert.equal(report.workspaceExecution?.outcome, 'EXECUTION_BLOCKED')
    assert.equal(report.workspaceExecution?.mutationFailures.length, count)
    assert.ok(report.blockers.every(blocker => blocker.startsWith('EXECUTION_BLOCKED:')))
    assert.deepEqual(report.verificationResults, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const kind of ['absolute', 'parent', 'symlink', 'forbidden', 'absolute-forbidden'] as const) test(`root scope still rejects ${kind} writes`, async () => {
  const root = await codexTestRepo()
  const outside = await codexTestRepo()
  try {
    const canonical = await realpath(root)
    const tools = await CodexWorkspaceTools.create(root, { ...task, allowedPaths: [canonical],
      forbiddenPaths: [kind === 'absolute-forbidden' ? join(canonical, 'src/private/**') : 'src/private/**'] })
    if (kind === 'symlink') await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const path = kind === 'absolute' ? join(root, 'src/a.ts') : kind === 'parent' ? '../outside' :
      kind === 'symlink' ? 'linked/src/a.ts' : 'src/private/denied.ts'
    await assert.rejects(tools.call('write_file', { path, content: 'DENIED' }))
    assert.equal(tools.mutationFailures.length, 1)
    await tools.revoke()
    assert.equal(await readFile(join(root, 'src/a.ts'), 'utf8'), 'export const value = 1\n')
    assert.equal(await readFile(join(outside, 'src/a.ts'), 'utf8'), 'export const value = 1\n')
  } finally {
    await rm(join(root, 'linked'), { force: true })
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true })
  }
})

test('scope boundary rejects outside absolute rules and preserves narrow absolute subdirectory scopes', async () => {
  const root = await codexTestRepo()
  try {
    await assert.rejects(CodexWorkspaceTools.create(root, { ...task, allowedPaths: [join(root, '..', 'other')] }))
    const tools = await CodexWorkspaceTools.create(root, { ...task, allowedPaths: [join(await realpath(root), 'src')] })
    await tools.call('write_file', { path: 'src/a.ts', content: 'export const value = 2\n' })
    await assert.rejects(tools.call('write_file', { path: 'server/domain.js', content: 'denied' }))
    await tools.revoke()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('tool argument errors, deletes and unsupported mutations remain structured blockers after reads', async () => {
  const root = await codexTestRepo()
  try {
    const report = await executor(root, async client => {
      await client.callTool({ name: 'list_files', arguments: {} })
      for (const request of [
        { name: 'write_file', arguments: { path: 'src/a.ts', content: 12 } },
        { name: 'write_file', arguments: { path: 12, content: 'denied' } },
        { name: 'write_file', arguments: { content: 'denied' } },
        { name: 'delete_file', arguments: { path: 'src/missing.ts' } },
        { name: 'delete_file', arguments: { path: '../outside' } },
        { name: 'edit_file', arguments: { path: 'src/a.ts' } },
        { name: 'mkdir', arguments: { path: 'src/new' } },
      ]) assert.equal((await client.callTool(request)).isError, true)
    }).execute({ task, packet })
    assert.equal(report.workspaceExecution?.outcome, 'EXECUTION_BLOCKED')
    assert.equal(report.workspaceExecution?.mutationFailures.length, 7)
    assert.deepEqual(report.changedFiles, [])
    const tools = await CodexWorkspaceTools.create(root, task)
    for (const name of ['edit_file', 'mkdir']) await assert.rejects(tools.call(name, { path: 'src/a.ts' }))
    assert.equal(tools.mutationFailures.length, 2)
    await tools.revoke()
  } finally { await rm(root, { recursive: true, force: true }) }
})

const satisfied = JSON.stringify({ outcome: 'ALREADY_SATISFIED', reason: 'The requested constant already equals 1.',
  evidence: [{ path: 'src/a.ts', quote: 'export const value = 1' }] })
for (const mode of ['valid', 'verbal', 'unread', 'fabricated', 'read-only', 'denied'] as const) test(`explicit no-op evidence: ${mode}`, async () => {
  const root = await codexTestRepo()
  try {
    const summary = mode === 'verbal' ? 'Already done.' : mode === 'fabricated' ? satisfied.replace('value = 1', 'value = 999') : satisfied
    const report = await executor(root, async client => {
      await client.callTool({ name: 'git_status', arguments: {} })
      if (mode !== 'unread') await client.callTool({ name: 'read_file', arguments: { path: 'src/a.ts' } })
      if (mode === 'denied') await client.callTool({ name: 'write_file', arguments: { path: 'src/private/no.ts', content: 'no' } })
    }, summary).execute({ task: { ...task, goal: 'Ensure exported value is 1',
      ...(mode === 'read-only' ? { allowedPaths: ['docs'] } : {}) }, packet })
    assert.deepEqual(report.changedFiles, [])
    if (mode === 'valid' || mode === 'read-only') {
      assert.deepEqual(report.blockers, [])
      assert.equal(report.workspaceExecution?.outcome, 'ALREADY_SATISFIED')
      assert.match(report.workspaceExecution?.alreadySatisfied?.files[0]?.sha256 ?? '', /^[a-f0-9]{64}$/u)
      assert.equal(report.verificationResults[0]?.status, 'passed')
    } else {
      assert.ok(report.blockers.length)
      assert.equal(report.workspaceExecution?.outcome, 'EXECUTION_BLOCKED')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a legal write followed by a denied write remains blocked even with changedFiles', async () => {
  const root = await codexTestRepo()
  try {
    const report = await executor(root, async client => {
      await client.callTool({ name: 'write_file', arguments: { path: 'src/a.ts', content: 'export const value = 2\n' } })
      await client.callTool({ name: 'write_file', arguments: { path: '../escape', content: 'no' } })
    }).execute({ task, packet })
    assert.deepEqual(report.changedFiles, ['src/a.ts'])
    assert.equal(report.workspaceExecution?.outcome, 'EXECUTION_BLOCKED')
    assert.equal(report.blockers.length, 1)
    assert.deepEqual(report.verificationResults, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const legacy of [true, false]) test(`Requirement 001 T1 scope fixture writes server/domain.js; legacy=${legacy}`, async () => {
  const root = await codexTestRepo()
  try {
    const report = await executor(root, async client => {
      await client.callTool({ name: 'git_status', arguments: {} })
      const result = await client.callTool({ name: 'write_file', arguments: {
        path: 'server/domain.js', content: 'export const orderingDomain = { ready: true }\n' } })
      assert.notEqual(result.isError, true)
    }).execute({ task: { ...task, allowedPaths: [legacy ? await realpath(root) : '.'], forbiddenPaths: [] },
      // T1's completion-only EXTERNAL_DEFERRED acceptance stays outside this execution test.
      packet: { ...packet, deferVerification: true } })
    assert.deepEqual(report.blockers, [])
    assert.deepEqual(report.changedFiles, ['server/domain.js'])
    assert.equal(report.workspaceExecution?.outcome, 'IMPLEMENTED')
    assert.match(await readFile(join(root, 'server/domain.js'), 'utf8'), /ready: true/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('production V2 propagates actual MCP mutation refusals into blockers and a structured failure event', async () => {
  const root = await codexTestRepo()
  const data = await mkdtemp(join(tmpdir(), 'nw-scope-result-production-'))
  let runtime: WorkSessionRuntimeConfig | undefined
  let app: Awaited<ReturnType<typeof createProductionWorkSessionUi>> | undefined
  let diagnoses = 0
  try {
    const config = await validateTrustedWorkSessionConfig({
      session: { id: 'scope-result-fixture', targetRepo: root, branch: 'main', controlPlane: 'v2',
        limits: { softMinutes: 1, hardMinutes: 2, maxTasks: 1 } },
      tasks: [{ id: 'T1', goal: 'Scoped implementation', executorMode: 'codex', guardian: {
        constraints: [], acceptanceCriteria: ['verified'], doNotDo: [], allowedPaths: [await realpath(root)], forbiddenPaths: ['src/private/**'] },
        acceptanceEvidenceBindings: [{ criterion: 'verified', requiredEvidence: ['git diff --check'] }] }],
      executor: { model: 'fixture', maxTurns: 2, allowNpmInstall: false, allowPythonBootstrap: false },
      gitCheckpoint: { autoCommit: false, autoPush: false }, storageUrl: pathToFileURL(join(data, 'session.db')).href,
    })
    const codex = executor(root, async client => {
      await client.callTool({ name: 'git_status', arguments: {} })
      for (let i = 0; i < 12; i++) await client.callTool({ name: 'write_file', arguments: { path: 'src/private/denied.ts', content: 'denied' } })
    })
    app = await createProductionWorkSessionUi(config, {
      env: { ...process.env, NOVAWING_DATA_DIR: data },
      createRuntime(input) { runtime = input; return new FakeRuntime(input.definition) },
      // SDK startup is already independently covered; run the real workspace executor here.
      createCodexExecutor: () => ({ execute: input => codex.execute(input) }),
      autonomousRecovery: { inspectDiff: async () => '', async diagnose() { diagnoses++; throw new Error('permission denial must never start autonomous diagnosis') } },
    })
    const log = new TaskEventLogV2()
    const result = await runtime!.taskRunner.run(app.definition.tasks[0]!, undefined, undefined, { taskEventLog: log })
    assert.equal(result.status, 'HUMAN_REQUIRED')
    assert.equal(result.humanRequired?.category, 'SAFETY_BLOCKED')
    assert.equal(diagnoses, 0)
    assert.equal(result.taskStateV2?.blockers.length, 12)
    assert.ok(result.taskStateV2?.blockers.every(blocker => blocker.startsWith('EXECUTION_BLOCKED:')))
    assert.equal(log.count('AGENT_COMPLETED'), 0)
    assert.equal(log.count('AGENT_FAILED'), 1)
    const recorded = log.last('AGENT_FAILED')?.metadata?.workspaceExecution as { outcome: string; mutationFailures: unknown[] }
    assert.equal(recorded.outcome, 'EXECUTION_BLOCKED')
    assert.equal(recorded.mutationFailures.length, 12)
  } finally {
    await app?.close()
    await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true })
  }
})

test('controller scope guard accepts legacy absolute permission after implementation and retains forbiddens', async () => {
  const root = await codexTestRepo()
  try {
    const canonical = await realpath(root)
    const legacy = { ...task, allowedPaths: [canonical], forbiddenPaths: [join(canonical, 'src/private')] }
    assert.deepEqual(scopeBlockers(legacy, ['server/domain.js'], canonical), [])
    assert.equal(scopeBlockers(legacy, ['src/private/no.ts'], canonical).length, 1)
    assert.equal(scopeBlockers({ ...legacy, allowedPaths: [join(canonical, '..', 'outside')] }, ['server/domain.js'], canonical).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a mutation-only rejected turn is blocked, not classified for no-op retry', async () => {
  const root = await codexTestRepo()
  try {
    const codex = executor(root, async client => {
      assert.equal((await client.callTool({ name: 'write_file', arguments: { path: '../escape', content: 'denied' } })).isError, true)
    })
    const report = await codex.execute({ task, packet })
    assert.equal(report.workspaceExecution?.outcome, 'EXECUTION_BLOCKED')
    assert.equal(report.blockers.length, 1)
    assert.match(report.blockers[0]!, /^EXECUTION_BLOCKED:/u)
    assert.notEqual(codex.lastError?.kind, 'no_op_execution')
  } finally { await rm(root, { recursive: true, force: true }) }
})
