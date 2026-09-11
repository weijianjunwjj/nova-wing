import { createHash } from 'node:crypto'

import type { WorkSessionTask } from './model.js'
import type { RepositoryReality } from './reconciliation.js'
import type { TaskStateV2 } from './task-state-v2.js'

export type StrictLearningStage =
  | 'EXPLANATION_REQUIRED'
  | 'MANUAL_CHANGE_REQUIRED'
  | 'MANUAL_VERIFY'
  | 'MANUAL_FIX_REQUIRED'
  | 'COMPLETE'

export interface StrictLearningContract {
  mode: 'STRICT'
  objective: string
  predictions: readonly string[]
  unknowns: readonly string[]
  manualPath: string
  manualChallenge: string
  maxFiles: number
}

export interface LearningGateIssue {
  code:
    | 'OBJECTIVE_REQUIRED'
    | 'PREDICTION_REQUIRED'
    | 'UNKNOWN_REQUIRED'
    | 'MANUAL_PATH_REQUIRED'
    | 'MANUAL_PATH_INVALID'
    | 'MANUAL_CHALLENGE_REQUIRED'
    | 'MAX_FILES_REQUIRED'
    | 'MAX_FILES_INVALID'
  reason: string
}

export type StrictLearningContractResult =
  | { enabled: false }
  | { enabled: true; ok: true; contract: StrictLearningContract }
  | { enabled: true; ok: false; issues: readonly LearningGateIssue[] }

const PREFIX = {
  mode: 'LEARNING_MODE:',
  objective: 'LEARNING_OBJECTIVE:',
  prediction: 'LEARNING_PREDICTION:',
  unknown: 'LEARNING_UNKNOWN:',
  manualPath: 'LEARNING_MANUAL_PATH:',
  manualChallenge: 'LEARNING_MANUAL_CHALLENGE:',
  maxFiles: 'LEARNING_MAX_FILES:',
} as const

const STAGE_PREFIX = '@learning:stage='
const BASELINE_PREFIX = '@learning:baseline='
const EXPLANATION_PREFIX = '@learning:explanation='
const MANUAL_FINGERPRINT_PREFIX = '@learning:manual-fingerprint='

function valueAfter(constraint: string, prefix: string): string | undefined {
  const trimmed = constraint.trim()
  if (!trimmed.toLocaleUpperCase('en-US').startsWith(prefix)) return undefined
  const value = trimmed.slice(prefix.length).trim()
  return value.length === 0 ? undefined : value
}

function valuesAfter(constraints: readonly string[], prefix: string): string[] {
  return constraints.flatMap((constraint) => {
    const value = valueAfter(constraint, prefix)
    return value === undefined ? [] : [value]
  })
}

function firstAfter(constraints: readonly string[], prefix: string): string | undefined {
  return valuesAfter(constraints, prefix)[0]
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 &&
    !/^(?:[A-Za-z]:[\\/]|\/)/u.test(value) &&
    !value.split(/[\\/]/u).includes('..') &&
    !/[\u0000-\u001f]/u.test(value)
}

/**
 * Strict learning mode deliberately reuses trusted Task constraints so older
 * persisted Work Session schemas cannot silently drop the gate declaration.
 * The declaration is immutable for the lifetime of the Task.
 */
export function parseStrictLearningContract(task: Pick<WorkSessionTask, 'constraints'>): StrictLearningContractResult {
  const constraints = task.constraints ?? []
  const mode = firstAfter(constraints, PREFIX.mode)?.toLocaleUpperCase('en-US')
  if (mode !== 'STRICT') return { enabled: false }

  const issues: LearningGateIssue[] = []
  const objective = firstAfter(constraints, PREFIX.objective)
  const predictions = valuesAfter(constraints, PREFIX.prediction)
  const unknowns = valuesAfter(constraints, PREFIX.unknown)
  const manualPath = firstAfter(constraints, PREFIX.manualPath)
  const manualChallenge = firstAfter(constraints, PREFIX.manualChallenge)
  const maxFilesText = firstAfter(constraints, PREFIX.maxFiles)
  const maxFiles = maxFilesText === undefined ? Number.NaN : Number(maxFilesText)

  if (objective === undefined || objective.length < 20) {
    issues.push({ code: 'OBJECTIVE_REQUIRED', reason: 'Strict learning requires a concrete learning objective of at least 20 characters.' })
  }
  if (predictions.length < 2 || predictions.some((item) => item.length < 12)) {
    issues.push({ code: 'PREDICTION_REQUIRED', reason: 'Strict learning requires at least two pre-execution predictions, each at least 12 characters.' })
  }
  if (unknowns.length < 1 || unknowns.some((item) => item.length < 5)) {
    issues.push({ code: 'UNKNOWN_REQUIRED', reason: 'Strict learning requires at least one explicit unknown before execution.' })
  }
  if (manualPath === undefined) {
    issues.push({ code: 'MANUAL_PATH_REQUIRED', reason: 'Strict learning requires one exact file path for the manual change challenge.' })
  } else if (!isSafeRelativePath(manualPath)) {
    issues.push({ code: 'MANUAL_PATH_INVALID', reason: 'The manual change path must be a safe repository-relative path.' })
  }
  if (manualChallenge === undefined || manualChallenge.length < 15) {
    issues.push({ code: 'MANUAL_CHALLENGE_REQUIRED', reason: 'Strict learning requires a concrete manual change challenge of at least 15 characters.' })
  }
  if (maxFilesText === undefined) {
    issues.push({ code: 'MAX_FILES_REQUIRED', reason: 'Strict learning requires an explicit LEARNING_MAX_FILES limit.' })
  } else if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 6) {
    issues.push({ code: 'MAX_FILES_INVALID', reason: 'LEARNING_MAX_FILES must be an integer from 1 to 6.' })
  }

  if (issues.length > 0) return { enabled: true, ok: false, issues }
  return {
    enabled: true,
    ok: true,
    contract: {
      mode: 'STRICT',
      objective: objective!,
      predictions,
      unknowns,
      manualPath: manualPath!,
      manualChallenge: manualChallenge!,
      maxFiles,
    },
  }
}

