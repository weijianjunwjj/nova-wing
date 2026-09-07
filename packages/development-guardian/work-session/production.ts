import { spawn } from 'node:child_process'
import { readFile, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { AskBridgeBrain, type AskBridgeBrainOptions } from '../ask-bridge-brain.js'
import {
  type ClaudeCodeExecutorOptions,
} from '../claude-code-executor.js'
import { DeepSeekExecutor } from '../deepseek-executor.js'
import type { GuardianBrain, GuardianRecoverableExecutor } from '../ports.js'
import { CodexExecutor, type CodexExecutorOptions } from '../codex-executor.js'
import { ExecutorRouter, type RouterCodexExecutor } from '../executor-router.js'
import {
  CODING_EXECUTOR_DEFAULTS,
  isSupportedCodexConfiguration,
  resolvePersistedCodexConfiguration,
} from '../coding-executor-config.js'
import { CodingExecutionStore, defaultCodingExecutionStorePath } from './coding-execution-store.js'
import { createGuardianTask, GuardianWorkSessionTaskRunner } from './guardian-task-runner.js'
import type { WorkSessionDefinition, WorkSessionTask } from './model.js'
import { normalizeScheduledStart } from './schedule-policy.js'
import type { SmtpMailTransport, SmtpTransportConfig } from './smtp-notifier.js'
import { createSmtpWorkSessionNotifierFromEnv } from './smtp-notifier.js'
import {
  WorkSessionRuntime,
  type WorkSessionRuntimeConfig,
} from './runtime.js'
import type { WorkSessionControlRuntime } from './control-ui/events.js'
import {
  WorkSessionControlController,
} from './control-ui/controller.js'
import {
  WorkSessionControlServer,
  type WorkSessionControlServerAddress,
} from './control-ui/server.js'
import {
  requireDependencyPreflightReady,
  resolveAskBridgeExecutable,
  runProductionDependencyPreflight,
  type DependencyHealthReport,
} from './dependency-health.js'

const GuardianPolicySchema = z.object({
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  doNotDo: z.array(z.string()),
  allowedPaths: z.array(z.string()).min(1),
  forbiddenPaths: z.array(z.string()),
}).strict()

const TrustedConfigSchema = z.object({
  session: z.object({
    id: z.string(),
    targetRepo: z.string(),
    branch: z.string(),
    scheduledStartAt: z.string().nullable().optional(),
    scheduleSource: z.enum(['immediate', 'custom', 'deepseek_off_peak']).optional(),
    createdAt: z.string().optional(),
    limits: z.object({
      softMinutes: z.number(),
      hardMinutes: z.number(),
      maxTasks: z.number(),
    }).strict(),
  }).strict(),
  tasks: z.array(z.object({
    id: z.string(),
    goal: z.string(),
    guardian: GuardianPolicySchema,
    executorMode: z.enum(['auto', 'codex', 'deepseek']).optional(),
  }).strict()).min(1),
  gitCheckpoint: z.object({
    autoCommit: z.boolean(),
    autoPush: z.boolean(),
    pushRemote: z.object({
      name: z.string(),
      expectedUrl: z.string(),
    }).strict().optional(),
  }).strict(),
  executor: z.object({
    defaultMode: z.enum(['auto', 'codex', 'deepseek']).optional(),
    model: z.string(),
    maxTurns: z.number(),
    allowNpmInstall: z.boolean(),
    allowPythonBootstrap: z.boolean(),
  }).strict(),
  codex: z.object({
    enabled: z.boolean().optional(),
    model: z.string().trim().min(1).optional(),
    reasoningEffort: z.string().trim().min(1).optional(),
    quotaProbeCooldownMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  }).strict().optional(),
  notification: z.object({
    email: z.object({
      enabled: z.boolean(),
      notifyOnCompleted: z.boolean().optional(),
    }).strict(),
  }).strict().optional(),
  storageUrl: z.string().optional(),
}).strict()

export type TrustedWorkSessionConfig = z.infer<typeof TrustedConfigSchema>

const CREDENTIAL_KEY = /(?:authorization|password|secret|credential|apikey|api_key|oauth|cookie|token)/iu

function assertNoCredentialLikeKeys(value: unknown, path = 'config'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialLikeKeys(entry, `${path}[${index}]`))
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new Error(`credential-like config key is forbidden at ${path}.${key}`)
    }
    assertNoCredentialLikeKeys(child, `${path}.${key}`)
  }
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`${field} must be non-empty`)
  return trimmed
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function storagePathFromUrl(storageUrl: string): string {
  if (!storageUrl.startsWith('file:')) {
    throw new Error('storageUrl must use a local file: URL')
  }
  return fileURLToPath(storageUrl)
}

