import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { detachedSmokeProcess, smokeEnvironment, terminateOwnedElectron } from './platform/desktop-smoke-environment.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const evidenceDirectory = join(repositoryRoot, 'artifacts', 'desktop', 'bootstrap-smoke')
const timeoutMs = 60_000
let electronPath
let expectedVersion

async function runElectron(entry, prefix, root) {
  const child = spawn(String(electronPath), [join(repositoryRoot, entry), `--user-data-dir=${join(root, 'electron-user-data')}`], {
    cwd: join(root, 'repo'), env: smokeEnvironment(root), shell: false,
    windowsHide: prefix !== 'DESKTOP_SHELL_RESULT', detached: detachedSmokeProcess, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const errors = []
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const exited = await new Promise((resolveExit) => {
    let settled = false
    const finish = (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveExit({ exitCode, signal })
    }
    const timer = setTimeout(async () => {
      timedOut = true
      try { await terminateOwnedElectron(child) } catch (error) { errors.push(String(error)); child.kill('SIGKILL') }
      // Bound even a broken OS/stdio close path; the timeout is always a failure.
      // Descendants can inherit pipes after their Main has exited. Do not let those
      // pipes hold the external runner open, and never broaden the kill target.
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      finish(child.exitCode, child.signalCode)
    }, timeoutMs)
    child.once('error', (error) => { errors.push(String(error)); finish(null, null) })
    child.once('close', finish)
  })
  const logName = basename(entry, '.mjs')
  await writeFile(join(evidenceDirectory, `${logName}.stdout.log`), stdout)
  await writeFile(join(evidenceDirectory, `${logName}.stderr.log`), stderr)
  let report
  try {
    const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(`${prefix} `))
    assert.equal(lines.length, 1, `Expected exactly one ${prefix} record`)
    report = JSON.parse(lines[0].slice(prefix.length + 1))
    assert.equal(report.result, 'PASS', 'Electron entry reported failure')
    assert.equal(exited.exitCode, 0, 'Electron must exit with code 0')
    assert.equal(exited.signal, null, 'Electron must exit without a signal')
    assert.equal(timedOut, false, 'Electron timed out')
    assert.equal(errors.length, 0)
    if (prefix === 'DESKTOP_COMPATIBILITY_RESULT') {
      assert.equal(report.environment?.electron, expectedVersion, 'Smoke must use the pinned Electron binary')
      for (const name of ['guardian_import', 'node_sqlite', 'libsql', 'runtime_create', 'fake_task', 'runtime_close', 'runtime_reopen', 'resources']) {
        assert.equal(report.checks?.[name]?.status, 'PASS', `Missing compatibility gate: ${name}`)
      }
    }
    // Electron-owned Chromium children are evidence only, never independent kill targets.
    for (const pid of report.childPids ?? []) {
      let alive = true
      for (let attempt = 0; attempt < 25 && alive; attempt++) {
        try { process.kill(pid, 0); await delay(100) } catch (error) {
          if (error.code === 'ESRCH') alive = false
          else throw error
        }
      }
      assert.equal(alive, false, `Electron child ${pid} survived app exit`)
    }
  } catch (error) { errors.push(String(error?.stack ?? error)) }
  return { entry, ...exited, timedOut, report, errors, result: errors.length === 0 ? 'PASS' : 'FAIL' }
}

const result = { name: 'DESKTOP_COMPATIBILITY_SMOKE', timeoutMs, runs: [], cleanup: {}, errors: [], result: 'FAIL' }
let root
let tempParent
try {
  await mkdir(evidenceDirectory, { recursive: true })
  assert.equal(process.versions.electron, undefined, 'Launch this runner with external Node')
  // Resolving metadata avoids Electron's lazy synchronous download (outside our timeout)
  // and does not honor ELECTRON_OVERRIDE_DIST_PATH from the calling shell.
  const electronDirectory = dirname(createRequire(import.meta.url).resolve('electron'))
  const executable = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim()
  electronPath = await realpath(join(electronDirectory, 'dist', executable))
  expectedVersion = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).devDependencies.electron
  tempParent = await realpath(tmpdir())
  root = await mkdtemp(join(tempParent, 'novawing-desktop-smoke-'))
  for (const directory of ['config', 'data', 'repo', 'home', 'tmp', 'home/roaming', 'home/local', 'home/config', 'home/data', 'home/cache']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  result.runs.push(await runElectron('desktop/tests/shell-smoke.mjs', 'DESKTOP_SHELL_RESULT', root))
  result.runs.push(await runElectron('desktop/tests/runtime-compatibility.mjs', 'DESKTOP_COMPATIBILITY_RESULT', root))
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
} finally {
  if (root) {
    try {
      // Verify the exact mkdtemp target before recursive deletion, including symlink identity.
      assert.equal(dirname(root), tempParent)
      assert.ok(basename(root).startsWith('novawing-desktop-smoke-'))
      assert.equal(await realpath(root), root)
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      result.cleanup = { status: 'PASS', temporaryRoot: root }
    } catch (error) {
      result.cleanup = { status: 'FAIL', code: error.code, temporaryRoot: root, error: String(error),
        phase: 'temporary_directory_cleanup_after_electron_exit' }
      result.errors.push(`Temporary directory cleanup failed: ${String(error)}`)
    }
  }
}
result.result = result.runs.length === 2 && result.runs.every((run) => run.result === 'PASS') &&
  result.cleanup.status === 'PASS' && result.errors.length === 0 ? 'PASS' : 'FAIL'
try {
  await writeFile(join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  result.result = 'FAIL'
  result.errors.push(`Cannot save result evidence: ${String(error)}`)
}
console.log(`DESKTOP_COMPATIBILITY_SMOKE ${JSON.stringify(result)}`)
process.exitCode = result.result === 'PASS' ? 0 : 1
