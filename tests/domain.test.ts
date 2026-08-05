import assert from 'node:assert/strict'
import test from 'node:test'

import { NovaWingError } from 'nova-wing/core'
import { createHarness, createPending, createTestWorkspace, manualSetInput } from './helpers.js'

function hasCode(code: NovaWingError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof NovaWingError && error.code === code
}

test('MemoryKey accepts only stable global/career namespaces', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'memory-key')
  assert.equal(facade.createProposal(manualSetInput()).memoryKey, 'global.current_phase')
  assert.equal(
    facade.createProposal(
      manualSetInput({
        memoryKey: 'career.job-selection_priority',
        scope: 'career',
      }),
    ).memoryKey,
    'career.job-selection_priority',
  )
  assert.throws(
    () => facade.createProposal(manualSetInput({ memoryKey: 'offerflow.strategy_window' })),
    hasCode('INVALID_MEMORY_KEY'),
  )
  assert.throws(
    () => facade.createProposal(manualSetInput({ memoryKey: 'career.X', scope: 'career' })),
    hasCode('INVALID_MEMORY_KEY'),
  )
})

test('proposal validation keeps scope, action, source, and statement coherent', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'validation')
  assert.throws(
    () => facade.createProposal(manualSetInput({ scope: 'career' })),
    hasCode('INVALID_PROPOSAL'),
  )
  assert.throws(
    () =>
      facade.createProposal(
        manualSetInput({ action: 'deprecate', proposedStatement: 'not allowed' }),
      ),
    hasCode('INVALID_PROPOSAL'),
  )
  assert.throws(
    () => facade.createProposal(manualSetInput({ sourceType: 'host' })),
    hasCode('INVALID_PROPOSAL'),
  )
})

test('proposal state machine rejects skipped and terminal transitions', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'transition')
  const draft = facade.createProposal(manualSetInput())
  assert.throws(
    () => facade.approveProposal({ proposalId: draft.id }),
    hasCode('INVALID_PROPOSAL_TRANSITION'),
  )
  assert.equal(facade.submitProposal(draft.id).status, 'pending')
  assert.equal(facade.rejectProposal({ proposalId: draft.id }).status, 'rejected')
  assert.throws(
    () => facade.rejectProposal({ proposalId: draft.id }),
    hasCode('PROPOSAL_ALREADY_REJECTED'),
  )
})

test('draft is submitted, pending statement is edited, and edited text is approved', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'edit')
  const proposalId = createPending(facade)

  const edited = facade.editPendingProposal({
    proposalId,
    statement: '当前阶段优先恢复稳定现金流。',
  })
  assert.equal(edited.status, 'pending')
  assert.equal(edited.editedStatement, '当前阶段优先恢复稳定现金流。')
  assert.equal(edited.proposedStatement, '当前阶段优先建立稳定节奏。')

  const result = facade.approveProposal({ proposalId })
  assert.equal(result.coreRevision, 1)
  assert.equal(facade.listCurrentMainline().entries[0]?.statement, edited.editedStatement)
})

test('terminal proposal transitions fail explicitly', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'terminal')
  const approvedId = createPending(facade)
  facade.approveProposal({ proposalId: approvedId })

  assert.throws(
    () => facade.approveProposal({ proposalId: approvedId }),
    hasCode('PROPOSAL_ALREADY_APPROVED'),
  )
  assert.throws(
    () => facade.rejectProposal({ proposalId: approvedId }),
    hasCode('PROPOSAL_ALREADY_APPROVED'),
  )

  const rejectedId = createPending(
    facade,
    manualSetInput({
      memoryKey: 'global.product_priority',
      category: 'priority',
    }),
  )
  facade.rejectProposal({ proposalId: rejectedId, reviewNote: '证据不足' })
  assert.throws(
    () => facade.approveProposal({ proposalId: rejectedId }),
    hasCode('PROPOSAL_ALREADY_REJECTED'),
  )
  assert.equal(facade.getCurrentCoreRevision(), 1)
})

test('a rejected proposal never changes current mainline or revision', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'reject')
  const proposalId = createPending(facade)

  const rejected = facade.rejectProposal({ proposalId, reviewNote: '用户拒绝' })

  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.reviewNote, '用户拒绝')
  assert.deepEqual(facade.listCurrentMainline(), { coreRevision: 0, entries: [] })
})
