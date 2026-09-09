import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm, link, symlink, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexTestRepo } from './codex-test-fixture.js'
import type { Thread, ThreadEvent, CodexOptions, ThreadOptions } from '@openai/codex-sdk'
import {
  CodexExecutor,
  CodexSdkPreflightError,
  DEFAULT_CODEX_WSL_DISTRO,
  WINDOWS_WSL_EXECUTABLE,
  codexEffectiveConfiguration,
  codexChatGptEnvironment,
  inspectCodexDevelopmentRuntime,
  inspectCodexLocal,
} from '../packages/development-guardian/codex-executor.js'
import { classifyCodexError } from '../packages/development-guardian/codex-error.js'
import { CodexWorkspaceTools } from '../packages/development-guardian/codex-workspace-tools.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { DelegationPacket, GuardianTask } from '../packages/development-guardian/model.js'

const task: GuardianTask = { id: 'T1', goal: 'Implement scoped change', state: 'READY', iteration: 0, maxIterations: 3,
  allowedPaths: ['src/**'], forbiddenPaths: ['src/private/**'], constraints: ['Keep API compatible'], acceptanceCriteria: ['Pass tests'], doNotDo: ['No dependencies'] }
const packet: DelegationPacket = { goal: task.goal, verdict: 'proceed', instructions: ['Edit src/a.ts'], constraints: [], doNotDo: [], verification: [] }

function executorWithWorkspaceProbe(root: string, probe: (client: Client) => Promise<void>): CodexExecutor {
  let runtime: CodexOptions | undefined
  return new CodexExecutor({ cwd: root, preflight: async () => ({ executable: 'fake.exe', mcpNames: [] }),
    createCodex: (options) => {
      runtime = options
      const thread = { runStreamed: async () => ({ events: (async function* () {
        const url = /url="([^"]+)"/u.exec(runtime!.configOverrides!.at(-1)!)![1]!
        const client = new Client({ name: 'preflight-diagnostic', version: '1' })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Parameters<Client['connect']>[0])
          await probe(client)
        } finally { await client.close() }
        yield { type: 'turn.completed', usage: {} } as ThreadEvent
      })() }) } as unknown as Thread
      return { startThread: () => thread, resumeThread: () => thread }
    } })
}

test('Codex classifier prioritizes structured causes; ordinary 429, auth and model errors never become quota', () => {
  for (const [error, kind] of [
    [{ code: 'usage_limit_reached' }, 'quota_exhausted'],
    [{ error: { code: 'quota_exhausted', metadata: { retry_after: 60 } } }, 'quota_exhausted'],
    [{ status: 429 }, 'transient'], [{ status: 401, message: "You've hit your usage limit" }, 'auth_required'],
    [{ code: 'model_not_found' }, 'model_unavailable'], [{ code: 'configuration_error' }, 'configuration_error'],
    [{ code: 'no_op_execution' }, 'no_op_execution'],
    [new Error("You've hit your usage limit. Try again later."), 'quota_exhausted'],
    [{ code: 'ENAMETOOLONG' }, 'transient'], [new Error('spawn ENAMETOOLONG'), 'transient'],
    [new Error('stream disconnected'), 'transient'], [new Error('something else'), 'unknown'],
  ] as const) assert.equal(classifyCodexError(error).kind, kind)
  assert.equal(classifyCodexError({ code: 'quota_exhausted', metadata: { retry_after: 60 } }, 0).blockedUntil, '1970-01-01T00:01:00.000Z')
  assert.equal(classifyCodexError({ code: 'quota_exhausted' }, 0).blockedUntil, undefined)
  assert.equal(classifyCodexError(new Error('secret=DO_NOT_LOG')).message.includes('DO_NOT_LOG'), false)
})

