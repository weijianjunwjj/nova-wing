import { createNovaWingLaunchpad, createProductionWorkSessionUi } from 'nova-wing/development-guardian'
import { createNavigationRegistry } from './navigation.mjs'

const SAFETY_VIEW_UNAVAILABLE = 'HOST_SAFETY_VIEW_UNAVAILABLE'
const SHUTDOWN_STATE_UNAVAILABLE = 'SHUTDOWN_STATE_UNAVAILABLE'

const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** A missing, malformed or throwing Launchpad projection is unreadable, never idle.
 * @param {{ getUpdateSafetyView?: () => unknown } | null | undefined} launchpad
 * @returns {Record<string, unknown> | null} */
function readLaunchpadSafetyView(launchpad) {
  try {
    const read = launchpad?.getUpdateSafetyView
    if (typeof read !== 'function') return null
    const value = read.call(launchpad)
    if (value === null || typeof value !== 'object') return null
    const view = /** @type {Record<string, unknown>} */ (value)
    if (typeof view.readable !== 'boolean') return null
    if (typeof view.reasonCode !== 'string' && view.reasonCode !== null) return null
    for (const key of ['activeOperations', 'pendingHumanDecisions', 'pendingCheckpoints']) {
      if (!isCount(view[key])) return null
    }
    return view
  } catch { return null }
}

/** A shutdown that was requested and never completed stays in flight forever: it failed.
 * @param {unknown} readShutdownState
 * @returns {boolean | null} */
function readShutdownInFlight(readShutdownState) {
  try {
    if (typeof readShutdownState !== 'function') return null
    const state = /** @type {() => unknown} */ (readShutdownState)()
    if (state === null || typeof state !== 'object') return null
    const record = /** @type {Record<string, unknown>} */ (state)
    if (typeof record.requested !== 'boolean' || typeof record.completed !== 'boolean') return null
    return record.requested && !record.completed
  } catch { return null }
}

/**
 * Read-only, redacted Host safety snapshot for the update install gate.
 *
 * `readShutdownState` is supplied per call because the strict shutdown coordinator belongs to
 * Main's composition, not to this Host. It is required and never defaulted, `readable` is
 * authoritative, and an unreadable snapshot carries the conservative value in every field so
 * that a consumer which ignores `readable` still cannot conclude that installing is safe.
 *
 * This is an observation, not an authorization: the caller must read it again immediately
 * before acting and must never cache an earlier reading to authorize a later install.
 *
 * @param {{ getUpdateSafetyView?: () => unknown } | null | undefined} launchpad
 * @param {{ readShutdownState?: () => unknown }} [options]
 * @returns {{ readable: boolean, reasonCode: string | null, activeOperations: number,
 *   pendingHumanDecisions: number, pendingCheckpoints: number, shutdownInFlight: boolean }}
 */
export function composeSafetySnapshot(launchpad, { readShutdownState } = {}) {
  const view = readLaunchpadSafetyView(launchpad)
  const shutdownInFlight = readShutdownInFlight(readShutdownState)
  if (view === null) {
    return { readable: false, reasonCode: SAFETY_VIEW_UNAVAILABLE, activeOperations: 0, pendingHumanDecisions: 0, pendingCheckpoints: 0, shutdownInFlight: true }
  }
  const counts = {
    activeOperations: /** @type {number} */ (view.activeOperations),
    pendingHumanDecisions: /** @type {number} */ (view.pendingHumanDecisions),
    pendingCheckpoints: /** @type {number} */ (view.pendingCheckpoints),
  }
  if (view.readable !== true) {
    return { readable: false, reasonCode: typeof view.reasonCode === 'string' ? view.reasonCode : SAFETY_VIEW_UNAVAILABLE, ...counts, shutdownInFlight: true }
  }
  if (shutdownInFlight === null) {
    return { readable: false, reasonCode: SHUTDOWN_STATE_UNAVAILABLE, ...counts, shutdownInFlight: true }
  }
  return { readable: true, reasonCode: null, ...counts, shutdownInFlight }
}

