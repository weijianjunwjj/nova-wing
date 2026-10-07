import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOwnedImplementationCheckpoint, consumeOwnedImplementationCheckpoint,
  implementationCheckpointHandoff, inspectImplementationRepository } from '../packages/development-guardian/work-session/implementation-checkpoint.js'
import { createTaskStateV2, loadTaskStateV2 } from '../packages/development-guardian/work-session/task-state-v2.js'
import { V2ControllerTaskRunner } from '../packages/development-guardian/work-session/v2-controller-task-runner.js'

const exec = promisify(execFile)
const dispatch = { dispatchId: 'host-dispatch', action: 'VERIFY' as const }
async function fixture(t: TestContext, dirty = true) {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'nw-owned-checkpoint-')))
  t.after(() => rm(repo, { recursive: true, force: true }))
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo })).stdout.trimEnd()
  await git('init', '-q', '-b', 'codex/owned-fixture')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@example.invalid')
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'src/feature.txt'), 'before\n')
  await git('add', '--', 'src/feature.txt')
  await git('commit', '-qm', 'baseline')
  const baseline = await git('rev-parse', 'HEAD')
  const definition = { id: 'T1', goal: 'implement', allowedPaths: ['src/**'], forbiddenPaths: ['src/secret.txt'],
    risk: 'HIGH' as const, acceptanceCriteria: ['proof'], acceptanceEvidenceBindings: [{ criterion: 'proof', requiredEvidence: ['test'] }] }
  if (dirty) await writeFile(join(repo, 'src/feature.txt'), 'implementation\n')
  const task = { ...createTaskStateV2({ id: 's', branch: 'codex/owned-fixture' }, definition),
    attemptId: 'a'.repeat(64), gitState: await inspectImplementationRepository(repo) }
  return { repo, git, baseline, task, definition }
}

test('owned checkpoint consumes once, persists audit and invalidates every old completion fact', async (t) => {
  const f = await fixture(t)
  const old = { ...f.task, verificationState: { results: [{ name: 'old', status: 'passed' as const }],
    evidenceHeadSha: f.baseline, evidenceWorktreeFingerprint: f.task.gitState.worktreeFingerprint },
    completion: { ...f.task.completion, evidence: [{ type: 'old', status: 'PASSED' as const, source: 'old', timestamp: 'old' }],
      approval: { approved: true, reviewedCommit: f.baseline, workspaceIdentity: 'old', risk: 'HIGH' as const, timestamp: 'old' },
      review: { passed: true, findings: [], severity: 'HIGH' as const, blockingFindings: [], reviewedCommit: f.baseline,
        reviewer: { agent: 'r', provider: 'r', runtimeIdentity: 'r' }, implementer: { agent: 'e', provider: 'e', runtimeIdentity: 'e' },
        reviewedFiles: [], timestamp: 'old' } } }
  const authority = await createOwnedImplementationCheckpoint(old, dispatch, f.baseline)
  assert.ok(authority)
  const accepted = await consumeOwnedImplementationCheckpoint(authority, old, dispatch)
  assert.notEqual(accepted.gitState.headSha, f.baseline)
  assert.deepEqual(accepted.verificationState, { results: [] })
  assert.deepEqual(accepted.completion, { bindings: old.completion.bindings, evidence: [] })
  assert.deepEqual(accepted.gitState, await inspectImplementationRepository(f.repo))
  const persisted = loadTaskStateV2(JSON.parse(JSON.stringify(accepted)))
  assert.deepEqual(persisted.implementationCheckpoints, accepted.implementationCheckpoints)
  assert.equal(persisted.implementationCheckpoints![0]!.attemptId, old.attemptId)
  for (const fake of [accepted.gitState.headSha, {}, structuredClone(authority), JSON.parse(JSON.stringify(authority)),
    persisted.implementationCheckpoints![0], authority]) {
    await assert.rejects(consumeOwnedImplementationCheckpoint(fake, old, dispatch), /authority is absent or consumed/u)
  }
})

