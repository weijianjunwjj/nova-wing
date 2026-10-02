import { spawn } from 'node:child_process'
import { resolveClaudeProviderEnvironment } from './deepseek-executor.js'
import { guardianShellCommand } from './shell-contract.js'
import { commandEnvironment } from './platform/environment.js'

export type AdvisoryRole = 'AUDITOR' | 'ADJUDICATOR'
export interface AdvisoryResponse { text: string; provider: string; model: string }
export type AdvisoryRunner = (prompt: string) => Promise<AdvisoryResponse>

/** Separate role routes; credentials are resolved in memory and never returned. */
export function createAdvisoryRunner(role: AdvisoryRole, options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number
} = {}): AdvisoryRunner {
  return async (prompt) => {
    if (Buffer.byteLength(prompt, 'utf8') > 512_000) throw new Error('Advisory packet exceeds the bounded input limit.')
    const cwd = options.cwd ?? process.cwd()
    const supplied = options.env ?? process.env
    const env = await resolveClaudeProviderEnvironment(cwd, supplied)
    const prefix = `NOVAWING_${role}_`
    if (supplied[prefix + 'BASE_URL'] && supplied[prefix + 'BASE_URL'] !== env.ANTHROPIC_BASE_URL &&
      !supplied[prefix + 'API_KEY'] && !supplied[prefix + 'AUTH_TOKEN']) {
      throw new Error('A separate provider endpoint requires its own role credential.')
    }
    for (const [suffix, target] of Object.entries({ BASE_URL: 'ANTHROPIC_BASE_URL', API_KEY: 'ANTHROPIC_API_KEY', AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN', MODEL: 'ANTHROPIC_MODEL' })) {
      const value = supplied[prefix + suffix]
      if (value !== undefined) env[target] = value
    }
    // An alternate key must not compete with an inherited credential of another route.
    if (supplied[prefix + 'API_KEY']) delete env.ANTHROPIC_AUTH_TOKEN
    if (supplied[prefix + 'AUTH_TOKEN']) delete env.ANTHROPIC_API_KEY
    const model = role === 'AUDITOR' ? supplied[prefix + 'MODEL'] ?? 'sonnet' : supplied[prefix + 'MODEL']
    if (!model?.trim() || (role === 'ADJUDICATOR' && !/^claude-[A-Za-z0-9-]+$/u.test(model))) {
      throw new Error('An explicit adjudicator model route is required.')
    }
    const endpoint = new URL(env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')
    const credentials = Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim())
    const cloudRoute = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((key) => env[key] === '1')
    if (!credentials || cloudRoute || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      (role === 'AUDITOR' ? endpoint.hostname !== 'api.deepseek.com' : endpoint.hostname === 'api.deepseek.com')) {
      throw new Error(`${role} independent route is unavailable; no provider fallback is permitted.`)
    }
    const spec = guardianShellCommand('exec claude "$@"', { env })
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 1_000), 120_000)
    const args = ['--bare', '--print', '--output-format', 'json', '--tools', '', '--disallowedTools', '*', '--max-turns', '1',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--disable-slash-commands', '--model', model]
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(spec.executable, [...spec.args, '--', ...args], {
        cwd, env: commandEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      })
      let stdout = ''; let outputBytes = 0; let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true; clearTimeout(timer)
        error ? reject(error) : resolve(stdout)
      }
      const timer = setTimeout(() => { child.kill(); finish(new Error('Advisory model timed out.')) }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk); stdout += chunk
        if (outputBytes > 128_000) { child.kill(); finish(new Error('Advisory output limit exceeded.')) }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > 128_000) { child.kill(); finish(new Error('Advisory output limit exceeded.')) }
      })
      child.on('error', () => finish(new Error('Advisory CLI unavailable.')))
      child.stdin.on('error', () => finish(new Error('Advisory input failed.')))
      child.on('close', (code) => finish(code === 0 ? undefined : new Error('Advisory CLI failed.')))
      child.stdin.end(prompt)
    })
    const envelope = JSON.parse(text) as { result?: unknown; is_error?: unknown; permission_denials?: unknown }
    if (envelope.is_error || typeof envelope.result !== 'string' ||
      (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length)) {
      throw new Error('Advisory CLI protocol failed.')
    }
    return { text: envelope.result, provider: role === 'AUDITOR' ? 'deepseek' : 'claude-configured-route', model }
  }
}
