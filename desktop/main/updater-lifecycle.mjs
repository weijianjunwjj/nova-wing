/**
 * Main's update install path.
 *
 * It owns three things and nothing else:
 * - the one-shot install authorization that the single final quit consumes;
 * - the routing between an ordinary quit and an authorized install;
 * - the production assembly of the updater, which ships with no backend and no installer and
 *   therefore stays not installable until a real one is configured.
 *
 * It never closes the Host, never drains, never spawns and never installs by itself. Those all
 * belong to the existing strict shutdown coordinator, which this module only routes into.
 */

import { createDesktopUpdater } from './updater.mjs'

/**
 * @typedef {{ check: () => Promise<{ available: boolean, candidate?: { version: string, identity: string } }>,
 *   download: (candidate: unknown) => Promise<unknown> }} LifecycleBackend
 * @typedef {(intent: { version: string, identity: string }) => unknown} LifecycleInstaller
 */

/** Reasons this module adds. Stable strings; callers must not parse prose. */
export const UPDATER_LIFECYCLE_REASON = Object.freeze({
  NOT_CONFIGURED: 'UPDATER_NOT_CONFIGURED',
  INSTALL_NOT_CONFIGURED: 'UPDATER_INSTALL_NOT_CONFIGURED',
})

/**
 * A backend that refuses every entry point. Production ships this rather than a stub that could
 * succeed: with a non-installable capability the updater never reaches it, and if that ever
 * changed the attempt would fail loudly instead of pretending a check happened.
 *
 * @returns {LifecycleBackend}
 */
export function createUnconfiguredBackend() {
  const refuse = () => { throw new Error('NovaWing update backend is not configured') }
  return { check: async () => refuse(), download: async () => refuse() }
}

/**
 * The one-shot install authorization. It is bound at admission to the candidate the user
 * confirmed and consumed exactly once by the final quit, so a later event can never swap what was
 * approved and a re-entrant exit can never install twice.
 *
 * The authorization lives here, in the exit assembly, rather than in the updater's mutable state:
 * resource cleanup during the drain must not be able to erase what the final quit still has to
 * consume.
 */
export function createInstallAuthorization() {
  let bound = null
  let consumed = false
  return {
    /** A later binding never replaces the first: the approved candidate is immutable. */
    bind(candidate) {
      if (bound === null) bound = Object.freeze({ version: candidate.version, identity: candidate.identity })
      return { ...bound }
    },
    /** Consume once, before any installer call, so an exit that re-enters cannot install twice. */
    consume() {
      if (bound === null || consumed) return null
      consumed = true
      return { ...bound }
    },
    snapshot() { return { bound: bound !== null, consumed } },
  }
}

/**
 * The single final-quit action.
 *
 * No bound authorization means the ordinary quit, exactly as before. A bound one is consumed once
 * and handed to the installer unchanged. The install gate is deliberately not re-read here: once
 * the drain has completed, shutdown state and released resources are already changing, so the
 * authorization bound at admission is what gets consumed rather than a fresh one.
 *
 * A missing or throwing installer fails loudly and never falls back to an ordinary quit, which
 * would hide a broken install behind a normal-looking shutdown.
 *
 * @param {{ authorization: ReturnType<typeof createInstallAuthorization>,
 *   installer: LifecycleInstaller | null, quit: () => void,
 *   reportFailure?: (error: unknown) => void }} options
 */
export function createFinalQuitAction({ authorization, installer, quit, reportFailure = () => {} }) {
  return function requestFinalQuit() {
    const intent = authorization.consume()
    if (intent === null) { quit(); return }
    if (typeof installer !== 'function') {
      reportFailure(new Error(`${UPDATER_LIFECYCLE_REASON.INSTALL_NOT_CONFIGURED}: an install was authorized without an installer`))
      return
    }
    try { installer(intent) } catch (error) { reportFailure(error) }
  }
}

/**
 * Assembles the updater against the real Host. Everything that could make the app act is
 * injected: without both a backend and an installer the capability is not installable, the gate
 * refuses before any shutdown begins, and the product keeps running update-disabled.
 *
 * @param {{ platform: string, backend?: LifecycleBackend | null, installer?: LifecycleInstaller | null,
 *   signature?: 'signed' | 'unsigned' | 'unknown', unsignedInstallApproved?: boolean,
 *   reportFailure?: (error: unknown) => void }} options
 */
export function createUpdaterLifecycle({
  platform, backend = null, installer = null, signature = 'unknown',
  unsignedInstallApproved = false, reportFailure = () => {},
}) {
  const configured = typeof backend?.check === 'function' && typeof installer === 'function'
  const capability = Object.freeze(configured
    ? { platform, installable: true, signature, unsignedInstallApproved }
    : { platform, installable: false, reasonCode: UPDATER_LIFECYCLE_REASON.NOT_CONFIGURED, signature: 'unknown' })
  const authorization = createInstallAuthorization()

  return {
    authorization,
    capability,
    get configured() { return configured },
    finalQuit: ({ quit }) => createFinalQuitAction({
      authorization, installer: configured ? installer : null, quit, reportFailure,
    }),
    /**
     * @param {{ host: { updateSafetySnapshot: (options: object) => unknown },
     *   requestQuit: () => Promise<unknown>, readShutdownState: () => unknown }} wiring
     */
    createUpdater({ host, requestQuit, readShutdownState }) {
      return createDesktopUpdater({
        backend: configured ? backend : createUnconfiguredBackend(),
        capability,
        // The real Host snapshot, read fresh on every gate evaluation. Never a cached reading.
        getBlockers: () => host.updateSafetySnapshot({ readShutdownState }),
        // Deliberately synchronous end to end: bind what the user confirmed, then enter the
        // existing quit admission inside the same call chain that evaluated the gate.
        requestInstallExit: ({ candidate }) => {
          authorization.bind(candidate)
          return requestQuit()
        },
      })
    },
  }
}
