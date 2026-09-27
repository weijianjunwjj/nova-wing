import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeCodeExecutor, type ClaudeCodeExecutorOptions } from './claude-code-executor.js'
import type { DelegationPacket, ExecutionReport, GuardianTask } from './model.js'

/** Existing Claude CLI adapter with a provider identity gate; no new DeepSeek agent loop. */
export class DeepSeekExecutor extends ClaudeCodeExecutor {
  constructor(private readonly deepSeekOptions: ClaudeCodeExecutorOptions) { super(deepSeekOptions) }

  override async execute(input: { task: GuardianTask; packet: DelegationPacket }): Promise<ExecutionReport> {
    if (!await hasDeepSeekRoute(this.deepSeekOptions.cwd)) {
      return { summary: 'DeepSeek executor configuration required', changedFiles: [], commandsRun: [], verificationResults: [],
        blockers: ['Executor Provider must be configured for DeepSeek in the existing local Claude CLI; NovaWing will not silently use another provider.'] }
    }
    return super.execute(input)
  }
}

/** Read only relevant config in memory. Never return or log secret values. */
export async function hasDeepSeekRoute(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const effective = await resolveClaudeProviderEnvironment(cwd, env)
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((key) => effective[key] === '1')) return false
    const endpoint = new URL(effective.ANTHROPIC_BASE_URL ?? '')
    return endpoint.protocol === 'https:' && endpoint.hostname === 'api.deepseek.com' &&
      endpoint.username === '' && endpoint.password === '' && (endpoint.port === '' || endpoint.port === '443') &&
      Boolean(effective.ANTHROPIC_AUTH_TOKEN?.trim() || effective.ANTHROPIC_API_KEY?.trim())
  } catch { return false }
}

/** A Claude CLI route is independent of Codex only when it names a Claude model and has credentials. */
export async function hasClaudeRoute(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const effective = await resolveClaudeProviderEnvironment(cwd, env)
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((key) => effective[key] === '1')) return false
    const endpoint = new URL(effective.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')
    return endpoint.protocol === 'https:' && endpoint.hostname !== 'api.deepseek.com' &&
      endpoint.username === '' && endpoint.password === '' &&
      Boolean(effective.ANTHROPIC_AUTH_TOKEN?.trim() || effective.ANTHROPIC_API_KEY?.trim()) &&
      /^claude-[A-Za-z0-9-]+$/u.test(effective.ANTHROPIC_MODEL ?? '')
  } catch { return false }
}

/**
 * Merge the local Claude CLI settings' `env` block into the given environment.
 *
 * The CLI reads these values itself, but a provider route also needs them when the
 * process was started without them on its own environment (for example a reviewer
 * spawned by NovaWing). The values are returned in memory only and are never logged.
 */
export async function resolveClaudeProviderEnvironment(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const effective: NodeJS.ProcessEnv = { ...env }
  const settings = [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]
  for (const path of settings) {
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (text === undefined) continue
    const value = JSON.parse(text) as { env?: Record<string, unknown> }
    for (const [name, entry] of Object.entries(value.env ?? {})) if (typeof entry === 'string') effective[name] = entry
  }
  return effective
}
