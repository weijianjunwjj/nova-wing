/**
 * Main-only policy adapter. Its input is in-process operation activity, never a
 * durable session state, a renderer message, or the tray's display label.
 * @param {{ powerSaveBlocker: Pick<import('electron').PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>,
 *   reportFailure?: (error: unknown) => void }} options
 */
export function createDesktopPowerManager({ powerSaveBlocker, reportFailure = () => {} }) {
  const activities = new Set()
  const listeners = new Set()
  let blockerId
  let disposed = false
  const observations = { starts: 0, stops: 0, errors: [] }

  function report(error) {
    observations.errors.push(error)
    try { reportFailure(error) } catch { /* Diagnostics cannot change an operation. */ }
  }
  function stopBlocker() {
    if (blockerId === undefined) return
    // Retain the id if native stop fails so the next transition/final cleanup
    // can retry rather than losing ownership of an OS resource.
    powerSaveBlocker.stop(blockerId)
    observations.stops++
    blockerId = undefined
  }
  function snapshot() {
    return {
      activeCount: activities.size, blockerId,
      blockerActive: blockerId !== undefined && powerSaveBlocker.isStarted(blockerId),
      startCount: observations.starts, stopCount: observations.stops,
    }
  }
  function reconcile() {
    try {
      if (activities.size > 0 && blockerId === undefined) {
        blockerId = powerSaveBlocker.start('prevent-app-suspension')
        observations.starts++
      } else if (activities.size === 0) stopBlocker()
    } catch (error) { report(error) }
    for (const listener of listeners) {
      try { listener(activities.size) } catch (error) { report(error) }
    }
  }
  return {
    observations, snapshot,
    observe(event) {
      if (disposed) return
      if (event.phase === 'started') activities.add(event.activityId)
      else if (event.phase === 'ended') activities.delete(event.activityId)
      else return
      reconcile()
    },
    subscribe(listener) {
      listeners.add(listener)
      try { listener(activities.size) } catch (error) { report(error) }
      return () => { listeners.delete(listener) }
    },
    // Only the successful strict shutdown continuation calls this fail-safe.
    // Never called by close->hide, crash, reload, or a pending/failed drain.
    dispose() {
      stopBlocker()
      disposed = true
      activities.clear()
      listeners.clear()
    },
  }
}
