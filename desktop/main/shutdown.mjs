/** @param {unknown} error @param {number} [depth] @returns {unknown} */
export function describeShutdownError(error, depth = 0) {
  if (!(error instanceof Error)) return { message: String(error) }
  return {
    name: error.name, message: error.message, stack: error.stack,
    ...('code' in error ? { code: error.code } : {}),
    ...(depth < 8 && error.cause !== undefined ? { cause: describeShutdownError(error.cause, depth + 1) } : {}),
    ...(depth < 8 && error instanceof AggregateError
      ? { errors: error.errors.map((item) => describeShutdownError(item, depth + 1)) } : {}),
  }
}

/**
 * One owner for Main startup, repeated before-quit events and final app.quit.
 * A failure remains fail-closed: no final quit is authorized as graceful success.
 * @param {{ getStartup: () => Promise<unknown>, getHost: () => { close: () => Promise<void> } | undefined,
 *   requestFinalQuit: () => void, reportFailure: (error: unknown) => void }} options
 */
export function createShutdownCoordinator({ getStartup, getHost, requestFinalQuit, reportFailure }) {
  let shutdownPromise
  let quitContinuationAttached = false
  let requested = false
  let completed = false
  const observations = { quitRequests: 0, shutdownOperations: 0, finalQuitRequests: 0, failures: 0 }

  function shutdown() {
    if (!shutdownPromise) {
      const completion = Promise.withResolvers()
      shutdownPromise = completion.promise
      requested = true
      observations.shutdownOperations++
      // Stop admission immediately when startup has already assigned its owner.
      let admittedClose
      try { admittedClose = getHost()?.close() } catch (error) { admittedClose = Promise.reject(error) }
      void admittedClose?.catch(() => undefined)
      void Promise.resolve().then(async () => {
        const errors = []
        // Includes factory creation while Main has no host reference yet.
        try { await getStartup() } catch (error) { errors.push(error) }
        try { await (admittedClose ?? getHost()?.close()) } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Desktop strict shutdown failed')
        completed = true
      }).then(completion.resolve, completion.reject)
    }
    return shutdownPromise
  }

  return {
    observations, shutdown,
    get requested() { return requested },
    get completed() { return completed },
    beforeQuit(event) {
      if (completed) return
      event.preventDefault()
      observations.quitRequests++
      const operation = shutdown()
      if (quitContinuationAttached) return
      quitContinuationAttached = true
      void operation.then(() => {
        observations.finalQuitRequests++
        requestFinalQuit()
      }, (error) => {
        observations.failures++
        reportFailure(error)
      })
    },
  }
}
