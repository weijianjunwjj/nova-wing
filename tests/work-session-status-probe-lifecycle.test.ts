import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

async function fixture(scheduled: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'novawing-status-probe-'))
  const database = join(directory, 'session.db')
  await writeFile(database, '')
  await writeFile(join(directory, 'session.json'), JSON.stringify({
    session: { id: 'status-probe', targetRepo: process.cwd(), branch: 'feat/v0.4-desktop',
      limits: { softMinutes: 10, hardMinutes: 20, maxTasks: 1 },
      ...(scheduled ? { scheduledStartAt: '2099-01-01T00:00:00.000Z', scheduleSource: 'custom' } : {}) },
    tasks: [{ id: 'T1', goal: 'read-only status probe', guardian: { constraints: [], acceptanceCriteria: [],
      doNotDo: [], allowedPaths: ['src/**'], forbiddenPaths: [] } }],
    gitCheckpoint: { autoCommit: false, autoPush: false },
    executor: { model: 'test', maxTurns: 1, allowNpmInstall: false, allowPythonBootstrap: false },
    storageUrl: pathToFileURL(database).href,
  }))
  return directory
}

function runProbe(directory: string, scenario: string): Promise<{ code: number | null; output: string }> {
  const script = fileURLToPath(new URL('./work-session-status-probe-fixture.js', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, directory, scenario], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}

for (const scenario of ['cleanup', 'load-and-cleanup', 'scheduled-cleanup']) {
  await test(`read-only status probe ${scenario} errors survive real storage cleanup`, async () => {
    const directory = await fixture(scenario === 'scheduled-cleanup')
    try {
      // Native libSQL handles are process-owned on Windows. Exercise the actual
      // runtime cleanup and error contract, then wait for worker exit before rm.
      const result = await runProbe(directory, scenario)
      assert.equal(result.code, 0, result.output)
      assert.match(result.output, /STATUS_PROBE_LIFECYCLE_PASS/u)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
