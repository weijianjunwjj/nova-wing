import { Codex, type CodexOptions, type ThreadOptions } from '@openai/codex-sdk'

import { CODING_EXECUTOR_DEFAULTS } from '../../coding-executor-config.js'
import { codexChatGptEnvironment } from '../../codex-executor.js'
import { bundledCodexExecutable } from '../../codex-runtime.js'

/** Default Repair model; overridable per Launchpad. */
export const REPAIR_DEFAULT_MODEL = CODING_EXECUTOR_DEFAULTS.codex.model
export const REPAIR_DEFAULT_REASONING_EFFORT = 'high'
export const REPAIR_DEFAULT_TIMEOUT_MS = 4 * 60 * 1000

/**
 * A Repair model provider is unavailable (not logged in, SDK missing, timeout,
 * transport failure). This is never a contract problem, so the Task must be
 * preserved unchanged and the caller reports PROVIDER_UNAVAILABLE.
 */
export class RepairProviderUnavailableError extends Error {
  constructor(message: string, readonly safeReason: string) {
    super(message)
    this.name = 'RepairProviderUnavailableError'
  }
}

export interface RepairModelRequest {
  /** Stable instruction block; never contains the Task's mutable contract. */
  system: string
  /** Structured, already-redacted request payload. */
  user: string
  targetRepo: string
  model: string
  reasoningEffort: string
  timeoutMs: number
}

export interface RepairModelResponse {
  text: string
}

/**
 * The one seam between NovaWing's repair orchestration and a language model.
 * Production reuses the installed Codex SDK; tests inject a scripted runner.
 */
export type RepairModelRunner = (request: RepairModelRequest) => Promise<RepairModelResponse>

export interface CodexRepairModelRunnerOptions {
  /** Test/deployment seam; production resolves the executable bundled with the SDK. */
  executable?: string
  createCodex?: (options: CodexOptions) => Pick<Codex, 'startThread'>
  env?: NodeJS.ProcessEnv
  /** Test seam for the bounded repair turn. */
  run?: (thread: ReturnType<Codex['startThread']>, prompt: string, timeoutMs: number) => Promise<string>
}

function safeProviderFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|authorization)\b\s*[:=]\s*\S+/giu, '$1= [redacted]')
    .slice(0, 300)
}

async function defaultRunRepairTurn(
  thread: ReturnType<Codex['startThread']>,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  timer.unref()
  let text = ''
  let completed = false
  let failure: unknown
  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal })
    // Drain to EOF: the CLI only exits once its event stream is fully consumed.
    for await (const event of events) {
      if (event.type === 'turn.completed') completed = true
      else if (event.type === 'turn.failed') failure = event.error
      else if (event.type === 'error') failure ??= event
      else if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        text = event.item.text.slice(0, 64_000)
      }
    }
  } catch (error) {
    failure ??= error
  } finally {
    clearTimeout(timer)
  }
  if (failure !== undefined || !completed) {
    const reason = safeProviderFailure(failure ?? 'Codex repair turn did not complete')
    throw new RepairProviderUnavailableError(`Codex repair turn failed: ${reason}`, reason)
  }
  return text
}

/**
 * Read-only Codex repair runner. It grants no file writes, no network, no MCP
 * tools and no approval escalation: the model may only inspect the repository
 * and answer. Authentication is the existing ChatGPT login used by NovaWing's
 * coding executor, so no separate API key is introduced.
 */
export function createCodexRepairModelRunner(
  options: CodexRepairModelRunnerOptions = {},
): RepairModelRunner {
  const env = options.env ?? process.env
  return async (request) => {
    let executable = options.executable
    if (executable === undefined) {
      try {
        executable = bundledCodexExecutable()
      } catch (error) {
        throw error instanceof RepairProviderUnavailableError
          ? error
          : new RepairProviderUnavailableError(safeProviderFailure(error), safeProviderFailure(error))
      }
    }
    const runtime: CodexOptions = {
      codexPathOverride: executable,
      env: codexChatGptEnvironment(env),
      config: {
        forced_login_method: 'chatgpt',
        model_provider: 'openai',
        features: {
          shell_tool: false, unified_exec: false, view_image: false, code_mode: false, code_mode_host: false,
          hooks: false, plugins: false, apps: false, multi_agent: false, multi_agent_v2: false,
          browser_use: false, computer_use: false, in_app_browser: false, image_generation: false,
          workspace_dependencies: false, skill_mcp_dependency_install: false,
        },
      },
    }
    const threadOptions: ThreadOptions = {
      workingDirectory: request.targetRepo,
      model: request.model,
      modelReasoningEffort: request.reasoningEffort as NonNullable<ThreadOptions['modelReasoningEffort']>,
      // Read-only is the whole point: a repair proposes contract text, never edits.
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      additionalDirectories: [],
      skipGitRepoCheck: true,
    }
    let codex: Pick<Codex, 'startThread'>
    try {
      codex = options.createCodex?.(runtime) ?? new Codex(runtime)
    } catch (error) {
      const reason = safeProviderFailure(error)
      throw new RepairProviderUnavailableError(`Codex runtime is unavailable: ${reason}`, reason)
    }
    let text: string
    try {
      const thread = codex.startThread(threadOptions)
      text = await (options.run ?? defaultRunRepairTurn)(
        thread,
        `${request.system}\n\n${request.user}`,
        request.timeoutMs,
      )
    } catch (error) {
      if (error instanceof RepairProviderUnavailableError) throw error
      const reason = safeProviderFailure(error)
      throw new RepairProviderUnavailableError(`Codex repair turn failed: ${reason}`, reason)
    }
    return { text }
  }
}

/**
 * Whether a Codex repair turn can even be attempted here. Authentication and
 * provider health stay the SDK's business; this only rejects a platform that
 * cannot host the bundled executable, so the Launchpad can report
 * PROVIDER_UNAVAILABLE without spawning anything.
 */
export function isCodexRepairRuntimeAvailable(): boolean {
  try {
    bundledCodexExecutable()
    return true
  } catch {
    return false
  }
}
