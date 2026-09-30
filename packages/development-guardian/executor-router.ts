import { workspacePathKey } from './platform/paths.js'
import { realpath } from 'node:fs/promises'
import type { GuardianRecoverableExecutor } from './ports.js'
import type { DelegationPacket, ExecutionReport, GuardianTask, VerificationExecutionStep } from './model.js'
import type { ProviderSessionState, RepositoryCheckpoint } from './work-session/checkpoint.js'
import { CODING_EXECUTOR_DEFAULTS, type CodingExecutionMetadata, type ExecutorMode } from './coding-executor-config.js'
import type { ClassifiedCodexError } from './codex-error.js'
import { classifyCodexError } from './codex-error.js'
import { CodingExecutionStore, type CodingExecutorEvent } from './work-session/coding-execution-store.js'
import { readWorkspaceGit } from './codex-workspace-tools.js'
import { computeWorktreeFingerprint, parseGitStatus } from './work-session/worktree-fingerprint.js'

export interface ExecutorHandoffContext {
  task: GuardianTask
  currentDecision: DelegationPacket
  workspace: RepositoryCheckpoint
  workingTree: string
  diffSummary: string
  changedFiles: readonly string[]
  knownTestResults: ExecutionReport['verificationResults']
  testEvidenceFreshness: 'historical; reverify after partial edits'
  commandsAlreadyExecuted: readonly string[]
  codexExecutionSummary: string
  unresolvedFailures: readonly string[]
  reviewerFeedback: DelegationPacket
  verificationRequirements: readonly string[]
  approvedVerificationCommand?: string
}

export interface RouterCodexExecutor extends GuardianRecoverableExecutor { lastError?: ClassifiedCodexError | undefined }

export interface ExecutorRouterOptions {
  taskKey: string
  cwd: string
  mode?: ExecutorMode
  codexEnabled?: boolean
  codexModel?: string
  reasoningEffort?: string
  store: CodingExecutionStore
  createCodex(onThread: (id: string, resumed: boolean) => void): RouterCodexExecutor
  createDeepSeek(handoff?: ExecutorHandoffContext): GuardianRecoverableExecutor
  clock?: () => number
  quotaProbeCooldownMs?: number
  transientRetries?: number
  onEvent?: (event: CodingExecutorEvent, metadata: CodingExecutionMetadata) => void
}

export class ExecutorRouter implements GuardianRecoverableExecutor {
  private metadata: CodingExecutionMetadata | undefined
  private codex: RouterCodexExecutor | undefined
  private deepseek: GuardianRecoverableExecutor | undefined
  private recoveryCheckpoint: RepositoryCheckpoint | undefined
  private provider: ProviderSessionState = {}
  private taskId: string | undefined

  constructor(private readonly options: ExecutorRouterOptions) { this.metadata = options.store.read(options.taskKey) }
  captureProviderState(): ProviderSessionState {
    return { ...(this.deepseek?.captureProviderState?.() ?? {}),
      ...(this.metadata === undefined ? {} : { codingExecution: structuredClone(this.metadata) }) }
  }
  restoreProviderState(provider: ProviderSessionState): void {
    this.provider = provider
    // A newer durable sticky failover wins over an older suspended checkpoint.
    this.metadata ??= provider.codingExecution
  }
  setRecoveryCheckpoint(checkpoint: RepositoryCheckpoint): void { this.recoveryCheckpoint = checkpoint }

