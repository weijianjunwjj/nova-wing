import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeOfferFlowHost } from 'nova-wing/testing'
import { createHarness, createTestWorkspace } from './helpers.js'

test('fake host proposal, user approval, atomic update, and host reread form the v0.1 loop', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'fake-host')
  const host = new FakeOfferFlowHost(facade)

  const proposal = host.submitMainlineProposal({
    action: 'set',
    memoryKey: 'career.job_selection_priority',
    category: 'priority',
    assertionType: 'user_decision',
    scope: 'career',
    proposedStatement: '优先选择与长期方向一致的岗位。',
    rationale: '该原则会影响多个后续岗位判断。',
    evidence: {
      summary: '连续三次复盘显示稳定现金流是当前阶段约束。',
      sourceRef: 'fake-offerflow://evidence/weekly-review-1',
    },
  })

  assert.equal(proposal.status, 'pending')
  assert.equal(facade.listProposals().some((item) => item.status === 'draft'), false)
  assert.deepEqual(host.readLatestMainline(), { coreRevision: 0, entries: [] })

  facade.editPendingProposal({
    proposalId: proposal.id,
    statement: '当前阶段优先恢复稳定现金流，同时保留长期方向。',
  })
  const approval = facade.approveProposal({
    proposalId: proposal.id,
    reviewNote: '用户确认修改后的表述',
  })
  const reread = host.readLatestMainline(['career'])

  assert.equal(approval.coreRevision, 1)
  assert.equal(reread.coreRevision, 1)
  assert.equal(reread.entries.length, 1)
  assert.equal(reread.entries[0]?.statement, '当前阶段优先恢复稳定现金流，同时保留长期方向。')
  assert.equal(facade.getProposal(proposal.id)?.sourceSystem, 'fake-offerflow-host')
})

test('fake host cannot observe a rejected proposal as current mainline', (t) => {
  const workspace = createTestWorkspace(t)
  const { facade } = createHarness(workspace, 'fake-host-reject')
  const host = new FakeOfferFlowHost(facade)
  const proposal = host.submitMainlineProposal({
    action: 'set',
    memoryKey: 'global.current_phase',
    category: 'phase',
    assertionType: 'working_hypothesis',
    scope: 'global',
    proposedStatement: '这只是待确认假设。',
    rationale: '需要用户判断是否长期有效。',
    evidence: { summary: '单次假宿主观察。' },
  })

  facade.rejectProposal({ proposalId: proposal.id, reviewNote: '不晋升为长期主线' })

  assert.deepEqual(host.readLatestMainline(), { coreRevision: 0, entries: [] })
})