/** Thin ownership wrapper. Task execution and HTTP/SSE remain in the existing factories. */
export async function createDesktopHost({ configDirectory, env, dependencies, desktopNotifier = undefined, launchpadFactory = createNovaWingLaunchpad }) {
  const registry = createNavigationRegistry()
  // Session identity comes from trusted composition, never a notification URL.
  const controls = new Map()
  const observations = { controlRegistered: [], controlUnregistered: [], closeCalls: 0, pendingControlCloses: 0, errors: [] }
  let launchpadUrl
  let closing = false
  let startPromise
  let closePromise
  const createWorkSession = dependencies.createWorkSession ?? createProductionWorkSessionUi
  const launchpad = await launchpadFactory({
    configDirectory, env, shutdownMode: 'strict',
    dependencies: {
      ...dependencies,
      async createWorkSession(config, options) {
        const app = await createWorkSession(config, {
          ...options, ...(desktopNotifier === undefined ? {} : { desktopNotifier }),
        })
        const sessionId = config.session.id
        let origin
        let controlStartPromise
        let controlClosePromise
        return {
          ...app,
          start() {
            if (controlStartPromise) return controlStartPromise
            if (controlClosePromise) return Promise.reject(new Error('Desktop Control app is closing'))
            const completion = Promise.withResolvers()
            controlStartPromise = completion.promise
            void (async () => {
              const address = await app.start()
              if (!closing && !controlClosePromise) {
                origin = registry.register(app, address.url)
                controls.set(sessionId, { owner: app, url: address.url })
                observations.controlRegistered.push(origin)
              }
              return address
            })().then(completion.resolve, completion.reject)
            return controlStartPromise
          },
          close() {
            if (!controlClosePromise) {
              const completion = Promise.withResolvers()
              controlClosePromise = completion.promise
              if (controls.get(sessionId)?.owner === app) controls.delete(sessionId)
              observations.pendingControlCloses++
              let operation
              try { operation = app.close() } catch (error) { operation = Promise.reject(error) }
              void (async () => {
                try {
                  const results = await Promise.allSettled([controlStartPromise, operation])
                  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
                  if (errors.length) throw new AggregateError(errors, 'Desktop Control app shutdown failed')
                } catch (error) {
                  observations.errors.push(error)
                  throw error
                } finally {
                  observations.pendingControlCloses--
                  registry.unregister(app)
                  if (origin) observations.controlUnregistered.push(origin)
                }
              })().then(completion.resolve, completion.reject)
            }
            return controlClosePromise
          },
        }
      },
    },
  })
  return {
    observations,
    // A read-only observation of this Host's current safety state. It neither blocks nor
    // authorizes anything, and it is never cached by the Host.
    updateSafetySnapshot: (options = {}) => composeSafetySnapshot(launchpad, options),
    get launchpadUrl() { return launchpadUrl },
    ownedOrigins: () => registry.origins(),
    isAllowedNavigation: (url) => !closing && registry.allows(url),
    resolveSessionUrl(sessionId) {
      if (closing || typeof sessionId !== 'string') return undefined
      const control = controls.get(sessionId)
      return control && control.owner.isLive?.() !== false && registry.allows(control.url) ? control.url : undefined
    },
    start() {
      if (startPromise) return startPromise
      if (closing) return Promise.reject(new Error('Desktop Host is closing'))
      const completion = Promise.withResolvers()
      startPromise = completion.promise
      void (async () => {
        const address = await launchpad.start()
        launchpadUrl = address.url
        if (!closing) registry.register(launchpad, address.url)
        return address
      })().then(completion.resolve, completion.reject)
      return startPromise
    },
    close() {
      if (!closePromise) {
        const completion = Promise.withResolvers()
        closePromise = completion.promise
        closing = true
        controls.clear()
        observations.closeCalls++
        // Launchpad closes admission synchronously and owns its startup race.
        // Attach a rejection observer now while the Host waits for start too.
        let launchpadClose
        try { launchpadClose = launchpad.close() } catch (error) { launchpadClose = Promise.reject(error) }
        void launchpadClose.catch(() => undefined)
        void Promise.resolve().then(async () => {
          const errors = []
          try {
            // The admitted start owns any listener it creates, even when its
            // await completes after close was requested. Never cache an empty close.
            try { await startPromise } catch (error) { errors.push(error) }
            try { await launchpadClose } catch (error) { errors.push(error) }
            if (observations.pendingControlCloses) errors.push(new Error('Strict Launchpad close returned before Control apps settled'))
            if (errors.length) throw new AggregateError(errors, 'Desktop Host shutdown failed')
          } finally { registry.clear() }
        }).then(completion.resolve, completion.reject)
      }
      return closePromise
    },
  }
}