export function strictLearningStage(task: TaskStateV2): StrictLearningStage | undefined {
  const marker = [...task.decisions].reverse().find((decision) => decision.startsWith(STAGE_PREFIX))
  const stage = marker?.slice(STAGE_PREFIX.length)
  return stage === 'EXPLANATION_REQUIRED' || stage === 'MANUAL_CHANGE_REQUIRED' ||
    stage === 'MANUAL_VERIFY' || stage === 'MANUAL_FIX_REQUIRED' || stage === 'COMPLETE'
    ? stage
    : undefined
}

export function strictLearningBaseline(task: TaskStateV2): string | undefined {
  const marker = [...task.decisions].reverse().find((decision) => decision.startsWith(BASELINE_PREFIX))
  return marker?.slice(BASELINE_PREFIX.length)
}

function withoutLearningStage(decisions: readonly string[]): string[] {
  return decisions.filter((decision) => !decision.startsWith(STAGE_PREFIX))
}

export function suspendForLearningExplanation(task: TaskStateV2): TaskStateV2 {
  const fingerprint = task.gitState.worktreeFingerprint
  if (fingerprint === undefined) throw new Error('strict learning requires a repository worktree fingerprint before explanation gate')
  return {
    ...task,
    status: 'SUSPENDED',
    currentAction: 'SUSPEND',
    blockers: ['LEARNING_EXPLANATION_REQUIRED'],
    decisions: [
      ...task.decisions.filter((decision) => !decision.startsWith(BASELINE_PREFIX) && !decision.startsWith(STAGE_PREFIX)),
      `${BASELINE_PREFIX}${fingerprint}`,
      `${STAGE_PREFIX}EXPLANATION_REQUIRED`,
    ],
    updatedAt: new Date().toISOString(),
  }
}

interface ExplanationSections {
  dataFlow: string
  why: string
  failure: string
  change: string
}

function explanationSections(value: string): ExplanationSections | undefined {
  const normalized = value.replace(/\r\n/gu, '\n').trim()
  const patterns = {
    dataFlow: /(?:^|\n)DATA_FLOW:\s*([^]*?)(?=\n(?:WHY|FAILURE|CHANGE):|$)/iu,
    why: /(?:^|\n)WHY:\s*([^]*?)(?=\n(?:DATA_FLOW|FAILURE|CHANGE):|$)/iu,
    failure: /(?:^|\n)FAILURE:\s*([^]*?)(?=\n(?:DATA_FLOW|WHY|CHANGE):|$)/iu,
    change: /(?:^|\n)CHANGE:\s*([^]*?)(?=\n(?:DATA_FLOW|WHY|FAILURE):|$)/iu,
  }
  const section = (pattern: RegExp): string | undefined => pattern.exec(normalized)?.[1]?.trim()
  const result = {
    dataFlow: section(patterns.dataFlow),
    why: section(patterns.why),
    failure: section(patterns.failure),
    change: section(patterns.change),
  }
  if (Object.values(result).some((item) => item === undefined || item.length < 20)) return undefined
  if (normalized.length < 160) return undefined
  return result as ExplanationSections
}

export function acceptLearningExplanation(task: TaskStateV2, decision: unknown): TaskStateV2 | undefined {
  if (strictLearningStage(task) !== 'EXPLANATION_REQUIRED' || typeof decision !== 'string') return undefined
  const sections = explanationSections(decision)
  if (sections === undefined) return undefined
  const digest = createHash('sha256').update(JSON.stringify(sections)).digest('hex').slice(0, 16)
  return {
    ...task,
    status: 'SUSPENDED',
    currentAction: 'SUSPEND',
    blockers: ['LEARNING_MANUAL_CHANGE_REQUIRED'],
    decisions: [
      ...withoutLearningStage(task.decisions),
      `${EXPLANATION_PREFIX}${digest}`,
      `${STAGE_PREFIX}MANUAL_CHANGE_REQUIRED`,
    ],
    updatedAt: new Date().toISOString(),
  }
}

