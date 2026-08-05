import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

import { openSqliteNovaWingStore } from 'nova-wing/sqlite'

import { createHarness, createTestWorkspace, manualSetInput } from './helpers.js'
import type { ApprovalWorkerResult } from './workers/approval-worker.js'

const SAME_PROPOSAL_WORKERS = 8
const DIFFERENT_PROPOSAL_WORKERS = 6
const WORKER_READY_TIMEOUT_MS = 5_000

function startApprovalWorker(
  databasePath: string,
  proposalId: string,
  controlBuffer: SharedArrayBuffer,
): { result: Promise<ApprovalWorkerResult>; worker: Worker } {
  const worker = new Worker(new URL('./workers/approval-worker.js', import.meta.url), {
    execArgv: ['--no-warnings'],
    workerData: { controlBuffer, databasePath, proposalId },
  })
  const result = new Promise<ApprovalWorkerResult>((resolve, reject) => {
    let received: ApprovalWorkerResult | undefined
    worker.on('message', (message: ApprovalWorkerResult) => {
      received = message
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`approval worker exited with code ${String(code)}`))
      } else if (received === undefined) {
        reject(new Error('approval worker exited without a result'))
      } else {
        resolve(received)
      }
    })
  })
  return { result, worker }
}

function releaseWorkers(control: Int32Array, expectedWorkers: number): void {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS
  while (Atomics.load(control, 0) < expectedWorkers) {
    if (Date.now() >= deadline) {
      throw new Error(
        `only ${String(Atomics.load(control, 0))} of ${String(expectedWorkers)} workers became ready`,
      )
    }
    const observed = Atomics.load(control, 0)
    Atomics.wait(control, 0, observed, 100)
  }
  Atomics.store(control, 1, 1)
  Atomics.notify(control, 1, expectedWorkers)
}

async function runApprovalRace(
  databasePath: string,
  proposalIds: readonly string[],
): Promise<ApprovalWorkerResult[]> {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const control = new Int32Array(controlBuffer)
  const workers = proposalIds.map((proposalId) =>
    startApprovalWorker(databasePath, proposalId, controlBuffer),
  )
  try {
    releaseWorkers(control, workers.length)
    return await Promise.all(workers.map(({ result }) => result))
  } catch (error: unknown) {
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()))
    throw error
  }
}

test('eight workers approving one pending proposal apply it exactly once', async (t) => {
  const workspace = createTestWorkspace(t)
  const setup = createHarness(workspace, 'worker-same')
  const proposal = setup.facade.createPendingProposal(manualSetInput())
  setup.store.close()

  const results = await runApprovalRace(
    workspace.databasePath,
    Array.from({ length: SAME_PROPOSAL_WORKERS }, () => proposal.id),
  )

  assert.equal(results.filter((result) => result.kind === 'approved').length, 1)
  assert.equal(results.filter((result) => result.kind === 'domain-error').length, 7)
  assert.ok(
    results
      .filter((result): result is Extract<ApprovalWorkerResult, { kind: 'domain-error' }> =>
        result.kind === 'domain-error',
      )
      .every((result) => result.code === 'PROPOSAL_ALREADY_APPROVED'),
  )
  assert.equal(results.some((result) => result.kind === 'unexpected-error'), false)

  const finalStore = workspace.track(
    openSqliteNovaWingStore({ databasePath: workspace.databasePath }),
  )
  assert.equal(finalStore.getCurrentCoreRevision(), 1)
  assert.equal(finalStore.getProposal(proposal.id)?.status, 'approved')
  const inspector = workspace.track(new DatabaseSync(workspace.databasePath))
  assert.equal(
    (
      inspector.prepare('SELECT COUNT(*) AS count FROM nw_mainline_entries').get() as {
        count: number
      }
    ).count,
    1,
  )
})

test('six workers approving different proposals preserve every revision and entry', async (t) => {
  const workspace = createTestWorkspace(t)
  const setup = createHarness(workspace, 'worker-different')
  const proposals = Array.from({ length: DIFFERENT_PROPOSAL_WORKERS }, (_, index) =>
    setup.facade.createPendingProposal(
      manualSetInput({
        memoryKey: `global.concurrent_${String(index)}`,
        category: 'priority',
        proposedStatement: `并发主线 ${String(index)}`,
      }),
    ),
  )
  setup.store.close()

  const results = await runApprovalRace(
    workspace.databasePath,
    proposals.map((proposal) => proposal.id),
  )

  assert.equal(results.every((result) => result.kind === 'approved'), true)
  const revisions = results
    .filter((result): result is Extract<ApprovalWorkerResult, { kind: 'approved' }> =>
      result.kind === 'approved',
    )
    .map((result) => result.coreRevision)
    .sort((left, right) => left - right)
  assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6])

  const finalStore = workspace.track(
    openSqliteNovaWingStore({ databasePath: workspace.databasePath }),
  )
  assert.equal(finalStore.getCurrentCoreRevision(), DIFFERENT_PROPOSAL_WORKERS)
  assert.equal(finalStore.listCurrentMainline(['global']).length, DIFFERENT_PROPOSAL_WORKERS)
  assert.equal(
    proposals.every((proposal) => finalStore.getProposal(proposal.id)?.status === 'approved'),
    true,
  )
  const inspector = workspace.track(new DatabaseSync(workspace.databasePath))
  const persistedRevisions = inspector
    .prepare('SELECT core_revision FROM nw_mainline_entries ORDER BY core_revision')
    .all()
    .map((row) => row.core_revision)
  assert.deepEqual(persistedRevisions, [1, 2, 3, 4, 5, 6])
})

