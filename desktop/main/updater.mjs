/**
 * NovaWing updater: the offline state machine and the install gate.
 *
 * Main-owned and deliberately effect-free. Check, download and the authorized exit-for-install
 * all arrive through injected dependencies, so the state machine and the gate stay testable
 * without Electron, a network, a feed or an installer. This module never imports electron, never
 * quits the app, never spawns a process and never mutates the environment. Creating a controller
 * performs no check: every observation of the outside world is an explicit caller action.
 */

export const UPDATER_STATE = Object.freeze({
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  AVAILABLE: 'AVAILABLE',
  DOWNLOADING: 'DOWNLOADING',
  READY: 'READY',
  ERROR: 'ERROR',
  UNSUPPORTED: 'UNSUPPORTED',
})

/** Why an operation was refused. Every refusal is explicit; none is a silent no-op. */
export const UPDATER_BLOCK_REASON = Object.freeze({
  DISPOSED: 'DISPOSED',
  UNSUPPORTED: 'UNSUPPORTED',
  CAPABILITY_UNKNOWN: 'CAPABILITY_UNKNOWN',
  CHECK_IN_PROGRESS: 'CHECK_IN_PROGRESS',
  DOWNLOAD_IN_PROGRESS: 'DOWNLOAD_IN_PROGRESS',
  UPDATE_ALREADY_READY: 'UPDATE_ALREADY_READY',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  NOT_READY: 'NOT_READY',
  INSTALL_IN_PROGRESS: 'INSTALL_IN_PROGRESS',
  INSTALL_ALREADY_AUTHORIZED: 'INSTALL_ALREADY_AUTHORIZED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  CANDIDATE_MISMATCH: 'CANDIDATE_MISMATCH',
  STATE_UNKNOWN: 'STATE_UNKNOWN',
  ACTIVE_OPERATIONS: 'ACTIVE_OPERATIONS',
  PENDING_HUMAN_DECISION: 'PENDING_HUMAN_DECISION',
  PENDING_CHECKPOINT: 'PENDING_CHECKPOINT',
  SHUTDOWN_IN_FLIGHT: 'SHUTDOWN_IN_FLIGHT',
  UNSIGNED_INSTALL_NOT_APPROVED: 'UNSIGNED_INSTALL_NOT_APPROVED',
})

/** Failure codes retained in ERROR state. The thrown cause is described separately. */
export const UPDATER_FAILURE = Object.freeze({
  CHECK_FAILED: 'CHECK_FAILED',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  BACKEND_CONTRACT: 'BACKEND_CONTRACT',
  CANDIDATE_MISSING: 'CANDIDATE_MISSING',
  INSTALL_EXIT_FAILED: 'INSTALL_EXIT_FAILED',
})

const SIGNED = 'signed'
const UNKNOWN_SIGNATURE = 'unknown'
const DIAGNOSTIC_LIMIT = 400