export function inspectManualChange(input: {
  task: TaskStateV2
  contract: StrictLearningContract
  reality: RepositoryReality
}): { ok: true; task: TaskStateV2 } | { ok: false; reason: string } {
  const { task, contract, reality } = input
  const stage = strictLearningStage(task)
  if (stage !== 'MANUAL_CHANGE_REQUIRED' && stage !== 'MANUAL_FIX_REQUIRED') {
    return { ok: false, reason: 'manual change is not expected in the current learning stage' }
  }
  const baseline = strictLearningBaseline(task)
  if (baseline === undefined) return { ok: false, reason: 'learning baseline fingerprint is missing' }
  if (task.gitState.repositoryIdentity !== undefined && task.gitState.repositoryIdentity !== reality.repositoryIdentity) {
    return { ok: false, reason: 'repository identity changed during manual learning gate' }
  }
  if (task.gitState.branch !== undefined && task.gitState.branch !== reality.branch) {
    return { ok: false, reason: 'branch changed during manual learning gate' }
  }
  if (task.gitState.headSha !== undefined && task.gitState.headSha !== reality.headSha) {
    return { ok: false, reason: 'HEAD changed before learning gate released the commit' }
  }
  if (reality.worktreeFingerprint === task.gitState.worktreeFingerprint || reality.worktreeFingerprint === baseline) {
    return { ok: false, reason: 'workspace fingerprint did not change after the AI implementation was frozen' }
  }
  if (!reality.changedFiles.includes(contract.manualPath)) {
    return { ok: false, reason: `manual challenge must touch the declared path: ${contract.manualPath}` }
  }
  if (reality.changedFiles.length > contract.maxFiles) {
    return { ok: false, reason: `strict learning scope exceeded: ${reality.changedFiles.length} changed files > ${contract.maxFiles}` }
  }
  const taskWithManualChange: TaskStateV2 = {
    ...task,
    status: 'ACTIVE',
    currentAction: 'VERIFY',
    blockers: [],
    gitState: {
      repositoryIdentity: reality.repositoryIdentity,
      branch: reality.branch,
      headSha: reality.headSha,
      changedFiles: reality.changedFiles,
      worktreeFingerprint: reality.worktreeFingerprint,
    },
    // Any human code edit invalidates AI-era deterministic evidence and review.
    verificationState: { results: [] },
    completion: { ...task.completion, evidence: [], review: undefined, approval: undefined },
    decisions: [
      ...withoutLearningStage(task.decisions),
      `${MANUAL_FINGERPRINT_PREFIX}${reality.worktreeFingerprint}`,
      `${STAGE_PREFIX}MANUAL_VERIFY`,
    ],
    updatedAt: new Date().toISOString(),
  }
  return { ok: true, task: taskWithManualChange }
}

export function markManualFixRequired(task: TaskStateV2): TaskStateV2 {
  return {
    ...task,
    status: 'SUSPENDED',
    currentAction: 'SUSPEND',
    blockers: ['LEARNING_MANUAL_FIX_REQUIRED'],
    decisions: [...withoutLearningStage(task.decisions), `${STAGE_PREFIX}MANUAL_FIX_REQUIRED`],
    updatedAt: new Date().toISOString(),
  }
}

export function markStrictLearningComplete(task: TaskStateV2): TaskStateV2 {
  return {
    ...task,
    decisions: [...withoutLearningStage(task.decisions), `${STAGE_PREFIX}COMPLETE`],
    updatedAt: new Date().toISOString(),
  }
}

export function learningHumanRequired(stage: StrictLearningStage, detail?: string): { category: string; reason: string } {
  if (stage === 'EXPLANATION_REQUIRED') {
    return {
      category: 'LEARNING_EXPLANATION_REQUIRED',
      reason: detail ?? 'Explain the completed slice using DATA_FLOW, WHY, FAILURE, and CHANGE sections before AI execution may continue.',
    }
  }
  if (stage === 'MANUAL_CHANGE_REQUIRED') {
    return {
      category: 'LEARNING_MANUAL_CHANGE_REQUIRED',
      reason: detail ?? 'Complete the declared manual code challenge outside NovaWing. Executor access remains blocked.',
    }
  }
  if (stage === 'MANUAL_FIX_REQUIRED') {
    return {
      category: 'LEARNING_MANUAL_FIX_REQUIRED',
      reason: detail ?? 'The manual change failed deterministic verification. Fix it manually; Executor access remains blocked.',
    }
  }
  return {
    category: 'LEARNING_GATE_REQUIRED',
    reason: detail ?? 'Strict learning gate is not complete.',
  }
}
