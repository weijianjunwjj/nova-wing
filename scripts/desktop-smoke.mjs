import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { detachedSmokeProcess, smokeEnvironment, terminateOwnedElectron } from './platform/desktop-smoke-environment.mjs'
import { createDesktopIsolation, installedElectronBinary, repositoryRoot } from './desktop-isolation.mjs'

const evidenceDirectory = join(repositoryRoot, 'artifacts', 'desktop', 'bootstrap-smoke')
const timeoutMs = 60_000
let electronPath
let expectedVersion

async function runElectron(entry, prefix, root) {
  const child = spawn(String(electronPath), [join(repositoryRoot, entry), `--user-data-dir=${join(root, 'electron-user-data')}`], {
    cwd: join(root, 'repo'), env: { ...smokeEnvironment(root), NOVAWING_DESKTOP_HOLD_TASKS: '1' }, shell: false,
    windowsHide: prefix !== 'DESKTOP_LAUNCHPAD_SMOKE', detached: detachedSmokeProcess, stdio: ['ignore', 'pipe', 'pipe'],
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
    assert.equal(report.environment?.electron, expectedVersion, 'Smoke must use the pinned Electron binary')
    if (prefix === 'DESKTOP_COMPATIBILITY_RESULT') {
      for (const name of ['guardian_import', 'node_sqlite', 'libsql', 'runtime_create', 'fake_task', 'runtime_close', 'runtime_reopen', 'resources']) {
        assert.equal(report.checks?.[name]?.status, 'PASS', `Missing compatibility gate: ${name}`)
      }
    } else {
      for (const name of ['electron_main', 'isolation', 'launchpad_create', 'launchpad_start', 'launchpad_http',
        'browser_load', 'renderer_js', 'renderer_node_access', 'launchpad_api', 'session_create', 'session_start',
        'control_origin_registered', 'control_navigation', 'control_http', 'control_sse', 'fake_task', 'terminal_state',
        'renderer_reload_no_duplicate_runtime', 'external_navigation_blocked', 'random_loopback_blocked',
        'file_navigation_blocked', 'javascript_navigation_blocked', 'window_open_denied', 'webview_denied',
        'permission_denied', 'host_close', 'control_origin_unregistered', 'strict_shared_close',
        'strict_repeated_quit', 'strict_accepted_operation_drain', 'strict_reject_new_operations',
        'strict_sse_closed', 'strict_resources']) {
        assert.equal(report.checks?.[name]?.status, 'PASS', `Missing Launchpad gate: ${name}`)
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
let isolation
try {
  await mkdir(evidenceDirectory, { recursive: true })
  assert.equal(process.versions.electron, undefined, 'Launch this runner with external Node')
  electronPath = await installedElectronBinary()
  expectedVersion = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).devDependencies.electron
  isolation = await createDesktopIsolation()
  root = isolation.root
  result.runs.push(await runElectron('desktop/tests/launchpad-smoke.mjs', 'DESKTOP_LAUNCHPAD_SMOKE', root))
  result.runs.push(await runElectron('desktop/tests/runtime-compatibility.mjs', 'DESKTOP_COMPATIBILITY_RESULT', root))
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
} finally {
  if (root) {
    try {
      await isolation.cleanup()
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
const launchpadRun = result.runs.find((run) => run.entry === 'desktop/tests/launchpad-smoke.mjs')
const launchpadReport = {
  ...launchpadRun?.report,
  checks: { ...launchpadRun?.report?.checks,
    electron_exit: { status: launchpadRun?.result === 'PASS' ? 'PASS' : 'FAIL',
      detail: { exitCode: launchpadRun?.exitCode, timedOut: launchpadRun?.timedOut, errors: launchpadRun?.errors } },
    cleanup: result.cleanup,
  },
  result: launchpadRun?.result === 'PASS' && result.cleanup.status === 'PASS' ? 'PASS' : 'FAIL',
}
const strictShutdownReport = {
  name: 'DESKTOP_STRICT_SHUTDOWN',
  checks: Object.fromEntries([
    ['shared_close', 'strict_shared_close'], ['reject_new_operations', 'strict_reject_new_operations'],
    ['accepted_operations_drained', 'strict_accepted_operation_drain'], ['sse_closed', 'strict_sse_closed'],
    ['http_closed', 'strict_resources'], ['runtime_closed', 'host_close'],
    ['control_origins_cleared', 'control_origin_unregistered'], ['timers_cleared', 'strict_resources'],
    ['repeated_quit', 'strict_repeated_quit'], ['electron_exit', 'electron_exit'],
  ].map(([name, source]) => [name, launchpadReport.checks[source] ?? { status: 'FAIL', detail: 'Not run' }])),
  cleanup: result.cleanup,
  result: launchpadReport.result,
}
try {
  await writeFile(join(evidenceDirectory, 'launchpad-result.json'), `${JSON.stringify(launchpadReport, null, 2)}\n`)
  await writeFile(join(evidenceDirectory, 'strict-shutdown-result.json'), `${JSON.stringify(strictShutdownReport, null, 2)}\n`)
  await writeFile(join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  result.result = 'FAIL'
  result.errors.push(`Cannot save result evidence: ${String(error)}`)
}
console.log(`DESKTOP_LAUNCHPAD_SMOKE ${JSON.stringify(launchpadReport)}`)
console.log(`DESKTOP_STRICT_SHUTDOWN ${JSON.stringify(strictShutdownReport)}`)
console.log(`DESKTOP_COMPATIBILITY_SMOKE ${JSON.stringify(result)}`)
process.exitCode = result.result === 'PASS' ? 0 : 1