/**
 * Credential-shaped substrings are removed before any diagnostic is retained, so a backend that
 * embeds an authenticated URL or a header in an Error message cannot leak it into the snapshot.
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
const REDACTIONS = Object.freeze([
  [/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gu, '[redacted]'],
  [/\b((?:token|access_token|api_key|apikey|password|secret|signature)\s*=\s*)[^\s&"'<>]+/giu, '$1[redacted]'],
  [/\b(authorization\s*[:=]\s*)(?:[A-Za-z]+\s+)?\S+/giu, '$1[redacted]'],
  [/(\/\/)[^/\s@]+:[^/\s@]+@/gu, '$1[redacted]@'],
])

/** @param {unknown} value @returns {string} */
function redactDiagnosticText(value) {
  let text = typeof value === 'string' ? value : String(value)
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement)
  return text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT)}...` : text
}

/** A minimal, redacted description: no stack, no request/response payload, no environment. */
/** @param {unknown} error @returns {{ name: string, message: string, code?: string | number }} */
function describeUpdateError(error) {
  if (error === null || error === undefined) return { name: 'Error', message: 'unknown failure' }
  if (typeof error !== 'object') return { name: 'Error', message: redactDiagnosticText(error) }
  const record = /** @type {Record<string, unknown>} */ (error)
  const code = record.code
  return {
    name: typeof record.name === 'string' ? record.name : 'Error',
    message: redactDiagnosticText(typeof record.message === 'string' ? record.message : 'unknown failure'),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  }
}

/** @typedef {{ version: string, identity: string }} UpdateCandidate
 * @typedef {{ platform: string, installable: boolean, reasonCode?: string | null,
 *   signature: 'signed' | 'unsigned' | 'unknown', unsignedInstallApproved?: boolean }} UpdaterCapability */

/**
 * The injected adapter's contract. `download` MUST resolve only once the artifact for that
 * exact candidate has been fetched AND has passed whatever verification the platform policy
 * requires (hash, and a code signature wherever a policy demands one). A resolved promise is
 * the adapter asserting that; it is not evidence that a transfer merely finished. This
 * controller cannot verify anything itself and never inspects the download payload to decide
 * installability, so the adapter is the only place that verification can happen.
 *
 * @typedef {{ check: () => Promise<{ available: boolean, candidate?: UpdateCandidate }>,
 *   download: (candidate: UpdateCandidate) => Promise<unknown> }} UpdateBackend */

/**
 * @typedef {{ backend: UpdateBackend, getBlockers: () => unknown,
 *   requestInstallExit: (request: { candidate: UpdateCandidate }) => Promise<unknown>,
 *   capability?: UpdaterCapability | null, reportFailure?: (error: unknown) => void }} UpdaterOptions
 * @typedef {{ ok: boolean, state: string, candidate: UpdateCandidate | null,
 *   reasonCode: string | null, reasons: string[] }} UpdaterResult
 * @typedef {{ state: string, reasonCode: string | null, disposed: boolean,
 *   candidate: UpdateCandidate | null, lastError: { name: string, message: string } | null,
 *   capability: { platform: string, installable: boolean, signature: string },
 *   observations: Record<string, number> }} UpdaterSnapshot
 */

/** @param {UpdateCandidate | undefined | null} value @returns {value is UpdateCandidate} */
function isCandidate(value) {
  return value !== null && value !== undefined && typeof value === 'object' &&
    typeof (/** @type {UpdateCandidate} */ (value).version) === 'string' &&
    typeof (/** @type {UpdateCandidate} */ (value).identity) === 'string'
}

/** @param {UpdaterOptions} options */
export function createDesktopUpdater({ backend, capability = null, getBlockers, requestInstallExit, reportFailure = () => {} }) {
  const supported = capability !== null && capability.installable === true
  const capabilityReason = supported ? null : capability?.reasonCode ?? UPDATER_BLOCK_REASON.CAPABILITY_UNKNOWN

  /** @type {string} */
  let state = supported ? UPDATER_STATE.IDLE : UPDATER_STATE.UNSUPPORTED
  /** @type {string | null} */
  let reasonCode = capabilityReason
  /** @type {UpdateCandidate | null} */
  let candidate = null
  /** @type {{ name: string, message: string, code?: string | number } | null} */
  let lastError = null
  let disposed = false
  // Bumped by dispose so an in-flight backend result can never move a disposed controller.
  let epoch = 0
  /** @type {Promise<unknown> | null} */
  let installInFlight = null
  let authorized = false
  const listeners = new Set()
  const observations = {
    transitions: 0, checkCalls: 0, checkRejections: 0, checkFailures: 0,
    downloadCalls: 0, downloadRejections: 0, downloadFailures: 0, installRequests: 0,
    installBlocked: 0, installAuthorizations: 0, installExitFailures: 0, disposes: 0,
    /** @type {Array<{ name: string, message: string }>} */ errors: [],
  }

  function report(error) {
    observations.errors.push(describeUpdateError(error))
    try { reportFailure(error) } catch { /* Diagnostics cannot change an update decision. */ }
  }

  /** @returns {UpdaterSnapshot} */
  function snapshot() {
    return {
      state,
      reasonCode,
      disposed,
      candidate: candidate === null ? null : { version: candidate.version, identity: candidate.identity },
      lastError: lastError === null ? null : { ...lastError },
      capability: {
        platform: capability?.platform ?? 'unknown',
        installable: supported,
        signature: capability?.signature ?? UNKNOWN_SIGNATURE,
      },
      observations: {
        transitions: observations.transitions, checkCalls: observations.checkCalls,
        checkRejections: observations.checkRejections, checkFailures: observations.checkFailures,
        downloadCalls: observations.downloadCalls, downloadRejections: observations.downloadRejections,
        downloadFailures: observations.downloadFailures, installRequests: observations.installRequests,
        installBlocked: observations.installBlocked, installAuthorizations: observations.installAuthorizations,
        installExitFailures: observations.installExitFailures, disposes: observations.disposes,
        errorCount: observations.errors.length,
      },
    }
  }

  function notify() {
    const current = snapshot()
    for (const listener of listeners) {
      try { listener(current) } catch (error) { report(error) }
    }
  }

  /** @param {string} next @param {string | null} [nextReason] */
  function transition(next, nextReason = null) {
    state = next
    reasonCode = nextReason
    observations.transitions++
    notify()
  }

  /** @param {string} reason @returns {UpdaterResult} */
  function refused(reason) {
    return { ok: false, state, candidate: null, reasonCode: reason, reasons: [reason] }
  }

  /** @param {UpdateCandidate | null} value @returns {UpdaterResult} */
  function succeeded(value) {
    return { ok: true, state, candidate: value, reasonCode: null, reasons: [] }
  }

  /** @param {string} failure @param {string} message @returns {UpdaterResult} */
  function fail(failure, message) {
    lastError = { name: 'UpdaterError', message: redactDiagnosticText(message), code: failure }
    transition(UPDATER_STATE.ERROR, failure)
    return refused(failure)
  }

  /** True once dispose invalidated this operation's result. @param {number} token */
  function stale(token) { return disposed || token !== epoch }

  /** The blocker snapshot is the current Host managed scope and nothing else: it is read only
   * here, and an incomplete reading fails closed rather than being treated as idle. */
  function readBlockers() {
    let value
    try { value = getBlockers() } catch (error) { report(error); return null }
    if (value === null || typeof value !== 'object') return null
    const source = /** @type {Record<string, unknown>} */ (value)
    if (source.readable !== true) return null
    for (const key of ['activeOperations', 'pendingHumanDecisions', 'pendingCheckpoints']) {
      const count = source[key]
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null
    }
    if (typeof source.shutdownInFlight !== 'boolean') return null
    return {
      activeOperations: /** @type {number} */ (source.activeOperations),
      pendingHumanDecisions: /** @type {number} */ (source.pendingHumanDecisions),
      pendingCheckpoints: /** @type {number} */ (source.pendingCheckpoints),
      shutdownInFlight: source.shutdownInFlight,
    }
  }

  /**
   * Every install precondition, evaluated together so the caller sees all blocking reasons at
   * once. A capability is never inferred from the platform: it is an explicit injected decision.
   * @param {{ version?: unknown, identity?: unknown } | null} confirmation
   * @returns {string[]}
   */
  function evaluateGate(confirmation) {
    /** @type {string[]} */
    const reasons = []
    if (disposed) reasons.push(UPDATER_BLOCK_REASON.DISPOSED)
    if (installInFlight !== null) reasons.push(UPDATER_BLOCK_REASON.INSTALL_IN_PROGRESS)
    if (authorized) reasons.push(UPDATER_BLOCK_REASON.INSTALL_ALREADY_AUTHORIZED)
    if (state === UPDATER_STATE.UNSUPPORTED || !supported) {
      reasons.push(capabilityReason ?? UPDATER_BLOCK_REASON.UNSUPPORTED)
    } else if (state !== UPDATER_STATE.READY) reasons.push(UPDATER_BLOCK_REASON.NOT_READY)
    // An unsigned install needs an explicit policy acknowledgement; the platform cannot grant one.
    const signature = capability?.signature ?? UNKNOWN_SIGNATURE
    if (signature !== SIGNED && capability?.unsignedInstallApproved !== true) {
      reasons.push(UPDATER_BLOCK_REASON.UNSIGNED_INSTALL_NOT_APPROVED)
    }
    const version = confirmation?.version
    const identity = confirmation?.identity
    if (typeof version !== 'string' || typeof identity !== 'string') {
      reasons.push(UPDATER_BLOCK_REASON.CONFIRMATION_REQUIRED)
    } else if (candidate === null || candidate.version !== version || candidate.identity !== identity) {
      reasons.push(UPDATER_BLOCK_REASON.CANDIDATE_MISMATCH)
    }
    const blockers = readBlockers()
    if (blockers === null) reasons.push(UPDATER_BLOCK_REASON.STATE_UNKNOWN)
    else {
      if (blockers.activeOperations > 0) reasons.push(UPDATER_BLOCK_REASON.ACTIVE_OPERATIONS)
      if (blockers.pendingHumanDecisions > 0) reasons.push(UPDATER_BLOCK_REASON.PENDING_HUMAN_DECISION)
      if (blockers.pendingCheckpoints > 0) reasons.push(UPDATER_BLOCK_REASON.PENDING_CHECKPOINT)
      if (blockers.shutdownInFlight) reasons.push(UPDATER_BLOCK_REASON.SHUTDOWN_IN_FLIGHT)
    }
    return [...new Set(reasons)]
  }

  /** @returns {string | null} */
  function checkRejection() {
    if (disposed) return UPDATER_BLOCK_REASON.DISPOSED
    if (installInFlight !== null) return UPDATER_BLOCK_REASON.INSTALL_IN_PROGRESS
    if (state === UPDATER_STATE.UNSUPPORTED) return capabilityReason ?? UPDATER_BLOCK_REASON.UNSUPPORTED
    if (state === UPDATER_STATE.CHECKING) return UPDATER_BLOCK_REASON.CHECK_IN_PROGRESS
    if (state === UPDATER_STATE.DOWNLOADING) return UPDATER_BLOCK_REASON.DOWNLOAD_IN_PROGRESS
    if (state === UPDATER_STATE.READY) return UPDATER_BLOCK_REASON.UPDATE_ALREADY_READY
    return null
  }

  /** @returns {string | null} */
  function downloadRejection() {
    if (disposed) return UPDATER_BLOCK_REASON.DISPOSED
    if (installInFlight !== null) return UPDATER_BLOCK_REASON.INSTALL_IN_PROGRESS
    if (state === UPDATER_STATE.UNSUPPORTED) return capabilityReason ?? UPDATER_BLOCK_REASON.UNSUPPORTED
    if (state === UPDATER_STATE.DOWNLOADING) return UPDATER_BLOCK_REASON.DOWNLOAD_IN_PROGRESS
    if (state === UPDATER_STATE.CHECKING) return UPDATER_BLOCK_REASON.CHECK_IN_PROGRESS
    if (state === UPDATER_STATE.READY) return UPDATER_BLOCK_REASON.UPDATE_ALREADY_READY
    if (state !== UPDATER_STATE.AVAILABLE || candidate === null) return UPDATER_BLOCK_REASON.NOT_AVAILABLE
    return null
  }

  /** @returns {Promise<UpdaterResult>} */
  async function check() {
    observations.checkCalls++
    const rejection = checkRejection()
    if (rejection !== null) { observations.checkRejections++; return refused(rejection) }
    const token = epoch
    transition(UPDATER_STATE.CHECKING)
    let outcome
    try { outcome = await backend.check() }
    catch (error) {
      if (stale(token)) return refused(UPDATER_BLOCK_REASON.DISPOSED)
      observations.checkFailures++
      lastError = describeUpdateError(error)
      candidate = null
      transition(UPDATER_STATE.ERROR, UPDATER_FAILURE.CHECK_FAILED)
      return refused(UPDATER_FAILURE.CHECK_FAILED)
    }
    if (stale(token)) return refused(UPDATER_BLOCK_REASON.DISPOSED)
    if (outcome === null || typeof outcome !== 'object' || typeof outcome.available !== 'boolean') {
      candidate = null
      return fail(UPDATER_FAILURE.BACKEND_CONTRACT, 'check returned no usable response')
    }
    if (!outcome.available) {
      candidate = null
      lastError = null
      transition(UPDATER_STATE.IDLE)
      return succeeded(null)
    }
    if (!isCandidate(outcome.candidate)) {
      candidate = null
      return fail(UPDATER_FAILURE.CANDIDATE_MISSING, 'update reported without a usable candidate')
    }
    candidate = { version: outcome.candidate.version, identity: outcome.candidate.identity }
    lastError = null
    transition(UPDATER_STATE.AVAILABLE)
    return succeeded({ ...candidate })
  }

  /**
   * Reach READY. READY means the adapter resolved, and nothing more: the adapter is
   * responsible for not resolving until the artifact has been verified (see UpdateBackend).
   * @returns {Promise<UpdaterResult>}
   */
  async function download() {
    observations.downloadCalls++
    const rejection = downloadRejection()
    if (rejection !== null) { observations.downloadRejections++; return refused(rejection) }
    const target = candidate
    if (target === null) return refused(UPDATER_BLOCK_REASON.NOT_AVAILABLE)
    const token = epoch
    transition(UPDATER_STATE.DOWNLOADING)
    try { await backend.download({ version: target.version, identity: target.identity }) }
    catch (error) {
      if (stale(token)) return refused(UPDATER_BLOCK_REASON.DISPOSED)
      observations.downloadFailures++
      lastError = describeUpdateError(error)
      candidate = null
      transition(UPDATER_STATE.ERROR, UPDATER_FAILURE.DOWNLOAD_FAILED)
      return refused(UPDATER_FAILURE.DOWNLOAD_FAILED)
    }
    if (stale(token)) return refused(UPDATER_BLOCK_REASON.DISPOSED)
    // Identity comes from the check metadata, never from the download response, so a backend
    // cannot substitute what the user is about to confirm.
    candidate = target
    lastError = null
    transition(UPDATER_STATE.READY)
    return succeeded({ ...target })
  }

  /**
   * The only path to an install. It requests the injected exit once, and never quits the app,
   * spawns an installer or stops a Runtime itself: admission fencing belongs to the existing
   * Host shutdown that the caller wires into requestInstallExit.
   * @param {{ version?: unknown, identity?: unknown } | null} [confirmation]
   * @returns {Promise<UpdaterResult>}
   */
  async function requestRestartAndInstall(confirmation = null) {
    observations.installRequests++
    const reasons = evaluateGate(confirmation)
    if (reasons.length > 0) {
      observations.installBlocked++
      return { ok: false, state, candidate: null, reasonCode: reasons[0] ?? UPDATER_BLOCK_REASON.NOT_READY, reasons }
    }
    const confirmed = candidate
    if (confirmed === null) {
      observations.installBlocked++
      return refused(UPDATER_BLOCK_REASON.STATE_UNKNOWN)
    }
    const target = { version: confirmed.version, identity: confirmed.identity }
    authorized = true
    observations.installAuthorizations++
    const completion = Promise.withResolvers()
    installInFlight = completion.promise
    void Promise.resolve()
      .then(() => requestInstallExit({ candidate: { ...target } }))
      .then(completion.resolve, completion.reject)
    try {
      await completion.promise
      return succeeded(target)
    } catch (error) {
      report(error)
      observations.installExitFailures++
      // The app never left, so the update is not installed and the candidate is still READY.
      // Releasing the latch is what makes an explicit retry possible.
      authorized = false
      return refused(UPDATER_FAILURE.INSTALL_EXIT_FAILED)
    } finally {
      if (installInFlight === completion.promise) installInFlight = null
    }
  }

  /** @param {(value: UpdaterSnapshot) => void} listener */
  function subscribe(listener) {
    if (disposed || typeof listener !== 'function') return () => {}
    listeners.add(listener)
    try { listener(snapshot()) } catch (error) { report(error) }
    return () => { listeners.delete(listener) }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    // Invalidate in-flight backend results before dropping the subscribers that would see them.
    epoch++
    listeners.clear()
    observations.disposes++
  }

  return { check, download, requestRestartAndInstall, subscribe, dispose, snapshot }
}