  private now(): number { return this.options.clock?.() ?? Date.now() }
  private save(event: Omit<CodingExecutorEvent, 'timestamp'>, handoff?: ExecutorHandoffContext): void {
    const complete = { ...event, timestamp: new Date(this.now()).toISOString() }
    this.options.store.save(this.options.taskKey, this.metadata!, complete, handoff)
    try { this.options.onEvent?.(complete, structuredClone(this.metadata!)) } catch { /* observability only */ }
  }
  private codexExecutor(): RouterCodexExecutor {
    if (this.codex === undefined) {
      this.codex = this.options.createCodex((id, resumed) => {
        this.metadata!.codexThreadId = id
        this.save({ type: resumed ? 'codex_thread_resumed' : 'codex_thread_started', executor: 'codex', codexThreadId: id })
      })
      this.codex.restoreProviderState?.({ codingExecution: this.metadata! })
      if (this.recoveryCheckpoint) this.codex.setRecoveryCheckpoint?.(this.recoveryCheckpoint)
    }
    return this.codex
  }
  private deepSeekExecutor(handoff?: ExecutorHandoffContext): GuardianRecoverableExecutor {
    if (this.deepseek === undefined) {
      const persistedHandoff = handoff ?? this.options.store.handoff(this.options.taskKey)
      this.deepseek = this.options.createDeepSeek(persistedHandoff)
      this.deepseek.restoreProviderState?.(this.provider)
      const checkpoint = handoff?.workspace ?? this.recoveryCheckpoint ?? persistedHandoff?.workspace
      if (checkpoint) this.deepseek.setRecoveryCheckpoint?.(checkpoint)
    }
    return this.deepseek
  }
  private select(): void {
    this.metadata = this.options.store.read(this.options.taskKey) ?? this.metadata
    if (this.metadata !== undefined) return
    const mode = this.options.mode ?? CODING_EXECUTOR_DEFAULTS.defaultMode
    const available = this.options.store.availability()
    const blocked = available.state === 'quota_exhausted' &&
      Date.parse(available.blockedUntil ?? available.nextProbeAt ?? '') > this.now()
    const executor = mode === 'deepseek' || (mode === 'auto' && blocked) ? 'deepseek' : 'codex'
    this.metadata = { mode, activeExecutor: executor, history: [executor],
      ...(executor === 'codex' ? {
        model: this.options.codexModel ?? CODING_EXECUTOR_DEFAULTS.codex.model,
        reasoningEffort: this.options.reasoningEffort ?? CODING_EXECUTOR_DEFAULTS.codex.reasoningEffort,
      } : {}), ...(blocked && mode === 'auto' ? { failoverReason: 'codex_quota_exhausted' as const } : {}) }
  }
  private report(report: ExecutionReport): ExecutionReport {
    return { ...report, execution: structuredClone(this.metadata!) }
  }

  /** Replace only a Codex thread that produced a confirmed zero-evidence no-op. */
  prepareNoOpRetry(): boolean {
    this.select()
    if (this.metadata!.activeExecutor !== 'codex' || this.metadata!.lastErrorKind !== 'no_op_execution') return false
    delete this.metadata!.codexThreadId
    delete this.metadata!.lastError
    delete this.metadata!.lastErrorKind
    this.codex = undefined
    this.save({ type: 'codex_thread_replaced', executor: 'codex', reason: 'no_op_execution' })
    return true
  }

  async preflight(task: GuardianTask): Promise<void> {
    if (this.taskId !== undefined && this.taskId !== task.id) throw new Error('Executor router belongs to another Task')
    this.taskId = task.id
    this.select()
    if (this.metadata!.activeExecutor === 'codex') {
      if (this.options.codexEnabled === false) throw Object.assign(new Error('Codex Local is disabled'), { code: 'configuration_error' })
      // A no-op thread can have durable identity but no usable workspace tools.
      // Rotate only after the explicit retry acknowledgement; preserve Task,
      // scope, provider choice, and every non-thread recovery fact.
      if (task.recoveryContinuation === true && task.resumeInput?.approval === true &&
          this.metadata!.lastErrorKind === 'no_op_execution') {
        this.prepareNoOpRetry()
      }
      await this.codexExecutor().preflight?.(task)
    }
  }