export async function validateTrustedWorkSessionConfig(
  input: unknown,
): Promise<TrustedWorkSessionConfig> {
  assertNoCredentialLikeKeys(input)
  const config = TrustedConfigSchema.parse(input)
  if (config.session.scheduledStartAt !== undefined) {
    config.session.scheduledStartAt = normalizeScheduledStart(config.session.scheduledStartAt)
  }
  if (config.session.createdAt !== undefined) config.session.createdAt = normalizeScheduledStart(config.session.createdAt)!
  if (config.notification?.email.enabled === false && config.notification.email.notifyOnCompleted === true) {
    throw new Error('notification.email.notifyOnCompleted requires notification.email.enabled=true')
  }
  config.session.id = requireTrimmed(config.session.id, 'session.id')
  config.session.branch = requireTrimmed(config.session.branch, 'session.branch')
  config.session.targetRepo = requireTrimmed(config.session.targetRepo, 'session.targetRepo')

  if (!isAbsolute(config.session.targetRepo)) {
    throw new Error('session.targetRepo must be absolute')
  }
  const repoStat = await stat(config.session.targetRepo).catch(() => undefined)
  if (repoStat === undefined || !repoStat.isDirectory()) {
    throw new Error('session.targetRepo must be an existing directory')
  }
  if (!Number.isInteger(config.session.limits.maxTasks) || config.session.limits.maxTasks < 1) {
    throw new Error('session.limits.maxTasks must be an integer >= 1')
  }
  if (
    !Number.isFinite(config.session.limits.softMinutes) ||
    config.session.limits.softMinutes < 0 ||
    !Number.isFinite(config.session.limits.hardMinutes) ||
    config.session.limits.hardMinutes <= 0 ||
    config.session.limits.hardMinutes < config.session.limits.softMinutes
  ) {
    throw new Error('session time limits are invalid')
  }

  const taskIds = new Set<string>()
  for (const task of config.tasks) {
    task.id = requireTrimmed(task.id, 'tasks[].id')
    task.goal = requireTrimmed(task.goal, `tasks.${task.id}.goal`)
    if (taskIds.has(task.id)) throw new Error(`duplicate task id: ${task.id}`)
    taskIds.add(task.id)
    for (const path of task.guardian.allowedPaths) {
      requireTrimmed(path, `tasks.${task.id}.guardian.allowedPaths[]`)
    }
  }

  config.executor.model = requireTrimmed(config.executor.model, 'executor.model')
  if (config.codex !== undefined) {
    const resolved = resolvePersistedCodexConfiguration(config.codex)
    if (!isSupportedCodexConfiguration(resolved.model, resolved.reasoningEffort)) {
      throw new Error('Codex model/reasoning configuration is unsupported')
    }
  }
  if (!Number.isInteger(config.executor.maxTurns) || config.executor.maxTurns < 1) {
    throw new Error('executor.maxTurns must be an integer >= 1')
  }
  if (config.gitCheckpoint.autoPush && !config.gitCheckpoint.autoCommit) {
    throw new Error('autoPush requires autoCommit')
  }
  if (config.gitCheckpoint.autoPush) {
    if (config.gitCheckpoint.pushRemote === undefined) {
      throw new Error('autoPush requires trusted pushRemote policy')
    }
    config.gitCheckpoint.pushRemote.name = requireTrimmed(
      config.gitCheckpoint.pushRemote.name,
      'gitCheckpoint.pushRemote.name',
    )
    config.gitCheckpoint.pushRemote.expectedUrl = requireTrimmed(
      config.gitCheckpoint.pushRemote.expectedUrl,
      'gitCheckpoint.pushRemote.expectedUrl',
    )
  }
  if (config.storageUrl !== undefined) {
    const storagePath = storagePathFromUrl(config.storageUrl)
    if (!isAbsolute(storagePath)) throw new Error('storageUrl file path must be absolute')
    if (isInside(config.session.targetRepo, storagePath)) {
      throw new Error('Work Session storage must be outside targetRepo')
    }
  }
  return config
}

export async function loadTrustedWorkSessionConfig(
  configPath: string,
): Promise<TrustedWorkSessionConfig> {
  const absolutePath = resolve(configPath)
  const text = await readFile(absolutePath, 'utf8')
  let input: unknown
  try {
    input = JSON.parse(text) as unknown
  } catch {
    throw new Error('Work Session config is not valid JSON')
  }
  return validateTrustedWorkSessionConfig(input)
}

