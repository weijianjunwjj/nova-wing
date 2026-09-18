import { platformPaths } from '../../platform/paths.js'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

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

/**
 * One step of an unattended (Automatic Preflight Repair) cycle. These records
 * never contain a prompt, a credential, or a transport secret — only the cycle
 * number, the issue codes that were seen, and the deterministic outcome.
 */
export type AutoRepairAuditEventType =
  | 'AUTO_REPAIR_STARTED'
  | 'AUTO_REPAIR_DETERMINISTIC'
  | 'AUTO_REPAIR_LLM_STARTED'
  | 'AUTO_REPAIR_VALIDATED'
  | 'AUTO_REPAIR_SUCCEEDED'
  | 'AUTO_REPAIR_FAILED'

export interface AutoRepairAuditEvent {
  event: AutoRepairAuditEventType
  /** 1-based repair cycle; the cascade names one strategy per cycle. */
  cycle: number
  issueCodes: readonly string[]
  /** Present on AUTO_REPAIR_DETERMINISTIC: whether the deterministic agent resolved everything it was given. */
  deterministicResolved?: boolean
  /** Present on AUTO_REPAIR_LLM_STARTED. */
  llmInvoked?: boolean
  provider?: RepairProviderIdentity
  validation?: RepairValidationResult
  /** Whether the contract that left this cycle passed preflight. */
  reflightPassed?: boolean
  reason?: string
}

/** Summary of an unattended repair run attached to the audit entry. */
export interface AutoRepairAuditSummary {
  maxCycles: number
  cycles: number
  /** True when the cycle bound was reached without a launch. */
  exhausted: boolean
  events: readonly AutoRepairAuditEvent[]
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
  /** True when the Launchpad started this repair without an operator click. */
  automatic?: boolean
  /** Present only for automatic repairs. */
  autoRepair?: AutoRepairAuditSummary
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
  return platformPaths({ env, userHome }).repairAudit
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
