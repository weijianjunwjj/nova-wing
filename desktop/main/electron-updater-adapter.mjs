/**
 * The real electron-updater adapter.
 *
 * It wraps electron-updater and nothing else: the state machine, the install gate and the
 * one-shot authorization all stay in updater.mjs and the exit assembly. This module never
 * imports electron, never quits the app and never installs anything by itself — the instance it
 * drives is injected, so it is testable against a fake facade and reachable in the product only
 * through Main's single final-quit router.
 *
 * Explicit policy, never electron-updater's defaults:
 * - autoDownload = false          — a check must not start a download.
 * - autoInstallOnAppQuit = false  — an ordinary quit must never install a staged update.
 * - allowDowngrade = false        — an older feed entry is not an update.
 * - allowPrerelease = false       — a prerelease feed entry is not an update.
 */

/** Failure codes this adapter raises. Stable strings. */
export const ADAPTER_REASON = Object.freeze({
  INSTANCE_REQUIRED: 'UPDATER_INSTANCE_REQUIRED',
  FEED_INCOMPLETE: 'UPDATER_FEED_INCOMPLETE',
  CHECK_FAILED: 'UPDATER_CHECK_FAILED',
  DOWNLOAD_FAILED: 'UPDATER_DOWNLOAD_FAILED',
  CANDIDATE_MISMATCH: 'UPDATER_CANDIDATE_MISMATCH',
  NOT_DOWNLOADED: 'UPDATER_NOT_DOWNLOADED',
})

export class UpdaterAdapterError extends Error {
  /** @param {string} code @param {unknown} cause */
  constructor(code, cause) {
    super(cause instanceof Error ? `${code}: ${cause.message}` : `${code}: ${String(cause)}`)
    this.name = 'UpdaterAdapterError'
    this.code = code
    if (cause instanceof Error) this.cause = cause
  }
}

/**
 * The candidate identity binds the feed metadata, the target version and the artifact bytes.
 * A version alone is not an identity: the same version can be re-published with different bytes,
 * and a download must never be completed by an event for a different artifact.
 *
 * @param {{ version: string, channel: string, sha512: string }} parts
 */
export function candidateIdentity({ version, channel, sha512 }) {
  return `${version}|${channel}|${sha512}`
}

/** The artifact the feed actually designates, preferring the explicit `path` entry. */
function primaryFile(info) {
  const files = Array.isArray(info?.files) ? info.files : []
  const designated = typeof info?.path === 'string' ? files.find((file) => file?.url === info.path) : undefined
  const file = designated ?? files[0]
  if (file === null || file === undefined) return null
  if (typeof file.url !== 'string' || typeof file.sha512 !== 'string') return null
  return { url: file.url, sha512: file.sha512, size: typeof file.size === 'number' ? file.size : null }
}

/**
 * @param {{ autoUpdater: object, channel?: string, feed?: object | string | null }} options
 *   `autoUpdater` is an electron-updater `AppUpdater` instance. `feed` is only ever supplied by
 *   tests and the packaged feed smoke; the product leaves it null so the packaged
 *   app-update.yml decides the feed.
 */
