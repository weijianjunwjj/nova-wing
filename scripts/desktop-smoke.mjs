import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { detachedSmokeProcess, smokeEnvironment, terminateOwnedElectron } from './platform/desktop-smoke-environment.mjs'
import { createDesktopIsolation, installedElectronBinary, repositoryRoot } from './desktop-isolation.mjs'

const evidenceDirectory = join(repositoryRoot, 'artifacts', 'desktop', 'bootstrap-smoke')
const timeoutMs = 60_000
let electronPath
let expectedVersion

/** Fingerprint only isolated user/config data; Chromium profile writes are expected. */
async function databaseSnapshot(root) {
  const entries = []
  for (const directory of ['config', 'data']) {
    const base = join(root, directory)
    for (const file of (await readdir(base, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())) {
      const path = join(file.parentPath, file.name)
      const data = await readFile(path)
      entries.push({ path, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

/** The external Node parent starts and verifies a real secondary Electron process. */
async function runSecondary(root) {
  const before = await databaseSnapshot(root)
  const entry = join(repositoryRoot, 'desktop/tests/background-smoke.mjs')
  const child = spawn(String(electronPath), [entry, `--user-data-dir=${join(root, 'electron-user-data')}`], {
    cwd: join(root, 'repo'), env: { ...smokeEnvironment(root), NOVAWING_DESKTOP_HOLD_TASKS: '1' },
    shell: false, windowsHide: true, detached: detachedSmokeProcess, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const errors = []
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const exited = await new Promise((resolveExit) => {
    let finished = false
    const finish = (exitCode, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolveExit({ exitCode, signal })
    }
    const timer = setTimeout(async () => {
      timedOut = true
      try { await terminateOwnedElectron(child) } catch (error) { errors.push(String(error)) }
      child.stdout.destroy(); child.stderr.destroy(); child.unref()
      finish(child.exitCode, child.signalCode)
    }, 15_000)
    child.once('error', (error) => { errors.push(String(error)); finish(null, null) })
    child.once('close', finish)
  })
  await writeFile(join(evidenceDirectory, 'secondary.stdout.log'), stdout)
  await writeFile(join(evidenceDirectory, 'secondary.stderr.log'), stderr)
  let report
  let databaseFilesUnchanged = false
  try {
    const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith('DESKTOP_SINGLE_INSTANCE '))
    assert.equal(lines.length, 1, 'Secondary must report the failed lock before fixture/Host creation')
    report = JSON.parse(lines[0].slice('DESKTOP_SINGLE_INSTANCE '.length))
    assert.equal(report.primary, false)
    assert.equal(report.lockAcquired, false)
    for (const counter of ['hostCreateCount', 'launchpadCreateCount', 'fixtureCreateCount', 'runtimeCreateCount']) {
      assert.equal(report[counter], 0, `Secondary created ${counter}`)
    }
    assert.equal(stdout.includes('DESKTOP_ISOLATED_FIXTURE '), false)
    assert.equal(stdout.includes('DESKTOP_BACKGROUND_RUNTIME '), false)
    assert.equal(exited.exitCode, 0)
    assert.equal(exited.signal, null)
    assert.equal(timedOut, false)
    assert.deepEqual(await databaseSnapshot(root), before, 'Secondary must leave isolated config/database files unchanged')
    databaseFilesUnchanged = true
  } catch (error) { errors.push(String(error?.stack ?? error)) }
  return { entry, pid: child.pid, ...exited, timedOut, report, databaseFilesUnchanged, errors,
    result: errors.length === 0 ? 'PASS' : 'FAIL' }
}

async function runElectron(entry, prefix, root) {
  const child = spawn(String(electronPath), [join(repositoryRoot, entry), `--user-data-dir=${join(root, 'electron-user-data')}`], {
    cwd: join(root, 'repo'), env: { ...smokeEnvironment(root), NOVAWING_DESKTOP_HOLD_TASKS: '1' }, shell: false,
    windowsHide: prefix === 'DESKTOP_COMPATIBILITY_RESULT', detached: detachedSmokeProcess, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  /** @type {Promise<Awaited<ReturnType<typeof runSecondary>> | {result: string, errors: string[]}> | undefined} */
  let secondaryPromise
  const errors = []
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
    if (prefix === 'DESKTOP_BACKGROUND_RUNTIME' && !secondaryPromise && stdout.includes('DESKTOP_BACKGROUND_SECONDARY_READY ')) {
      secondaryPromise = runSecondary(root).catch((error) => ({ result: 'FAIL', errors: [String(error)] })).then(async (secondary) => {
        const target = join(root, 'secondary-result.json')
        await writeFile(`${target}.tmp`, JSON.stringify(secondary))
        await rename(`${target}.tmp`, target)
        return secondary
      }).catch((error) => {
        const detail = `Secondary process evidence failed: ${String(error)}`
        errors.push(detail)
        return { result: 'FAIL', errors: [detail] }
      })
    }
  })
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
  // Own the secondary through its actual close even if the primary failed first.
  const secondary = await secondaryPromise
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
    } else if (prefix === 'DESKTOP_NATIVE_NOTIFICATION') {
      for (const name of ['completed_generated', 'completed_desktop_delivery', 'failed_generated', 'failed_desktop_delivery',
        'human_required_generated', 'human_required_desktop_delivery', 'user_paused_not_notified',
        'desktop_independent_from_email_opt_in', 'channel_retry_isolated', 'duplicate_suppression',
        'unsupported_not_registered', 'provider_failure_does_not_change_task', 'hidden_window_notification',
        'click_session_resolution', 'click_show_restore_focus', 'click_no_duplicate_runtime', 'notification_drain', 'cleanup']) {
        assert.equal(report.checks?.[name]?.status, 'PASS', `Missing Native Notification gate: ${name}`)
      }
      // Automated Main routing/event evidence never claims OS visual/manual acceptance.
      assert.equal(report.windowsNativeToastVisual, 'NEEDS_PACKAGED_VALIDATION')
    } else if (prefix === 'DESKTOP_BACKGROUND_RUNTIME') {
      assert.ok(secondary, 'External runner must start the real secondary Electron')
      assert.equal(secondary.result, 'PASS', JSON.stringify(secondary))
      for (const name of ['window_close_hides', 'host_survives_hide', 'runtime_survives_hide', 'task_survives_hide',
        'hidden_completion', 'durable_hidden_completion', 'same_session_restored', 'tray_created', 'tray_show', 'tray_hide',
        'single_instance', 'second_instance_focus', 'no_duplicate_host', 'secondary_no_database',
        'renderer_crash_detected', 'renderer_recovered', 'runtime_survives_renderer_crash', 'tray_survives_crash',
        'destroyed_window_recovery', 'window_all_closed_background', 'power_idle_off', 'power_active_on',
        'power_hidden_on', 'power_crash_on', 'power_multi_activity', 'power_terminal_off', 'power_failure_release',
        'power_scheduled_idle', 'power_suspended_off', 'explicit_quit_uses_strict_shutdown', 'power_quit_drain', 'strict_resources']) {
        assert.equal(report.checks?.[name]?.status, 'PASS', `Missing Background gate: ${name}`)
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
let backgroundIsolation
let notificationIsolation
try {
  await mkdir(evidenceDirectory, { recursive: true })
  assert.equal(process.versions.electron, undefined, 'Launch this runner with external Node')
  electronPath = await installedElectronBinary()
  expectedVersion = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).devDependencies.electron
  isolation = await createDesktopIsolation()
  root = isolation.root
  result.runs.push(await runElectron('desktop/tests/launchpad-smoke.mjs', 'DESKTOP_LAUNCHPAD_SMOKE', root))
  result.runs.push(await runElectron('desktop/tests/runtime-compatibility.mjs', 'DESKTOP_COMPATIBILITY_RESULT', root))
  backgroundIsolation = await createDesktopIsolation()
  result.runs.push(await runElectron('desktop/tests/background-smoke.mjs', 'DESKTOP_BACKGROUND_RUNTIME', backgroundIsolation.root))
  notificationIsolation = await createDesktopIsolation()
  result.runs.push(await runElectron('desktop/tests/notification-smoke.mjs', 'DESKTOP_NATIVE_NOTIFICATION', notificationIsolation.root))
} catch (error) {
  result.errors.push(String(error?.stack ?? error))
} finally {
  const cleanupErrors = []
  for (const ownedIsolation of [isolation, backgroundIsolation, notificationIsolation].filter(Boolean)) {
    try {
      await ownedIsolation.cleanup()
    } catch (error) {
      cleanupErrors.push({ code: error.code, temporaryRoot: ownedIsolation.root, error: String(error) })
      result.errors.push(`Temporary directory cleanup failed: ${String(error)}`)
    }
  }
  if (root) result.cleanup = { status: cleanupErrors.length ? 'FAIL' : 'PASS', temporaryRoot: root,
    backgroundRoot: backgroundIsolation?.root, notificationRoot: notificationIsolation?.root, ...(cleanupErrors.length ? { errors: cleanupErrors,
      phase: 'temporary_directory_cleanup_after_electron_exit' } : {}) }
}
result.result = result.runs.length === 4 && result.runs.every((run) => run.result === 'PASS') &&
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
const backgroundRun = result.runs.find((run) => run.entry === 'desktop/tests/background-smoke.mjs')
const backgroundReport = {
  ...backgroundRun?.report,
  checks: { ...backgroundRun?.report?.checks,
    electron_exit: { status: backgroundRun?.result === 'PASS' ? 'PASS' : 'FAIL',
      detail: { exitCode: backgroundRun?.exitCode, timedOut: backgroundRun?.timedOut, errors: backgroundRun?.errors } },
    cleanup: result.cleanup,
  },
  result: backgroundRun?.result === 'PASS' && result.cleanup.status === 'PASS' ? 'PASS' : 'FAIL',
}
const notificationRun = result.runs.find((run) => run.entry === 'desktop/tests/notification-smoke.mjs')
const notificationReport = {
  ...notificationRun?.report,
  checks: { ...notificationRun?.report?.checks,
    electron_exit: { status: notificationRun?.result === 'PASS' ? 'PASS' : 'FAIL',
      detail: { exitCode: notificationRun?.exitCode, timedOut: notificationRun?.timedOut, errors: notificationRun?.errors } },
    isolation_cleanup: result.cleanup,
  },
  result: notificationRun?.result === 'PASS' && result.cleanup.status === 'PASS' ? 'PASS' : 'FAIL',
}
try {
  await writeFile(join(evidenceDirectory, 'native-notification-result.json'), `${JSON.stringify(notificationReport, null, 2)}\n`)
  await writeFile(join(evidenceDirectory, 'background-runtime-result.json'), `${JSON.stringify(backgroundReport, null, 2)}\n`)
  await writeFile(join(evidenceDirectory, 'launchpad-result.json'), `${JSON.stringify(launchpadReport, null, 2)}\n`)
  await writeFile(join(evidenceDirectory, 'strict-shutdown-result.json'), `${JSON.stringify(strictShutdownReport, null, 2)}\n`)
  await writeFile(join(evidenceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  result.result = 'FAIL'
  result.errors.push(`Cannot save result evidence: ${String(error)}`)
}
console.log(`DESKTOP_LAUNCHPAD_SMOKE ${JSON.stringify(launchpadReport)}`)
console.log(`DESKTOP_STRICT_SHUTDOWN ${JSON.stringify(strictShutdownReport)}`)
console.log(`DESKTOP_BACKGROUND_RUNTIME ${JSON.stringify(backgroundReport)}`)
console.log(`DESKTOP_NATIVE_NOTIFICATION ${JSON.stringify(notificationReport)}`)
console.log(`WINDOWS_NATIVE_TOAST_VISUAL ${notificationReport.windowsNativeToastVisual ?? 'NEEDS_PACKAGED_VALIDATION'}`)
console.log(`DESKTOP_COMPATIBILITY_SMOKE ${JSON.stringify(result)}`)
process.exitCode = result.result === 'PASS' ? 0 : 1
