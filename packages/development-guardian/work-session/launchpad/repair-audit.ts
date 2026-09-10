import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ContractRepairProposal, RepairClassification, RepairErrorCode, StructuredRepairTask } from './repair.js'

export interface RepairValidationResult {
  ok: boolean
  reasons: readonly string[]
}

/** One Repair Agent's contribution to an attempt, in execution order. */
export interface RepairAttemptStage {
  agent: 'deterministic' | 'llm'
  classification: RepairClassification
  repairs: readonly string[]
  reason?: string
  validation?: RepairValidationResult
  reflightPassed?: boolean
}

export interface RepairProviderIdentity {
  id: string
  model: string
  reasoningEffort?: string
}

/** One append-only record for a Repair & Retry attempt. */
export interface RepairAuditEntry {
  attemptId: string
  timestamp: string
  errorCode: RepairErrorCode
  targetRepo: string
  branch?: string
  /** Final outcome of the attempt. */
  classification: RepairClassification
  repairs: readonly string[]
  reason?: string
  /** Whether the contract that was finally applied passed preflight. */
  reflightPassed: boolean
  sessionStarted: boolean
  sessionId?: string
  structuredRepairTask?: StructuredRepairTask
  /** Whether the deterministic Repair Agent was consulted. */
  deterministicAttempted: boolean
  /** Whether the language-model Repair Agent was consulted. */
  llmInvoked: boolean
  provider?: RepairProviderIdentity
  /** The proposal that was actually applied, when one was. */
  proposal?: ContractRepairProposal
  /** Per-agent results, including every mechanical validation outcome. */
  stages: readonly RepairAttemptStage[]
  notification: { success: boolean; failure: boolean }
}

/** Durable sink; the Launchpad injects the production file sink, tests a recorder. */
export interface RepairAuditSink {
  record(entry: RepairAuditEntry): Promise<void>
}

export interface FileRepairAuditOptions {
  path?: string
  append?: (path: string, line: string) => Promise<void>
  ensureDir?: (dir: string) => Promise<void>
}

export function defaultRepairAuditPath(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const localAppData = env.LOCALAPPDATA?.trim() || join(userHome, 'AppData', 'Local')
  return join(localAppData, 'NovaWing', 'repair-audit.log')
}

/** Append-only JSONL audit log; never throws the underlying record into the request path. */
export function createFileRepairAuditSink(options: FileRepairAuditOptions = {}): RepairAuditSink {
  const path = options.path ?? defaultRepairAuditPath()
  const append = options.append ?? ((target, line) => appendFile(target, line, 'utf8'))
  const ensureDir = options.ensureDir ?? ((dir) => mkdir(dir, { recursive: true }))
  return {
    async record(entry) {
      await ensureDir(dirname(path))
      await append(path, `${JSON.stringify(entry)}\n`)
    },
  }
}
