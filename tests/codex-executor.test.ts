import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm, link, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { codexTestRepo } from './codex-test-fixture.js'
import type { Thread, ThreadEvent, CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import { CodexExecutor, codexEffectiveConfiguration, codexChatGptEnvironment } from '../packages/development-guardian/codex-executor.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import { CodexWorkspaceTools } from '../packages/development-guardian/codex-workspace-tools.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { DelegationPacket, GuardianTask } from '../packages/development-guardian/model.js'

const task: GuardianTask = { id: 'T1', goal: 'Implement scoped change', state: 'READY', iteration: 0, maxIterations: 3,
  allowedPaths: ['src/**'], forbiddenPaths: ['src/private/**'], constraints: ['Keep API compatible'], acceptanceCriteria: ['Pass tests'], doNotDo: ['No dependencies'] }
const packet: DelegationPacket = { goal: task.goal, verdict: 'proceed', instructions: ['Edit src/a.ts'], constraints: [], doNotDo: [], verification: [] }

test('Codex classifier prioritizes structured causes; ordinary 429, auth and model errors never become quota', () => {
  for (const [error, kind] of [
    [{ code: 'usage_limit_reached' }, 'quota_exhausted'],
    [{ error: { code: 'quota_exhausted', metadata: { retry_after: 60 } } }, 'quota_exhausted'],
    [{ status: 429 }, 'transient'], [{ status: 401, message: "You've hit your usage limit" }, 'auth_required'],
    [{ code: 'model_not_found' }, 'model_unavailable'], [{ code: 'configuration_error' }, 'configuration_error'],
    [new Error("You've hit your usage limit. Try again later."), 'quota_exhausted'],
    [new Error('stream disconnected'), 'transient'], [new Error('something else'), 'unknown'],
  ] as const) assert.equal(classifyCodexError(error).kind, kind)
  assert.equal(classifyCodexError({ code: 'quota_exhausted', metadata: { retry_after: 60 } }, 0).blockedUntil, '1970-01-01T00:01:00.000Z')
  assert.equal(classifyCodexError({ code: 'quota_exhausted' }, 0).blockedUntil, undefined)
  assert.equal(classifyCodexError(new Error('secret=DO_NOT_LOG')).message.includes('DO_NOT_LOG'), false)
})

test('effective SDK configuration pins Sol medium, ChatGPT auth and no ambient API billing or expanded native tools', () => {
  const { runtime, thread } = codexEffectiveConfiguration({ cwd: 'D:/repo', env: {
    PATH: 'safe', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'app',
  } }, 'codex.exe', 'http://127.0.0.1:1234/scoped', ['external-tool'])
  assert.equal(thread.model, 'gpt-5.6-sol')
  assert.equal(thread.modelReasoningEffort, 'medium')
  assert.equal(thread.sandboxMode, 'read-only')
  assert.equal(thread.approvalPolicy, 'never')
  assert.equal(thread.networkAccessEnabled, false)
  assert.deepEqual(thread.additionalDirectories, [])
  assert.deepEqual(runtime.env, { PATH: 'safe' })
  assert.equal(runtime.apiKey, undefined)
  assert.equal(runtime.config?.forced_login_method, 'chatgpt')
  assert.equal(runtime.config?.model_provider, 'openai')
  assert.ok(runtime.configOverrides?.includes('mcp_servers.external-tool.enabled=false'))
  assert.match(runtime.configOverrides!.at(-1)!, /default_tools_approval_mode="approve"/u)
  assert.throws(() => codexEffectiveConfiguration({ cwd: 'D:/repo' }, 'codex.exe', 'http://127.0.0.1:1', ['unsafe.name']))
  assert.deepEqual(codexChatGptEnvironment({ openai_api_key: 'secret', Home: 'profile' }), { Home: 'profile' })
})

test('scoped workspace tools reject escapes, forbidden paths, linked files and post-revocation writes', async () => {
  const root = await codexTestRepo()
  try {
    const tools = await CodexWorkspaceTools.create(root, task)
    if (process.platform === 'win32') await assert.rejects(tools.call('write_file', { path: 'SRC/PRIVATE/a.ts', content: 'bad' }))
    await link(join(root, 'src/a.ts'), join(root, 'src/linked.ts'))
    await assert.rejects(tools.call('write_file', { path: 'src/linked.ts', content: 'bad' }))
    await rm(join(root, 'src/linked.ts'))
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'src/junction'), 'junction')
    await assert.rejects(tools.call('write_file', { path: 'src/junction/escape.ts', content: 'bad' }))
    for (const path of ['../outside', 'D:/outside', 'src/private/a.ts', '.git/config', '.codex/config.toml', 'src/NUL', 'src/a.ts.']) {
      await assert.rejects(tools.call('write_file', { path, content: 'bad' }))
    }
    await tools.call('write_file', { path: 'src/a.ts', content: 'export const value = 2\n' })
    assert.match(await tools.call('git_status', {}), /src\/a.ts/)
    assert.match(await tools.call('read_file', { path: 'src/a.ts' }), /value = 2/)
    await tools.revoke()
    await assert.rejects(tools.call('write_file', { path: 'src/a.ts', content: 'bad' }))
    assert.match(await readFile(join(root, 'src/a.ts'), 'utf8'), /value = 2/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('SDK quota event is drained to EOF and workspace capability is revoked before execute settles', async () => {
  const root = await codexTestRepo()
  let finish!: () => void
  let started!: () => void
  let url = ''
  const entered = new Promise<void>(resolve => { started = resolve })
  const barrier = new Promise<void>(resolve => { finish = resolve })
  let settled = false
  const executor = new CodexExecutor({ cwd: root, preflight: async () => ({ executable: 'fake', mcpNames: [] }),
    createCodex: (options) => {
      url = /url="([^"]+)"/u.exec(options.configOverrides!.at(-1)!)![1]!
      const thread = { runStreamed: async () => ({ events: (async function* () {
        yield { type: 'turn.failed', error: { message: "You've hit your usage limit." } }
        started()
        await barrier
      })() }) } as unknown as Thread
      return { startThread: () => thread, resumeThread: () => thread }
    } })
  try {
    const running = executor.execute({ task, packet }).then(report => { settled = true; return report })
    await entered
    assert.equal(settled, false)
    finish()
    const report = await running
    assert.equal(executor.lastError?.kind, 'quota_exhausted')
    assert.equal(report.blockers.length, 1)
    await assert.rejects(fetch(url, { method: 'POST', body: '{}' }))
  } finally { finish(); await rm(root, { recursive: true, force: true }) }
})

test('real MCP transport exposes only scoped file tools and closes write ownership', async () => {
  const root = await codexTestRepo()
  const tools = await CodexWorkspaceTools.create(root, task)
  const bridge = await tools.listen()
  const client = new Client({ name: 'test', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url)) as Parameters<Client['connect']>[0])
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), ['delete_file', 'git_diff_summary', 'git_status', 'list_files', 'read_file', 'write_file'])
    const result = await client.callTool({ name: 'write_file', arguments: { path: 'src/a.ts', content: 'export const value = 3\n' } })
    assert.notEqual(result.isError, true)
    assert.match(await readFile(join(root, 'src/a.ts'), 'utf8'), /value = 3/)
    const denied = await client.callTool({ name: 'write_file', arguments: { path: '../bad', content: 'no' } })
    assert.equal(denied.isError, true)
  } finally { await client.close(); await bridge.close(); await rm(root, { recursive: true, force: true }) }
})