export interface ProductionGitProcessRunner {
  (executable: 'git', args: readonly string[], cwd: string): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

const PRODUCTION_GIT_COMMANDS = new Map<string, readonly string[]>([
  ['git branch --show-current', ['branch', '--show-current']],
  ['git remote get-url --push --all origin', ['remote', 'get-url', '--push', '--all', 'origin']],
  ['git rev-parse HEAD', ['rev-parse', 'HEAD']],
  ['git status --porcelain --untracked-files=all', ['status', '--porcelain', '--untracked-files=all']],
])

function defaultGitProcessRunner(
  executable: 'git',
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', (error) => {
      resolveRun({ exitCode: 1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('exit', (exitCode) => {
      resolveRun({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })
}

export function createProductionGitRunner(
  repoPath: string,
  processRunner: ProductionGitProcessRunner = defaultGitProcessRunner,
): (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return async (command: string) => {
    const args = PRODUCTION_GIT_COMMANDS.get(command)
    if (args === undefined) {
      throw new Error(`unsupported production git command: ${command}`)
    }
    return processRunner('git', args, repoPath)
  }
}

interface ClosableControlRuntime extends WorkSessionControlRuntime {
  close?(): Promise<void>
}

export interface ProductionWorkSessionDependencies {
  createCodexExecutor?: (options: CodexExecutorOptions) => RouterCodexExecutor
  createBrain?: (options: AskBridgeBrainOptions) => GuardianBrain
  createExecutor?: (options: ClaudeCodeExecutorOptions) => GuardianRecoverableExecutor
  createRuntime?: (config: WorkSessionRuntimeConfig) => ClosableControlRuntime
  gitProcessRunner?: ProductionGitProcessRunner
  serverPort?: number
  env?: NodeJS.ProcessEnv
  createSmtpTransport?: (config: SmtpTransportConfig) => SmtpMailTransport
  notificationRetryDelayMs?: number
  preflight?: (targetRepo: string) => Promise<DependencyHealthReport>
}

export interface ProductionWorkSessionUi {
  definition: WorkSessionDefinition
  controller: WorkSessionControlController
  server: WorkSessionControlServer
  runtime: ClosableControlRuntime
  start(): Promise<WorkSessionControlServerAddress>
  isLive(): boolean
  hasActiveSession(): boolean
  close(): Promise<void>
}

export function defaultStorageUrl(sessionId: string, env: NodeJS.ProcessEnv): string {
  const base = env.LOCALAPPDATA?.trim() || join(homedir(), '.novawing')
  return new URL(`file:///${join(base, 'NovaWing', 'work-sessions', `${sessionId}.db`).replaceAll('\\', '/')}`).href
}

function brainReasoning(env: NodeJS.ProcessEnv): 'auto' | 'instant' | 'medium' | 'high' {
  const value = env.NOVAWING_CHATGPT_REASONING?.trim() || 'high'
  if (value !== 'auto' && value !== 'instant' && value !== 'medium' && value !== 'high') {
    throw new Error('NOVAWING_CHATGPT_REASONING is invalid')
  }
  return value
}

export async function createProductionWorkSessionUi(
  config: TrustedWorkSessionConfig,
  dependencies: ProductionWorkSessionDependencies = {},
): Promise<ProductionWorkSessionUi> {
  const trusted = await validateTrustedWorkSessionConfig(config)
  const env = dependencies.env ?? process.env
  const notifier = trusted.notification?.email.enabled === true
    ? createSmtpWorkSessionNotifierFromEnv({
        env,
        ...(dependencies.createSmtpTransport === undefined
          ? {}
          : { createTransport: dependencies.createSmtpTransport }),
      })
    : undefined
  const definition: WorkSessionDefinition = {
    id: trusted.session.id,
    targetRepo: trusted.session.targetRepo,
    branch: trusted.session.branch,
    tasks: trusted.tasks.map((task) => ({ id: task.id, goal: task.goal })),
    limits: { ...trusted.session.limits },
    ...(trusted.session.scheduledStartAt === undefined ? {} : { scheduledStartAt: trusted.session.scheduledStartAt }),
    ...(trusted.session.scheduleSource === undefined ? {} : { scheduleSource: trusted.session.scheduleSource }),
    ...(trusted.session.createdAt === undefined ? {} : { createdAt: trusted.session.createdAt }),
  }
  const storageUrl = trusted.storageUrl ?? defaultStorageUrl(trusted.session.id, env)
  const storagePath = storagePathFromUrl(storageUrl)
  if (isInside(definition.targetRepo, storagePath)) {
    throw new Error('Work Session storage must be outside targetRepo')
  }
  await mkdir(resolve(storagePath, '..'), { recursive: true })
  const verificationOutputDirectory = `${storagePath}.artifacts`

  const createBrain = dependencies.createBrain ?? ((options) => new AskBridgeBrain(options))
  const brain = createBrain({
    command: resolveAskBridgeExecutable(env),
    ...(env.NOVAWING_CHATGPT_MODEL?.trim()
      ? { model: env.NOVAWING_CHATGPT_MODEL.trim() }
      : {}),
    reasoning: brainReasoning(env),
  })
  const createExecutor = dependencies.createExecutor ?? ((options) => new DeepSeekExecutor(options))
  const taskModes = new Map(trusted.tasks.map((task) => [task.id,
    task.executorMode ?? trusted.executor.defaultMode ?? (trusted.session.scheduleSource === 'deepseek_off_peak' ? 'deepseek' : CODING_EXECUTOR_DEFAULTS.defaultMode)]))
  // One local coordinator even when sessions use different custom workflow storage URLs.
  // Injected executor tests stay isolated with their temporary session storage.
  const codingStore = new CodingExecutionStore(dependencies.createExecutor !== undefined && dependencies.createCodexExecutor === undefined
    ? join(resolve(storagePath, '..'), 'coding-executors.sqlite')
    : defaultCodingExecutionStorePath(env))
  const taskKey = (id: string) => JSON.stringify([definition.id, id])
  const policies = new Map(trusted.tasks.map((task) => [task.id, task.guardian]))
  const gitRunner = createProductionGitRunner(
    definition.targetRepo,
    dependencies.gitProcessRunner,
  )
  let runtime: ClosableControlRuntime | undefined
  let localControlUrl: string | undefined

  const controller = new WorkSessionControlController({
    readCodingExecutions: () => trusted.tasks.map((task) => {
      const state = codingStore.read(taskKey(task.id))
      return { taskId: task.id, mode: taskModes.get(task.id)!,
        ...(state === undefined ? {} : {
          activeExecutor: state.activeExecutor, history: state.history,
          ...(state.model === undefined ? {} : { model: state.model }),
          ...(state.reasoningEffort === undefined ? {} : { reasoningEffort: state.reasoningEffort }),
          ...(state.failoverReason === undefined ? {} : { failoverReason: state.failoverReason }),
          ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
        }) }
    }),
    beforeResume: async () => {
      const availability = codingStore.availability()
      const quotaBlocked = availability.state === 'quota_exhausted' &&
        Date.parse(availability.blockedUntil ?? availability.nextProbeAt ?? '') > Date.now()
      const snapshot = controller.getSnapshot().runtime
      const nextTaskId = snapshot.currentTaskId ?? trusted.tasks.find(task => !snapshot.completedTaskIds?.includes(task.id))?.id
      const executorModes = trusted.tasks.filter(task => task.id === nextTaskId).map((task) => {
        const persisted = codingStore.read(taskKey(task.id))
        const mode = taskModes.get(task.id)!
        return persisted?.activeExecutor ?? (mode === 'auto' && quotaBlocked ? 'deepseek' : mode)
      })
      const report = await (dependencies.preflight?.(definition.targetRepo) ??
        runProductionDependencyPreflight({ env, targetRepo: definition.targetRepo, executorModes }))
      requireDependencyPreflightReady(report)
    },
    createRuntime(eventSink, notificationSink) {
      const runner = new GuardianWorkSessionTaskRunner({
        brain,
        repoPath: definition.targetRepo,
        gitRunner,
        onProgress: eventSink,
        createGuardianTask(task: WorkSessionTask) {
          const policy = policies.get(task.id)
          if (policy === undefined) throw new Error(`missing Guardian policy for task ${task.id}`)
          return createGuardianTask(task, policy)
        },
        createExecutor(task, _resumeData, onProgress, approvedVerificationCommand) {
          const options: ClaudeCodeExecutorOptions = {
            cwd: definition.targetRepo,
            model: trusted.executor.model,
            maxTurns: trusted.executor.maxTurns,
            allowNpmInstall: trusted.executor.allowNpmInstall,
            allowPythonBootstrap: trusted.executor.allowPythonBootstrap,
            verificationOutputDirectory,
            ...(approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand }),
            ...(env.NOVAWING_GIT_BASH_PATH?.trim()
              ? { gitBashPath: env.NOVAWING_GIT_BASH_PATH.trim() }
              : {}),
            onVerification(verification) {
              onProgress?.({
                phase: 'VERIFYING',
                status: verification.status === 'running'
                  ? 'active'
                  : verification.status === 'passed' ? 'completed' : 'failed',
                iteration: verification.iteration,
                // Executor hook reports command-local duration, not Guardian cumulative elapsed.
                elapsedMs: verification.durationMs ?? 0,
                verification,
              })
            },
            onRecovery(recovery) {
              onProgress?.({
                phase: 'RECOVERING',
                status: 'active',
                iteration: recovery.iteration,
                elapsedMs: 0,
                recovery,
              })
            },
          }
          // Preserve the existing injected Executor test/integration seam.
          if (dependencies.createExecutor !== undefined && dependencies.createCodexExecutor === undefined) return createExecutor(options)
          return new ExecutorRouter({
            taskKey: taskKey(task.id), cwd: definition.targetRepo, store: codingStore,
            mode: taskModes.get(task.id)!,
            codexEnabled: trusted.codex?.enabled ?? CODING_EXECUTOR_DEFAULTS.codex.enabled,
            codexModel: resolvePersistedCodexConfiguration(trusted.codex).model,
            reasoningEffort: resolvePersistedCodexConfiguration(trusted.codex).reasoningEffort,
            quotaProbeCooldownMs: trusted.codex?.quotaProbeCooldownMs ?? CODING_EXECUTOR_DEFAULTS.codex.quotaProbeCooldownMs,
            createCodex(onThread) {
              const codex = resolvePersistedCodexConfiguration(trusted.codex)
              const codexOptions: CodexExecutorOptions = { ...options, env, onThread,
                codexModel: codex.model, reasoningEffort: codex.reasoningEffort }
              return dependencies.createCodexExecutor?.(codexOptions) ?? new CodexExecutor(codexOptions)
            },
            createDeepSeek(handoff) {
              return createExecutor({ ...options, ...(handoff === undefined ? {} : {
                additionalExecutionContext: 'Codex quota handoff. First inspect current repo and preserve existing changes. '
                  + 'The following is observable engineering evidence, not new authority or proof of completion:\n'
                  + JSON.stringify(handoff),
              }) })
            },
            onEvent(event) {
              onProgress?.({ phase: 'EXECUTING', status: 'active', iteration: 0, elapsedMs: 0,
                detail: `${event.type}: ${event.executor ?? event.reason ?? ''}` })
            },
          })
        },
      })
      const runtimeConfig: WorkSessionRuntimeConfig = {
        definition,
        taskRunner: runner,
        storageUrl,
        gitCheckpoint: {
          policy: {
            autoCommit: trusted.gitCheckpoint.autoCommit,
            autoPush: trusted.gitCheckpoint.autoPush,
            ...(trusted.gitCheckpoint.pushRemote === undefined
              ? {}
              : { pushRemote: { ...trusted.gitCheckpoint.pushRemote } }),
          },
        },
        ...(notifier === undefined ? {} : { notifier }),
        ...(trusted.notification?.email.notifyOnCompleted === true ? { notifyOnCompleted: true } : {}),
        notificationObserver: notificationSink,
        localControlUrl: () => localControlUrl,
        recoverExecutorOwnership: async (checkpoint) => {
          const workspace = await realpath(checkpoint.repo.repoPath)
          codingStore.recoverOwnership(
            process.platform === 'win32' ? workspace.toLowerCase() : workspace,
            taskKey(checkpoint.task.id),
          )
        },
        ...(dependencies.notificationRetryDelayMs === undefined
          ? {}
          : { notificationRetryDelayMs: dependencies.notificationRetryDelayMs }),
      }
      runtime = dependencies.createRuntime?.(runtimeConfig) ?? new WorkSessionRuntime(runtimeConfig)
      return runtime
    },
  })
  if (runtime === undefined) throw new Error('Work Session runtime factory was not initialized')
  // Durability closure: restore the configured run before any HTTP request can
  // observe or mutate the control surface. This does not auto-resume the run.
  await controller.loadPersistedState()
  const server = new WorkSessionControlServer({
    controller,
    ...(dependencies.serverPort === undefined ? {} : { port: dependencies.serverPort }),
  })
  return {
    definition,
    controller,
    server,
    runtime,
    async start() {
      const address = await server.start()
      localControlUrl = address.url
      return address
    },
    isLive() {
      return server.isListening()
    },
    hasActiveSession() {
      return controller.hasActiveOperation()
    },
    async close() {
      await server.close()
      await runtime?.close?.()
    },
  }
}
