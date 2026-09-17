import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAutonomousRecoveryDiff, readAutonomousVerificationOutput } from '../packages/development-guardian/work-session/autonomous-recovery-evidence.js'

test('diagnosis receives tracked diff and untracked source, with external diff drivers disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v031-diff-evidence-'))
  try {
    await mkdir(join(directory, 'src'))
    await writeFile(join(directory, 'src', 'new.ts'), 'export const answer = 42\n')
    const calls: readonly string[][] = []
    const output = await readAutonomousRecoveryDiff(directory, async (args) => {
      (calls as string[][]).push([...args])
      return { exitCode: 0, stderr: '', stdout: args[0] === 'diff' ? '+tracked change\n' : '?? src/new.ts\0' }
    })
    assert.match(output, /tracked change/)
    assert.match(output, /src\/new.ts\nexport const answer = 42/)
    assert.deepEqual(calls[0], ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('diagnosis reads full verifier stdout/stderr only from the session artifact directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v031-verifier-evidence-'))
  try {
    const artifacts = join(directory, 'artifacts')
    await mkdir(artifacts)
    const path = join(artifacts, 'test.log')
    await writeFile(path, 'command: npm test\nexitCode: 1\n[stdout]\ntest started\n[stderr]\nexpected 2 but got 1\n')
    const result = { name: 'npm test', status: 'failed' as const, rawOutputRef: path }
    const output = await readAutonomousVerificationOutput(artifacts, result)
    assert.match(output!, /\[stdout\]\ntest started/)
    assert.match(output!, /\[stderr\]\nexpected 2 but got 1/)
    const external = join(directory, 'private.log')
    await writeFile(external, 'must not read')
    await assert.rejects(readAutonomousVerificationOutput(artifacts, { ...result, rawOutputRef: external }), /outside/)
    assert.equal(await readAutonomousVerificationOutput(artifacts, { name: 'npm test', status: 'failed' }), undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