test('CodexExecutor passes effective SDK options, persists/resumes thread and ignores claimed verification', async () => {
  const root = await codexTestRepo()
  const runtimes: CodexOptions[] = []
  const threads: ThreadOptions[] = []
  const resumes: string[] = []
  const captured: string[] = []
  function fakeThread(runtime: CodexOptions): Thread {
    return { runStreamed: async () => ({ events: (async function* () {
      const url = /url="([^"]+)"/u.exec(runtime.configOverrides!.at(-1)!)![1]!
      const client = new Client({ name: 'fake-sdk', version: '1' })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Parameters<Client['connect']>[0])
        await client.callTool({ name: 'git_status', arguments: {} })
      } finally { await client.close() }
      yield { type: 'thread.started', thread_id: 'thread-1' } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'PRIVATE_NOT_FOR_HANDOFF' } } as ThreadEvent
      yield { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'I claim all tests pass.' } } as ThreadEvent
      yield { type: 'turn.completed', usage: {} } as ThreadEvent
    })() }) } as unknown as Thread
  }
  const options = {
    cwd: root, preflight: async () => ({ executable: 'fake.exe', mcpNames: [] }),
    onThread: (id: string) => { captured.push(id) },
    createCodex: (runtime: CodexOptions) => {
      runtimes.push(runtime)
      return { startThread: (thread?: ThreadOptions) => { threads.push(thread!); return fakeThread(runtime) },
        resumeThread: (id: string, thread?: ThreadOptions) => { resumes.push(id); threads.push(thread!); return fakeThread(runtime) } }
    },
  }
  try {
    const executor = new CodexExecutor(options)
    const result = await executor.execute({ task, packet })
    assert.equal(result.blockers.length, 0)
    assert.deepEqual(result.executorCapabilities, ['list_files', 'read_file', 'write_file', 'delete_file', 'git_status', 'git_diff_summary'])
    assert.deepEqual(result.verificationResults.map((v) => v.name), ['git diff --check'])
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NOT_FOR_HANDOFF/)
    await executor.execute({ task, packet })
    const resumed = new CodexExecutor(options)
    resumed.restoreProviderState(executor.captureProviderState())
    await resumed.execute({ task, packet })
    assert.deepEqual(resumes, ['thread-1', 'thread-1'])
    assert.equal(captured.length, 3)
    assert.equal(threads[0]?.model, 'gpt-5.6-sol')
    assert.equal(threads[0]?.modelReasoningEffort, 'medium')
    assert.equal(runtimes[0]?.apiKey, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