test('Codex WSL preflight explicitly selects Ubuntu and proves bash, cwd and Git inspection', async () => {
  const requests: { executable: string; args: readonly string[]; timeoutMs: number }[] = []
  const result = await inspectCodexDevelopmentRuntime({ platform: 'win32', cwd: 'D:\\VSCode\\fly-weave',
    commandRunner: async (request) => {
      requests.push(request)
      return { exitCode: 0, stdout: 'NOVAWING_CODEX_PREFLIGHT|/usr/bin/bash|/mnt/d/VSCode/fly-weave', stderr: '' }
    } })
  assert.deepEqual(result, { distro: DEFAULT_CODEX_WSL_DISTRO, workspace: '/mnt/d/VSCode/fly-weave', bash: '/usr/bin/bash' })
  assert.equal(requests[0]?.executable, WINDOWS_WSL_EXECUTABLE)
  assert.deepEqual(requests[0]?.args.slice(0, 7), ['-d', 'Ubuntu-24.04', '--cd', '/mnt/d/VSCode/fly-weave', '--exec', '/usr/bin/bash', '-lc'])
})

test('Codex WSL preflight rejects docker-desktop and bash/Git inspection failures', async () => {
  await assert.rejects(inspectCodexDevelopmentRuntime({ platform: 'win32', cwd: 'D:\\repo', distro: 'docker-desktop' }),
    /No supported development WSL distribution/u)
  for (const result of [
    { exitCode: 1, stdout: '', stderr: 'bash unavailable' },
    { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository' },
    { exitCode: 1, stdout: '', stderr: '', timedOut: true },
  ]) {
    await assert.rejects(inspectCodexDevelopmentRuntime({ platform: 'win32', cwd: 'D:\\repo',
      commandRunner: async () => result }), /workspace, bash, or Git inspection is unavailable/u)
  }
})

test('effective SDK configuration defaults to Terra high, ChatGPT auth and no ambient API billing or expanded native tools', () => {
  const { runtime, thread } = codexEffectiveConfiguration({ cwd: 'D:/repo', env: {
    PATH: 'safe', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_ACCESS_TOKEN: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'app',
  } }, 'codex.exe', 'http://127.0.0.1:1234/scoped', ['external-tool'])
  assert.equal(thread.model, 'gpt-5.6-terra')
  assert.equal(thread.modelReasoningEffort, 'high')
  assert.equal(thread.sandboxMode, 'read-only')
  assert.equal(thread.approvalPolicy, 'never')
  assert.equal(thread.networkAccessEnabled, false)
  assert.deepEqual(thread.additionalDirectories, [])
  assert.deepEqual(runtime.env, { PATH: 'safe' })
  assert.equal(runtime.apiKey, undefined)
  assert.equal(runtime.config?.forced_login_method, 'chatgpt')
  assert.equal(runtime.config?.model_provider, 'openai')
  assert.equal(runtime.configOverrides?.length, 1)
  assert.match(runtime.configOverrides![0]!, /^mcp_servers=\{novawing_workspace=\{/u)
  assert.doesNotMatch(runtime.configOverrides![0]!, /external-tool/u)
  assert.match(runtime.configOverrides!.at(-1)!, /default_tools_approval_mode="approve"/u)
  assert.deepEqual(codexChatGptEnvironment({ openai_api_key: 'secret', Home: 'profile' }), { Home: 'profile' })
})

test('SDK runtime discovery does not require a system codex command', async () => {
  const runtime = await inspectCodexLocal({ PATH: 'C:\\system-without-codex' }, process.cwd())
  assert.match(runtime.executable, /@openai[\\/]codex-win32-/u)
  assert.deepEqual(runtime.mcpNames, [])
})

test('scoped workspace tools reject escapes, forbidden paths, linked files and post-revocation writes', async () => {
  const root = await codexTestRepo()
  const junction = join(root, 'src/junction')
  try {
    const tools = await CodexWorkspaceTools.create(root, task)
    if (process.platform === 'win32') await assert.rejects(tools.call('write_file', { path: 'SRC/PRIVATE/a.ts', content: 'bad' }))
    await link(join(root, 'src/a.ts'), join(root, 'src/linked.ts'))
    await assert.rejects(tools.call('write_file', { path: 'src/linked.ts', content: 'bad' }))
    await rm(join(root, 'src/linked.ts'))
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), junction, 'junction')
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
  } finally {
    // Windows recursive removal is intermittent when the fixture junction remains nested.
    // Remove that owned test artifact first; any cleanup error still fails the test.
    await rm(junction, { force: true })
    await rm(root, { recursive: true, force: true })
  }
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

test('Codex preflight performs a real read-only git/list/package tool probe on a normal Windows workspace path', async () => {
  const root = await codexTestRepo()
  let runtime: CodexOptions | undefined
  const executor = new CodexExecutor({ cwd: root, preflight: async () => ({ executable: 'fake.exe', mcpNames: [] }),
    createCodex: (options) => {
      runtime = options
      const thread = { runStreamed: async () => ({ events: (async function* () {
        const url = /url="([^"]+)"/u.exec(runtime!.configOverrides!.at(-1)!)![1]!
        const client = new Client({ name: 'preflight-sdk', version: '1' })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Parameters<Client['connect']>[0])
          await client.callTool({ name: 'git_status', arguments: {} })
          await client.callTool({ name: 'list_files', arguments: {} })
          await client.callTool({ name: 'read_file', arguments: { path: 'package.json' } })
        } finally { await client.close() }
        yield { type: 'turn.completed', usage: {} } as ThreadEvent
      })() }) } as unknown as Thread
      return { startThread: () => thread, resumeThread: () => thread }
    } })
  try {
    if (process.platform === 'win32') assert.match(root, /^[A-Za-z]:\\/u)
    await executor.preflight(task)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex preflight retains the exact Git, list, and read workspace probe failure', async () => {
  const root = await codexTestRepo()
  try {
    for (const [stage, invoke] of [
      ['list', (client: Client) => client.callTool({ name: 'list_files', arguments: { path: 'missing' } }).then(() => undefined)],
      ['read', (client: Client) => client.callTool({ name: 'read_file', arguments: { path: 'missing.json' } }).then(() => undefined)],
    ] as const) {
      await assert.rejects(executorWithWorkspaceProbe(root, invoke).preflight(task), (error: unknown) =>
        error instanceof CodexSdkPreflightError && error.stage === stage &&
        error.safeMessage.startsWith(`workspace ${stage} preflight failed:`))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex preflight retains the exact Git probe failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-codex-no-git-'))
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n')
  try {
    await assert.rejects(executorWithWorkspaceProbe(root, (client) =>
      client.callTool({ name: 'git_status', arguments: {} }).then(() => undefined)).preflight(task), (error: unknown) =>
      error instanceof CodexSdkPreflightError && error.stage === 'git' &&
      error.safeMessage === 'workspace Git preflight failed: Workspace git inspection failed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex preflight distinguishes MCP initialization, SDK runtime, and timeout failures', async () => {
  const root = await codexTestRepo()
  try {
    await assert.rejects(new CodexExecutor({ cwd: root, preflight: async () => ({ executable: 'fake.exe', mcpNames: [] }),
      listenWorkspace: async () => { throw new Error('listen EADDRINUSE') } }).preflight(task), (error: unknown) =>
      error instanceof CodexSdkPreflightError && error.stage === 'workspace_mcp_initialization' &&
      error.safeMessage === 'workspace MCP initialization preflight failed: listen EADDRINUSE')
    await assert.rejects(new CodexExecutor({ cwd: root, preflight: async () => { throw new Error('token=abc123') } }).preflight(task),
      (error: unknown) => error instanceof CodexSdkPreflightError && error.stage === 'sdk_runtime' &&
        error.safeMessage === 'Codex SDK runtime preflight failed: token= [redacted]')
    const timeout = new CodexExecutor({ cwd: root, preflightTimeoutMs: 1,
      preflight: async () => ({ executable: 'fake.exe', mcpNames: [] }),
      createCodex: () => {
        const thread = { runStreamed: async (_prompt: string, options: { signal?: AbortSignal }) => ({ events: (async function* () {
          await new Promise<void>((resolveAbort) => options.signal?.addEventListener('abort', () => resolveAbort(), { once: true }))
          throw new Error('aborted')
        })() }) } as unknown as Thread
        return { startThread: () => thread, resumeThread: () => thread }
      } })
    await assert.rejects(timeout.preflight(task), (error: unknown) =>
      error instanceof CodexSdkPreflightError && error.stage === 'timeout' &&
      error.safeMessage === 'workspace preflight timed out after 1 ms')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex preflight identifies a Windows SDK network transport denial before workspace tools run', async () => {
  const root = await codexTestRepo()
  try {
    const executor = new CodexExecutor({ cwd: root, preflight: async () => ({ executable: 'fake.exe', mcpNames: [] }),
      createCodex: () => {
        const thread = { runStreamed: async () => ({ events: (async function* () {
          yield { type: 'error', message: 'stream disconnected: socket access denied (os error 10013)' } as ThreadEvent
        })() }) } as unknown as Thread
        return { startThread: () => thread, resumeThread: () => thread }
      } })
    await assert.rejects(executor.preflight(task), (error: unknown) =>
      error instanceof CodexSdkPreflightError && error.stage === 'sdk_network' &&
      error.safeMessage === 'Codex SDK network transport preflight failed: stream disconnected: socket access denied (os error 10013)' &&
      error.results.length === 0 &&
      JSON.stringify(error.steps) === JSON.stringify([
        { stage: 'sdk_runtime', status: 'passed' },
        { stage: 'workspace_root', status: 'passed' },
        { stage: 'workspace_mcp_initialization', status: 'passed' },
        { stage: 'sdk_network', status: 'failed', reason: 'Codex SDK network transport preflight failed: stream disconnected: socket access denied (os error 10013)' },
      ]))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex SDK preflight identifies the failed dependency without a system codex command', async () => {
  const root = await codexTestRepo()
  let runtime: CodexOptions | undefined
  const passing = new CodexExecutor({ cwd: root, env: { PATH: 'C:\\system-without-codex' },
    preflight: async () => ({ executable: 'sdk-bundled.exe', mcpNames: [] }),
    createCodex: (options) => {
      runtime = options
      const thread = { runStreamed: async () => ({ events: (async function* () {
        const url = /url="([^"]+)"/u.exec(runtime!.configOverrides!.at(-1)!)![1]!
        const client = new Client({ name: 'sdk-no-system-cli', version: '1' })
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Parameters<Client['connect']>[0])
          await client.callTool({ name: 'git_status', arguments: {} })
          await client.callTool({ name: 'list_files', arguments: {} })
          await client.callTool({ name: 'read_file', arguments: { path: 'package.json' } })
        } finally { await client.close() }
        yield { type: 'turn.completed', usage: {} } as ThreadEvent
      })() }) } as unknown as Thread
      return { startThread: () => thread, resumeThread: () => thread }
    } })
  const missingWorkspace = new CodexExecutor({ cwd: join(root, 'missing-workspace'),
    preflight: async () => ({ executable: 'sdk-bundled.exe', mcpNames: [] }) })
  try {
    await passing.preflight(task)
    await assert.rejects(missingWorkspace.preflight(task), (error: unknown) =>
      error instanceof CodexSdkPreflightError && error.stage === 'workspace_root')
  } finally { await rm(root, { recursive: true, force: true }) }
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
    assert.equal(threads[0]?.model, 'gpt-5.6-terra')
    assert.equal(threads[0]?.modelReasoningEffort, 'high')
    assert.equal(runtimes[0]?.apiKey, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})
