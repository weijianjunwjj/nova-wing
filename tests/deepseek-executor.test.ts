import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hasDeepSeekRoute } from '../packages/development-guardian/deepseek-executor.js'

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