for (const field of ['session', 'task', 'attempt', 'dispatch', 'action', 'before', 'scope'] as const) {
  test(`owned checkpoint rejects mismatched ${field} binding and burns the credential`, async (t) => {
    const f = await fixture(t)
    const authority = await createOwnedImplementationCheckpoint(f.task, dispatch, f.baseline)
    const task = structuredClone(f.task)
    const binding = { ...dispatch }
    if (field === 'session') task.identity.sessionId = 'other'
    if (field === 'task') task.identity.taskId = 'other'
    if (field === 'attempt') task.attemptId = 'b'.repeat(64)
    if (field === 'dispatch') binding.dispatchId = 'other'
    if (field === 'action') Object.assign(binding, { action: 'EXECUTE' })
    if (field === 'before') task.gitState.worktreeFingerprint = '0'.repeat(64)
    if (field === 'scope') task.permissions.allowedPaths = ['other/**']
    await assert.rejects(consumeOwnedImplementationCheckpoint(authority, task, binding), /binding mismatch/u)
    await assert.rejects(consumeOwnedImplementationCheckpoint(authority, f.task, dispatch), /authority/u)
  })
}

for (const change of ['parent', 'branch', 'tree', 'dirty', 'hardlink', 'identity'] as const) {
  test(`owned checkpoint rejects ${change} tampering after issuance`, async (t) => {
    const f = await fixture(t)
    const authority = await createOwnedImplementationCheckpoint(f.task, dispatch, f.baseline)
    if (change === 'branch') await f.git('symbolic-ref', 'HEAD', 'refs/heads/codex/other')
    if (change === 'parent' || change === 'tree') {
      let tree = await f.git('rev-parse', 'HEAD^{tree}')
      if (change === 'tree') {
        await writeFile(join(f.repo, 'src/feature.txt'), 'tampered\n')
        await f.git('add', '--', 'src/feature.txt')
        tree = await f.git('write-tree')
      }
      const commit = await f.git('commit-tree', tree, '-p', change === 'parent' ? await f.git('rev-parse', 'HEAD') : f.baseline,
        '-m', 'unowned replacement')
      await f.git('update-ref', 'HEAD', commit)
    }
    if (change === 'dirty') await writeFile(join(f.repo, 'src/feature.txt'), 'dirty\n')
    if (change === 'hardlink') {
      const destination = join(f.repo, '.git/linked-content')
      await link(join(f.repo, 'src/feature.txt'), destination)
    }
    if (change === 'identity') await f.git('config', 'core.worktree', '../..')
    await assert.rejects(consumeOwnedImplementationCheckpoint(authority, f.task, dispatch))
  })
}

for (const pathKind of ['outside', 'forbidden', 'symlink', 'ancestor-symlink', 'hardlink', 'traversal'] as const) {
  test(`owned checkpoint excludes ${pathKind} before commit`, async (t) => {
    const f = await fixture(t, false)
    if (pathKind === 'outside') await writeFile(join(f.repo, 'outside.txt'), 'outside\n')
    if (pathKind === 'forbidden') await writeFile(join(f.repo, 'src/secret.txt'), 'forbidden\n')
    if (pathKind === 'symlink') await symlink('feature.txt', join(f.repo, 'src/link.txt'))
    if (pathKind === 'ancestor-symlink') {
      await mkdir(join(f.repo, '.git/hidden'))
      await writeFile(join(f.repo, '.git/hidden/hidden.txt'), 'outside\n')
      await symlink('../.git/hidden', join(f.repo, 'src/link-dir'))
    }
    if (pathKind === 'hardlink') await link(join(f.repo, 'src/feature.txt'), join(f.repo, 'src/hard.txt'))
    f.task.gitState = await inspectImplementationRepository(f.repo)
    if (pathKind === 'traversal') f.task.gitState.changedFiles = ['src/../outside.txt']
    await assert.rejects(createOwnedImplementationCheckpoint(f.task, dispatch, f.baseline))
    assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline)
    assert.equal(await f.git('diff', '--cached', '--name-only'), '')
  })
}

test('commit hook tree substitution fails closed without restoring an ambiguous HEAD', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.repo, '.git/hooks/pre-commit'),
    '#!/bin/sh\nprintf "hook tamper\\n" > src/feature.txt\ngit add -- src/feature.txt\n', { mode: 0o755 })
  await assert.rejects(createOwnedImplementationCheckpoint(f.task, dispatch, f.baseline), /tree.*mismatch/u)
  assert.notEqual(await f.git('rev-parse', 'HEAD'), f.baseline)
})