  async execute(input: { task: GuardianTask; packet: DelegationPacket }): Promise<ExecutionReport> {
    if (this.taskId !== undefined && this.taskId !== input.task.id) throw new Error('Executor router belongs to another Task')
    this.taskId = input.task.id
    const workspace = await realpath(this.options.cwd)
    // Local DB arbitration covers different runtime instances AND different Tasks sharing a workspace.
    const release = this.options.store.acquire(workspacePathKey(workspace), this.options.taskKey)
    let ownershipReleased = false
    try {
      this.select()
      const injection = this.options.store.controlledQuotaInjection(this.options.taskKey)
      if (injection?.status === 'pending') {
        const metadata = this.metadata!
        const prior = input.task.lastReport
        if (injection.kind !== 'codex_quota_exhausted' || injection.taskId !== input.task.id ||
            metadata.mode !== 'auto' || metadata.activeExecutor !== 'codex' ||
            metadata.history.length !== 1 || metadata.history[0] !== 'codex' || prior === undefined ||
            prior.changedFiles.length === 0) {
          throw new Error('controlled quota injection preconditions no longer match Task state')
        }
        const workingTree = await readWorkspaceGit(this.options.cwd, 'status')
        const entries = parseGitStatus(workingTree)
        const fingerprint = await computeWorktreeFingerprint(this.options.cwd, entries)
        const diff = await readWorkspaceGit(this.options.cwd, 'diff')
        const diffEvidence = diff.length > 0 ? diff : workingTree
        const currentFiles = entries.map((entry) => entry.path).sort()
        if (fingerprint !== injection.expectedWorktreeFingerprint ||
            Buffer.byteLength(diffEvidence, 'utf8') !== injection.expectedDiffBytes ||
            JSON.stringify(currentFiles) !== JSON.stringify([...injection.expectedChangedFiles].sort())) {
          throw new Error('controlled quota injection rejected because workspace checkpoint drifted')
        }
        const consumedAt = new Date(this.now()).toISOString()
        this.options.store.consumeControlledQuotaInjection(this.options.taskKey, injection.injectionId, consumedAt)
        const error = classifyCodexError({ code: 'usage_limit_reached' }, this.now())
        if (error.kind !== 'quota_exhausted') throw new Error('controlled quota injection classifier mismatch')
        metadata.lastError = error.message
        metadata.lastErrorKind = error.kind
        this.save({ type: 'executor_error', executor: 'codex', reason: error.kind,
          testInjected: true, injectionId: injection.injectionId })
        this.options.store.markQuota(error, this.now(), this.options.quotaProbeCooldownMs ?? CODING_EXECUTOR_DEFAULTS.codex.quotaProbeCooldownMs)
        this.save({ type: 'executor_ownership_released', executor: 'codex', reason: 'codex_quota_exhausted',
          testInjected: true, injectionId: injection.injectionId })
        const handoff = await this.handoff(input, prior)
        metadata.activeExecutor = 'deepseek'
        metadata.history.push('deepseek')
        metadata.failoverReason = 'codex_quota_exhausted'
        delete metadata.lastError
        delete metadata.lastErrorKind
        delete metadata.model
        delete metadata.reasoningEffort
        this.save({ type: 'executor_failed_over', from: 'codex', to: 'deepseek', reason: 'codex_quota_exhausted',
          testInjected: true, injectionId: injection.injectionId,
          ...(metadata.codexThreadId ? { codexThreadId: metadata.codexThreadId } : {}) }, handoff)
        this.save({ type: 'executor_ownership_acquired', executor: 'deepseek', reason: 'codex_quota_exhausted',
          testInjected: true, injectionId: injection.injectionId })
        this.save({ type: 'executor_started', executor: 'deepseek', testInjected: true, injectionId: injection.injectionId })
        let report = await this.deepSeekExecutor(handoff).execute(input)
        this.save({ type: report.blockers.length === 0 ? 'executor_completed' : 'executor_error', executor: 'deepseek' })
        ownershipReleased = this.deepseek?.hasReleasedExecutionOwnership?.() !== false
        if (!ownershipReleased) report = { ...report, blockers: [...report.blockers,
          'Executor process termination is unconfirmed; workspace ownership retained for operator recovery'] }
        return this.report(report)
      }
      this.save({ type: 'executor_started', executor: this.metadata!.activeExecutor })
      let report: ExecutionReport
      if (this.metadata!.activeExecutor === 'deepseek') report = await this.deepSeekExecutor().execute(input)
      else {
        if (this.options.codexEnabled === false) {
          ownershipReleased = true
          return this.report({ summary: 'Codex Local is disabled in configuration', changedFiles: [], commandsRun: [],
            verificationResults: [], blockers: ['Codex Local configuration error: explicitly select DeepSeek or enable Codex'] })
        }
        let codex = this.codexExecutor()
        report = await codex.execute(input)
        let error = codex.lastError
        const retries = this.options.transientRetries ?? CODING_EXECUTOR_DEFAULTS.codex.transientRetries
        for (let attempt = 0; error?.kind === 'transient' && attempt < retries; attempt++) {
          if (codex.hasReleasedExecutionOwnership?.() === false) break
          if (report.blockers.some((blocker) => blocker !== error!.message)) break
          report = await codex.execute(input)
          error = codex.lastError
        }
        // A completed turn with no workspace inspection has no implementation
        // authority. One fresh thread can recover a transient missing tool host;
        // retain the same Task, provider and workspace lease, then fail closed if
        // the replacement also produces no inspected evidence.
        if (error?.kind === 'no_op_execution' && report.changedFiles.length === 0 &&
            report.blockers.every((blocker) => blocker === error!.message) &&
            codex.hasReleasedExecutionOwnership?.() !== false) {
          this.metadata!.lastError = error.message
          this.metadata!.lastErrorKind = error.kind
          this.save({ type: 'executor_error', executor: 'codex', reason: error.kind })
          this.prepareNoOpRetry()
          codex = this.codexExecutor()
          report = await codex.execute(input)
          error = codex.lastError
        }
        if (error) {
          this.metadata!.lastError = error.message
          this.metadata!.lastErrorKind = error.kind
          this.save({ type: 'executor_error', executor: 'codex', reason: error.kind })
          if (error.kind === 'quota_exhausted') {
            this.options.store.markQuota(error, this.now(), this.options.quotaProbeCooldownMs ?? CODING_EXECUTOR_DEFAULTS.codex.quotaProbeCooldownMs)
            if (this.metadata!.mode === 'auto' && codex.hasReleasedExecutionOwnership?.() !== false &&
                report.blockers.every((blocker) => blocker === error!.message)) {
              // execute() has fully settled and revoked Codex's file tools BEFORE this point.
              this.save({ type: 'executor_ownership_released', executor: 'codex', reason: 'codex_quota_exhausted' })
              const handoff = await this.handoff(input, report)
              this.metadata!.activeExecutor = 'deepseek'
              this.metadata!.history.push('deepseek')
              this.metadata!.failoverReason = 'codex_quota_exhausted'
              delete this.metadata!.lastError
              delete this.metadata!.lastErrorKind
              delete this.metadata!.model
              delete this.metadata!.reasoningEffort
              this.save({ type: 'executor_failed_over', from: 'codex', to: 'deepseek', reason: 'codex_quota_exhausted',
                ...(this.metadata!.codexThreadId ? { codexThreadId: this.metadata!.codexThreadId } : {}) }, handoff)
              // Immediate takeover of THIS Task; the unstarted-task Scheduler is never involved.
              // The Task-scoped workspace lease remains continuously held while provider
              // ownership changes, so no second writer can enter between persistence and spawn.
              this.save({ type: 'executor_ownership_acquired', executor: 'deepseek', reason: 'codex_quota_exhausted' })
              this.save({ type: 'executor_started', executor: 'deepseek' })
              report = await this.deepSeekExecutor(handoff).execute(input)
            }
          }
        } else if (report.blockers.length === 0) {
          delete this.metadata!.lastError
          delete this.metadata!.lastErrorKind
          this.options.store.markAvailable()
        }
      }
      this.save({ type: report.blockers.length === 0 ? 'executor_completed' : 'executor_error', executor: this.metadata!.activeExecutor })
      const active = this.metadata!.activeExecutor === 'codex' ? this.codex : this.deepseek
      ownershipReleased = active?.hasReleasedExecutionOwnership?.() !== false
      if (!ownershipReleased) report = { ...report, blockers: [...report.blockers,
        'Executor process termination is unconfirmed; workspace ownership retained for operator recovery'] }
      return this.report(report)
    } finally { if (ownershipReleased) release() }
  }

