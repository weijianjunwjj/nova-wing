import { createNovaWingLaunchpad, createProductionWorkSessionUi } from 'nova-wing/development-guardian'
import { createNavigationRegistry } from './navigation.mjs'

/** Thin ownership wrapper. Task execution and HTTP/SSE remain in the existing factories. */
export async function createDesktopHost({ configDirectory, env, dependencies, launchpadFactory = createNovaWingLaunchpad }) {
  const registry = createNavigationRegistry()
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
        const app = await createWorkSession(config, options)
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
    get launchpadUrl() { return launchpadUrl },
    ownedOrigins: () => registry.origins(),
    isAllowedNavigation: (url) => !closing && registry.allows(url),
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