test('no-op handoff creates no authority or audit and callback expires after dispatch', async (t) => {
  const f = await fixture(t, false)
  assert.equal(await createOwnedImplementationCheckpoint(f.task, dispatch, f.baseline), undefined)
  let writes = 0
  const handoff = implementationCheckpointHandoff({ getState: () => f.task,
    setState() { writes++ }, async persist() { writes++ } })
  const accepted = await handoff.checkpoint(f.baseline)
  assert.equal(accepted.implementationCheckpoints, undefined)
  assert.equal(writes, 0)
  assert.equal(await f.git('rev-parse', 'HEAD'), f.baseline)
  await assert.rejects(handoff.checkpoint(f.baseline), /consumed/u)
  const closed = implementationCheckpointHandoff({ getState: () => f.task, setState() { writes++ } })
  closed.close()
  await assert.rejects(closed.checkpoint(f.baseline), /closed/u)
})

test('owned checkpoint handles literal pathspec names, deletion and rename content without scope widening', async (t) => {
  const f = await fixture(t, false)
  f.task.permissions.allowedPaths = ['.']
  await f.git('config', 'diff.renames', 'true')
  await rm(join(f.repo, 'src/feature.txt'))
  await writeFile(join(f.repo, 'src/renamed feature.txt'), 'before\n')
  await writeFile(join(f.repo, ':(glob)*.txt'), 'literal filename\n')
  f.task.gitState = await inspectImplementationRepository(f.repo)
  const authority = await createOwnedImplementationCheckpoint(f.task, dispatch, f.baseline)
  const accepted = await consumeOwnedImplementationCheckpoint(authority, f.task, dispatch)
  assert.deepEqual([...accepted.implementationCheckpoints![0]!.changedFiles].sort(),
    [':(glob)*.txt', 'src/feature.txt', 'src/renamed feature.txt'].sort())
  assert.equal(await f.git('status', '--porcelain'), '')
})

test('lost ownership or persistence failure leaves descendants blocked on Controller restart', async (t) => {
  const f = await fixture(t)
  const handoff = implementationCheckpointHandoff({ getState: () => f.task,
    setState() { assert.fail('failed persistence must not adopt HEAD') }, async persist() { throw new Error('crash before persistence') } })
  await assert.rejects(handoff.checkpoint(f.baseline), /crash/u)
  assert.notEqual(await f.git('rev-parse', 'HEAD'), f.baseline)
  const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'codex/owned-fixture', agents: [], dispatcher: {
    inspectRepository: () => inspectImplementationRepository(f.repo), dispatch: async () => { throw new Error('must not dispatch') } } })
  const restarted = await runner.run(f.definition, undefined, undefined, { taskStateV2: f.task })
  assert.equal(restarted.humanRequired?.category, 'REPO_DRIFT')
})

for (const representation of ['SHA', 'object', 'persisted-record'] as const) {
  test(`Controller refuses an unowned descendant reported as ${representation}`, async (t) => {
    const f = await fixture(t)
    const state = { ...f.task, status: 'ACTIVE' as const }
    const runner = new V2ControllerTaskRunner({ sessionId: 's', branch: 'codex/owned-fixture',
      agents: [{ id: 'verifier', available: true, quotaExhausted: false, degraded: false, capabilities: { verification: true } }],
      dispatcher: { inspectRepository: () => inspectImplementationRepository(f.repo), async dispatch({ action }) {
        assert.equal(action, 'VERIFY')
        await f.git('add', '--', 'src/feature.txt')
        await f.git('commit', '-qm', 'model-reported commit')
        const after = await inspectImplementationRepository(f.repo)
        const record = { ...f.task.identity, ...dispatch, before: f.task.gitState, after,
          implementationCommit: after.headSha }
        return { status: 'SUCCESS', verificationResults: [{ name: 'test', status: 'passed' }],
          implementationCheckpoint: representation === 'SHA' ? after.headSha : representation === 'object' ? record :
            JSON.parse(JSON.stringify(record)) }
      } } })
    const result = await runner.run(f.definition, undefined, undefined, { taskStateV2: state })
    assert.equal(result.humanRequired?.category, 'REPO_DRIFT')
    assert.equal(result.taskStateV2?.implementationCheckpoints, undefined)
    assert.deepEqual(result.taskStateV2?.verificationState.results, [])
    assert.equal(await f.git('show', '-s', '--format=%P', 'HEAD'), f.baseline)
    assert.notEqual(await f.git('rev-parse', 'HEAD'), f.baseline)
  })
}