export function createElectronUpdaterAdapter({ autoUpdater, channel = 'latest', feed = null }) {
  if (autoUpdater === null || typeof autoUpdater !== 'object') {
    throw new UpdaterAdapterError(ADAPTER_REASON.INSTANCE_REQUIRED, new Error('an electron-updater instance is required'))
  }
  // Set explicitly rather than trusting defaults: autoInstallOnAppQuit defaults to true, which
  // would install a staged update on an ordinary quit.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  if (typeof channel === 'string' && channel.length > 0) autoUpdater.channel = channel
  if (feed !== null && feed !== undefined) autoUpdater.setFeedURL(feed)

  /** @type {Array<[string, (payload: any) => void]>} */
  let bound = []
  /** In-flight downloads, so dispose can settle them instead of leaving them dangling. */
  const inflight = new Set()
  /** The active download's failure route, if one is running. */
  /** @type {((error: unknown) => void) | null} */
  let failActiveDownload = null
  /** @type {unknown} */
  let lastError = null
  /** @type {{ version: string, identity: string } | null} */
  let downloaded = null
  let disposed = false

  function on(event, handler) {
    autoUpdater.on(event, handler)
    bound.push([event, handler])
    return () => {
      bound = bound.filter((entry) => entry[0] !== event || entry[1] !== handler)
      autoUpdater.off(event, handler)
    }
  }

  const activeChannel = () => (typeof autoUpdater.channel === 'string' ? autoUpdater.channel : channel)

  // One persistent listener, owned for the adapter's whole life. electron-updater emits `error`
  // on its own schedule, and an EventEmitter `error` with no listener throws into Main — so this
  // is bound at construction, not per download, and it only forwards while a download is running.
  on('error', (error) => {
    lastError = error
    failActiveDownload?.(error)
  })

  /**
   * Fetch and parse the update metadata. With autoDownload off this never starts a download, so
   * it is safe to call on any host.
   */
  async function check() {
    if (disposed) return { available: false }
    let result
    try {
      result = await autoUpdater.checkForUpdates()
    } catch (error) {
      throw new UpdaterAdapterError(ADAPTER_REASON.CHECK_FAILED, error)
    }
    if (result === null || result.isUpdateAvailable !== true) return { available: false }
    const info = result.updateInfo
    const file = primaryFile(info)
    if (file === null) throw new UpdaterAdapterError(ADAPTER_REASON.FEED_INCOMPLETE, new Error('the update metadata names no usable artifact'))
    return {
      available: true,
      candidate: {
        version: info.version,
        identity: candidateIdentity({ version: info.version, channel: activeChannel(), sha512: file.sha512 }),
      },
    }
  }

  /**
   * Resolve only once the artifact for this exact candidate has been written and verified by
   * electron-updater. The `update-downloaded` event is the authority because it carries which
   * candidate landed on disk; `downloadUpdate()` resolving is not enough, and an event for a
   * different candidate fails the promise instead of completing it.
   *
   * @param {{ version: string, identity: string }} candidate
   */
  function download(candidate) {
    if (disposed) return Promise.reject(new UpdaterAdapterError(ADAPTER_REASON.DOWNLOAD_FAILED, new Error('adapter disposed')))
    const completion = Promise.withResolvers()
    let settled = false
    const unbind = []
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      if (failActiveDownload === fail) failActiveDownload = null
      inflight.delete(cancel)
      for (const off of unbind) off()
      settle(value)
    }
    const fail = (error) => finish(completion.reject, new UpdaterAdapterError(ADAPTER_REASON.DOWNLOAD_FAILED, error))
    const cancel = () => finish(
      completion.reject,
      new UpdaterAdapterError(ADAPTER_REASON.DOWNLOAD_FAILED, new Error('the adapter was disposed before the download finished')),
    )
    failActiveDownload = fail
    inflight.add(cancel)
    unbind.push(on('update-downloaded', (event) => {
      const file = primaryFile(event)
      const identity = file === null ? null : candidateIdentity({ version: event.version, channel: activeChannel(), sha512: file.sha512 })
      if (identity !== candidate.identity) {
        finish(completion.reject, new UpdaterAdapterError(
          ADAPTER_REASON.CANDIDATE_MISMATCH,
          new Error(`the downloaded artifact is ${event.version} but ${candidate.version} was confirmed`),
        ))
        return
      }
      finish(completion.resolve, { version: event.version, identity })
    }))
    Promise.resolve().then(() => autoUpdater.downloadUpdate()).catch(fail)
    return completion.promise
  }

  /**
   * The install action. It is only ever reached from the single final-quit router, after the
   * strict drain has completed, and it refuses a candidate that was never downloaded here.
   *
   * @param {{ version: string, identity: string }} intent
   */
  function install(intent) {
    if (downloaded === null) {
      throw new UpdaterAdapterError(ADAPTER_REASON.NOT_DOWNLOADED, new Error('no downloaded update is staged for install'))
    }
    if (downloaded.identity !== intent.identity || downloaded.version !== intent.version) {
      throw new UpdaterAdapterError(
        ADAPTER_REASON.CANDIDATE_MISMATCH,
        new Error(`staged ${downloaded.version} but ${intent.version} was authorized`),
      )
    }
    // electron-updater stages and applies this download; it also calls app.quit() itself, which
    // is harmless here because the strict shutdown has already completed and before-quit is a
    // no-op at that point.
    autoUpdater.quitAndInstall(true, true)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    // Settle in-flight work first: a removed listener would otherwise leave its promise hanging.
    for (const cancel of [...inflight]) cancel()
    inflight.clear()
    failActiveDownload = null
    for (const [event, handler] of bound) autoUpdater.off(event, handler)
    bound = []
  }

  return {
    check,
    download: (candidate) => download(candidate).then((outcome) => { downloaded = outcome; return outcome }),
    install,
    dispose,
    /** The last error electron-updater emitted, whatever it was about. */
    lastError: () => lastError,
    /** The explicit policy actually applied, for diagnostics and tests. */
    policy: () => ({
      autoDownload: autoUpdater.autoDownload,
      autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
      allowDowngrade: autoUpdater.allowDowngrade,
      allowPrerelease: autoUpdater.allowPrerelease,
      channel: activeChannel(),
    }),
  }
}