  async retryVerification(input: { task: GuardianTask; report: ExecutionReport; verificationSteps?: readonly VerificationExecutionStep[] }): Promise<ExecutionReport> {
    const workspace = await realpath(this.options.cwd)
    const release = this.options.store.acquire(workspacePathKey(workspace), this.options.taskKey)
    let ownershipReleased = false
    try {
      this.select()
      const executor = this.metadata!.activeExecutor === 'codex' ? this.codexExecutor() : this.deepSeekExecutor()
      let report = await executor.retryVerification?.(input) ?? input.report
      ownershipReleased = executor.hasReleasedExecutionOwnership?.() !== false
      if (!ownershipReleased) report = { ...report, blockers: [...report.blockers,
        'Executor process termination is unconfirmed; workspace ownership retained for operator recovery'] }
      return this.report(report)
    } finally { if (ownershipReleased) release() }
  }

  private async handoff(input: { task: GuardianTask; packet: DelegationPacket }, report: ExecutionReport): Promise<ExecutorHandoffContext> {
    const workingTree = await readWorkspaceGit(this.options.cwd, 'status')
    const entries = parseGitStatus(workingTree)
    const workspace: RepositoryCheckpoint = {
      repoPath: this.options.cwd, branch: (await readWorkspaceGit(this.options.cwd, 'branch')).trim(),
      headSha: (await readWorkspaceGit(this.options.cwd, 'head')).trim(),
      changedFiles: report.changedFiles, worktreeFingerprint: await computeWorktreeFingerprint(this.options.cwd, entries),
    }
    return {
      task: input.task, currentDecision: input.packet, workspace, workingTree,
      diffSummary: (await readWorkspaceGit(this.options.cwd, 'diff')) || workingTree, changedFiles: report.changedFiles,
      knownTestResults: input.task.lastReport?.verificationResults ?? report.verificationResults,
      testEvidenceFreshness: 'historical; reverify after partial edits',
      commandsAlreadyExecuted: [...(input.task.lastReport?.commandsRun ?? []), ...report.commandsRun],
      codexExecutionSummary: report.summary,
      unresolvedFailures: (input.task.lastReport?.verificationResults ?? []).filter((r) => r.status !== 'passed').map((r) => r.details ?? r.name),
      reviewerFeedback: input.packet, verificationRequirements: input.packet.verification,
      ...(input.task.approvedVerificationCommand === undefined ? {} : { approvedVerificationCommand: input.task.approvedVerificationCommand }),
    }
  }
}
