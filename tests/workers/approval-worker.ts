import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import { createNovaWingFacade, isNovaWingError } from 'nova-wing/core'
import {
  createInjectedSqliteNovaWingStore,
  type SqliteNovaWingStore,
} from 'nova-wing/sqlite'

interface ApprovalWorkerData {
  controlBuffer: SharedArrayBuffer
  databasePath: string
  proposalId: string
}

export type ApprovalWorkerResult =
  | { kind: 'approved'; coreRevision: number }
  | { kind: 'domain-error'; code: string }
  | { kind: 'unexpected-error'; message: string }

const data = workerData as ApprovalWorkerData
const control = new Int32Array(data.controlBuffer)
let store: SqliteNovaWingStore | undefined
let connection: DatabaseSync | undefined
let readySignaled = false

function postResult(result: ApprovalWorkerResult): void {
  parentPort?.postMessage(result)
}

try {
  connection = new DatabaseSync(data.databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 100,
  })
  store = createInjectedSqliteNovaWingStore({
    connection,
    migrationMode: 'validate',
    busyTimeoutMs: 100,
    busyRetries: 10,
    busyRetryDelayMs: 5,
  })
  const facade = createNovaWingFacade(store)
  Atomics.add(control, 0, 1)
  Atomics.notify(control, 0)
  readySignaled = true
  Atomics.wait(control, 1, 0)

  try {
    const approval = facade.approveProposal({ proposalId: data.proposalId })
    postResult({ kind: 'approved', coreRevision: approval.coreRevision })
  } catch (error: unknown) {
    if (isNovaWingError(error)) {
      postResult({ kind: 'domain-error', code: error.code })
    } else {
      postResult({
        kind: 'unexpected-error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
} catch (error: unknown) {
  if (!readySignaled) {
    Atomics.add(control, 0, 1)
    Atomics.notify(control, 0)
  }
  postResult({
    kind: 'unexpected-error',
    message: error instanceof Error ? error.message : String(error),
  })
} finally {
  store?.close()
  if (connection?.isOpen === true) {
    connection.close()
  }
}

