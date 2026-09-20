import { createNovaWingLaunchpad, createProductionWorkSessionUi } from 'nova-wing/development-guardian'
import { createNavigationRegistry } from './navigation.mjs'

/** Thin ownership wrapper. Task execution and HTTP/SSE remain in the existing factories. */
export async function createDesktopHost({ configDirectory, env, dependencies }) {
  const registry = createNavigationRegistry()
  const observations = { controlRegistered: [], controlUnregistered: [], closeCalls: 0, pendingControlCloses: 0, errors: [] }
  let launchpadUrl
  let closing = false
  let closePromise
  const createWorkSession = dependencies.createWorkSession ?? createProductionWorkSessionUi
  const launchpad = await createNovaWingLaunchpad({
    configDirectory, env,
    dependencies: {
      ...dependencies,
      async createWorkSession(config, options) {
        const app = await createWorkSession(config, options)
        let origin
        return {
          ...app,
          async start() {
            const address = await app.start()
            origin = registry.register(app, address.url)
            observations.controlRegistered.push(origin)
            return address
          },
          async close() {
            observations.pendingControlCloses++
            try { await app.close() } catch (error) {
              observations.errors.push(error)
              throw error
            } finally {
              observations.pendingControlCloses--
              registry.unregister(app)
              if (origin) observations.controlUnregistered.push(origin)
            }
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
    async start() {
      if (closing) throw new Error('Desktop Host is closing')
      const address = await launchpad.start()
      launchpadUrl = address.url
      registry.register(launchpad, address.url)
      return address
    },
    close() {
      if (!closePromise) {
        closing = true
        observations.closeCalls++
        closePromise = (async () => {
          try {
            await launchpad.close()
            // Observe the existing bounded close contract; do not replace its drain.
            if (observations.pendingControlCloses) throw new Error('Existing Launchpad close returned before Control apps settled')
            if (observations.errors.length) throw new AggregateError(observations.errors, 'Control app close failed')
          } finally { registry.clear() }
        })()
      }
      return closePromise
    },
  }
}
