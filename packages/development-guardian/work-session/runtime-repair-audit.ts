import { platformPaths } from '../platform/paths.js'
/**
 * NovaWing v0.2.4 — Runtime Repair append-only audit log.
 *
 * 记录 RUNTIME_REPAIR_STARTED / DIAGNOSED / PROPOSED / VALIDATED / APPLIED /
 * FAILED / SESSION_RESUMED_AFTER_REPAIR，以及原失败 action、implementer identity、
 * 选择的 reviewer identity、provider health、repair mechanism、validation result、
 * 是否重跑 Executor。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import type { RuntimeRepairAuditEventName } from './runtime-repair.js'
import type { RuntimeRepairOutcome, RuntimeRepairReasonCode } from './runtime-repair.js'
import type { TaskActorIdentity } from './task-state-v2.js'
import type { ProviderHealthObservation } from './task-observability.js'

export interface RuntimeRepairAuditEntry {
  event: RuntimeRepairAuditEventName
  sessionId: string
  taskId: string
  timestamp: string
  reasonCode: RuntimeRepairReasonCode
  failedAction?: string | undefined
  implementer?: TaskActorIdentity | undefined
  chosenReviewer?: TaskActorIdentity | undefined
  providerHealth?: readonly ProviderHealthObservation[] | undefined
  mechanism?: string | undefined
  validation?: { ok: boolean; reasons: readonly string[] } | undefined
  classification?: RuntimeRepairOutcome['classification'] | undefined
  reason?: string | undefined
  executorReran: boolean
}

export interface RuntimeRepairAuditSink {
  record(entry: RuntimeRepairAuditEntry): Promise<void>
}

export interface FileRuntimeRepairAuditOptions {
  path?: string
  append?: (path: string, line: string) => Promise<void>
  ensureDir?: (dir: string) => Promise<void>
}

export function defaultRuntimeRepairAuditPath(env: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  return platformPaths({ env, userHome }).runtimeRepairAudit
}

/** Append-only JSONL audit sink; never throws the underlying record into the request path. */
export function createFileRuntimeRepairAuditSink(options: FileRuntimeRepairAuditOptions = {}): RuntimeRepairAuditSink {
  const path = options.path ?? defaultRuntimeRepairAuditPath()
  const append = options.append ?? ((target, line) => appendFile(target, line, 'utf8'))
  const ensureDir = options.ensureDir ?? ((dir) => mkdir(dir, { recursive: true }))
  return {
    async record(entry) {
      await ensureDir(dirname(path))
      await append(path, `${JSON.stringify(entry)}\n`)
    },
  }
}

/** 测试注入的内存 sink。 */
export function createRecordingRuntimeRepairAuditSink(): { sink: RuntimeRepairAuditSink; entries: RuntimeRepairAuditEntry[] } {
  const entries: RuntimeRepairAuditEntry[] = []
  return {
    entries,
    sink: { async record(entry) { entries.push(entry) } },
  }
}
