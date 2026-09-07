/**
 * Production Legacy Adoption Entry Point
 *
 * This is deliberately narrower than generic recovery: it recognizes only the
 * original pre-existing dirty worktree suspension, binds persisted Task identity
 * to trusted config facts, and enters through the existing W003 recovery API.
 */

import type { GuardianTaskRecoveryCheckpoint } from './checkpoint.js'
import {
  adoptLegacyRecoveryCheckpoint,
  LEGACY_PRE_EXISTING_DIRTY_REASON,
  type LegacyRecoveryGitRunner,
} from './legacy-recovery.js'
import type { WorkSessionDurableState } from './model.js'
import {
  validateTrustedWorkSessionConfig,
  type TrustedWorkSessionConfig,
} from './production.js'

export interface ProductionLegacyAdoptionRuntime {
  loadPersistedState(): Promise<WorkSessionDurableState | undefined>
  resumeFromRecoveryCheckpoint(options: {
    sessionId: string
    checkpoint: GuardianTaskRecoveryCheckpoint
  }): Promise<WorkSessionDurableState>
}

export interface ProductionLegacyAdoptionSummary {
  sessionId: string
  taskId: string
  repoPath: string
  adoptedFiles: number
}

export interface ProductionLegacyAdoptionResult extends ProductionLegacyAdoptionSummary {
  finalState: WorkSessionDurableState
}

export interface ProductionLegacyAdoptionDependencies {
  gitRunner?: LegacyRecoveryGitRunner
  onAdopted?: (summary: ProductionLegacyAdoptionSummary) => void
  onRecoveryStarted?: () => void
}

export async function adoptProductionLegacyWorkSession(
  config: TrustedWorkSessionConfig,
  runtime: ProductionLegacyAdoptionRuntime,
  dependencies: ProductionLegacyAdoptionDependencies = {},
): Promise<ProductionLegacyAdoptionResult> {
  const trusted = await validateTrustedWorkSessionConfig(config)
  const persisted = await runtime.loadPersistedState()
  if (persisted === undefined) {
    throw new Error(`Legacy adoption rejected: session ${trusted.session.id} does not exist`)
  }
  if (persisted.sessionId !== trusted.session.id) {
    throw new Error('Legacy adoption rejected: persisted session identity mismatch')
  }
  if (persisted.state !== 'SUSPENDED') {
    throw new Error(`Legacy adoption rejected: session state is ${persisted.state}`)
  }
  if (typeof persisted.currentTaskId !== 'string' || persisted.currentTaskId.length === 0) {
    throw new Error('Legacy adoption rejected: suspended session has no current Task')
  }
  if (persisted.humanRequired?.category !== 'REPO_DRIFT') {
    throw new Error('Legacy adoption rejected: session is not suspended for REPO_DRIFT')
  }
  if (persisted.humanRequired.reason !== LEGACY_PRE_EXISTING_DIRTY_REASON) {
    throw new Error('Legacy adoption rejected: REPO_DRIFT is not the legacy pre-existing dirty case')
  }

  const currentTaskId = persisted.currentTaskId
  const trustedTask = trusted.tasks.find((task) => task.id === currentTaskId)
  if (trustedTask === undefined) {
    throw new Error(`Legacy adoption rejected: current Task ${currentTaskId} is absent from trusted config`)
  }

  const checkpoint = await adoptLegacyRecoveryCheckpoint({
    task: {
      id: trustedTask.id,
      goal: trustedTask.goal,
      constraints: trustedTask.guardian.constraints,
      acceptanceCriteria: trustedTask.guardian.acceptanceCriteria,
      doNotDo: trustedTask.guardian.doNotDo,
      allowedPaths: trustedTask.guardian.allowedPaths,
      forbiddenPaths: trustedTask.guardian.forbiddenPaths,
    },
    repoPath: trusted.session.targetRepo,
    ...(dependencies.gitRunner === undefined ? {} : { gitRunner: dependencies.gitRunner }),
  })

  if (checkpoint.task.id !== currentTaskId) {
    throw new Error('Legacy adoption rejected: adopted checkpoint Task identity mismatch')
  }
  if (checkpoint.repo.repoPath !== trusted.session.targetRepo) {
    throw new Error('Legacy adoption rejected: adopted checkpoint repository mismatch')
  }
  if (checkpoint.repo.branch !== trusted.session.branch) {
    throw new Error('Legacy adoption rejected: adopted checkpoint branch mismatch')
  }

  const summary: ProductionLegacyAdoptionSummary = {
    sessionId: trusted.session.id,
    taskId: currentTaskId,
    repoPath: trusted.session.targetRepo,
    adoptedFiles: checkpoint.repo.changedFiles.length,
  }
  dependencies.onAdopted?.(summary)
  dependencies.onRecoveryStarted?.()

  const finalState = await runtime.resumeFromRecoveryCheckpoint({
    sessionId: trusted.session.id,
    checkpoint,
  })
  return { ...summary, finalState }
}
