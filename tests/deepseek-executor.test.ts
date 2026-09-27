import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hasClaudeRoute, hasDeepSeekRoute } from '../packages/development-guardian/deepseek-executor.js'
import { DeepSeekExecutor } from '../packages/development-guardian/deepseek-executor.js'
import type { GuardianCommandRequest, GuardianCommandResult } from '../packages/development-guardian/claude-code-executor.js'

test('existing DeepSeek route gate rejects other providers and keeps credentials out of its result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-deepseek-config-'))
  try {
    const env = { CLAUDE_CONFIG_DIR: root, ANTHROPIC_BASE_URL: 'https://api.deepseek.com', ANTHROPIC_AUTH_TOKEN: 'fixture-not-a-secret' }
    assert.equal(await hasDeepSeekRoute(root, env), true)
    assert.equal(await hasDeepSeekRoute(root, { ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), false)
    assert.equal(await hasDeepSeekRoute(root, { ...env, ANTHROPIC_AUTH_TOKEN: '' }), false)
    assert.equal(await hasDeepSeekRoute(root, { ...env, CLAUDE_CODE_USE_BEDROCK: '1' }), false)
    await mkdir(join(root, '.claude'))
    await writeFile(join(root, '.claude/settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://other.invalid' } }))
    assert.equal(await hasDeepSeekRoute(root, env), false, 'project routing overrides cannot silently choose another provider')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Claude route requires a Claude model, credentials and an independent endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-claude-config-'))
  try {
    const env = { CLAUDE_CONFIG_DIR: root, ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'fixture-not-a-secret', ANTHROPIC_MODEL: 'claude-opus-5-5' }
    assert.equal(await hasClaudeRoute(root, env), true)
    assert.equal(await hasClaudeRoute(root, { ...env, ANTHROPIC_BASE_URL: 'https://api.deepseek.com' }), false)
    assert.equal(await hasClaudeRoute(root, { ...env, ANTHROPIC_MODEL: 'sonnet' }), false)
    assert.equal(await hasClaudeRoute(root, { ...env, ANTHROPIC_AUTH_TOKEN: '' }), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('large DeepSeek handoff launches through stdin and deterministic verification still runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novawing-deepseek-large-handoff-'))
  const requests: GuardianCommandRequest[] = []
  const queue: GuardianCommandResult[] = [
    { exitCode: 0, signal: null, stdout: '', stderr: '' },
    { exitCode: 0, signal: null, stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'continued', session_id: 'deepseek-session' }), stderr: '' },
    { exitCode: 0, signal: null, stdout: ' M src/a.ts\n', stderr: '' },
    { exitCode: 0, signal: null, stdout: '', stderr: '' },
    { exitCode: 0, signal: null, stdout: 'tests passed', stderr: '' },
  ]
  try {
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, '.claude', 'settings.local.json'), JSON.stringify({ env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com', ANTHROPIC_AUTH_TOKEN: 'test-fixture-token',
    } }))
    const handoff = `ExecutorHandoffContext:${'h'.repeat(70_000)}`
    const executor = new DeepSeekExecutor({ cwd: root, additionalExecutionContext: handoff,
      commandRunner: async (request) => { requests.push(request); return queue.shift()! } })
    const task = { id: 'T031', goal: 'continue inherited diff', state: 'EXECUTING' as const, iteration: 1, maxIterations: 3 }
    const packet = { verdict: 'proceed' as const, goal: task.goal, instructions: ['inspect git diff first'],
      constraints: [], verification: ['npm test'], doNotDo: ['do not reset'] }

    const report = await executor.execute({ task, packet })
    const provider = requests[1]!
    assert.ok(provider.stdinText?.includes(handoff))
    assert.equal(provider.args.some(arg => arg.includes(handoff)), false)
    assert.deepEqual(report.verificationResults.map(result => [result.name, result.status]),
      [['git diff --check', 'passed'], ['npm test', 'passed']])
  } finally { await rm(root, { recursive: true, force: true }) }
})
