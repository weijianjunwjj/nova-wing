import { createHash } from 'node:crypto'

import { DESKTOP_IDENTITY } from './identity.mjs'

// Runtime owns initial delivery + one retry (default delay 1s). A missing native
// acknowledgement therefore costs at most 11s, rather than blocking strict drain
// forever. Retention timers never keep the process alive.
export const DESKTOP_NOTIFICATION_ACKNOWLEDGEMENT_MS = 5_000
export const DESKTOP_NOTIFICATION_RETENTION_MS = 15 * 60_000
export const DESKTOP_NOTIFICATION_MAX_RETAINED = 64

const NOTIFICATION_TEXT = Object.freeze({
  COMPLETED: { title: `${DESKTOP_IDENTITY.appName} · 任务已完成`, body: '任务已经完成，点击查看结果。' },
  FAILED: { title: `${DESKTOP_IDENTITY.appName} · 任务失败`, body: '任务执行失败，点击查看详情。' },
  HUMAN_REQUIRED: { title: `${DESKTOP_IDENTITY.appName} · 需要你的处理`, body: '任务正在等待你的操作，点击继续。' },
})
const UPDATER_NOTIFICATION_SESSION = 'desktop-updater'

/**
 * notificationId already identifies the durable generation: terminal kinds have
 * a single claim per session; HUMAN_REQUIRED includes its generation. Runtime
 * retries that same claim and has no separate durable attempt id. Reuse this id
 * on retry without adding a second counter or changing the durable schema.
 */
export function desktopNotificationIdentity(kind, notification) {
  return createHash('sha256')
    .update(JSON.stringify([notification.session.id, kind, notification.notificationId]))
    .digest('hex').slice(0, 32)
}

/**
 * Main-only WorkSessionNotifier adapter; business packages never import Electron.
 * An unavailable factory returns undefined, so composition must not register a
 * DESKTOP channel (nor silently select the legacy Windows adapter).
 *
 * @param {{
 *   Notification: {
 *     new(options: import('electron').NotificationConstructorOptions): import('node:events').EventEmitter & { show(): void, close(): void },
 *     isSupported(): boolean,
 *     handleActivation?: (callback: (details: import('electron').ActivationArguments) => void) => void,
 *   },
 *   onSessionClick: (sessionId: string) => unknown,
 *   onDiagnostic?: (diagnostic: object) => void,
 *   isQuitRequested?: () => boolean,
 *   platform?: NodeJS.Platform,
 *   acknowledgementTimeoutMs?: number,
 *   retentionMs?: number,
 *   maxRetained?: number,
 * }} options
 */
export function createDesktopNotificationProvider({
  Notification, onSessionClick, onDiagnostic = () => {}, isQuitRequested = () => false,
  platform = process.platform,
  acknowledgementTimeoutMs = DESKTOP_NOTIFICATION_ACKNOWLEDGEMENT_MS,
  retentionMs = DESKTOP_NOTIFICATION_RETENTION_MS,
  maxRetained = DESKTOP_NOTIFICATION_MAX_RETAINED,
}) {
  function diagnostic(detail) {
    try { onDiagnostic(detail) } catch { /* Observability cannot affect a task. */ }
  }
  try {
    if (!Notification.isSupported()) return undefined
  } catch {
    diagnostic({ phase: 'unsupported', reason: 'CAPABILITY_CHECK_FAILED' })
    return undefined
  }
  if (!Number.isSafeInteger(acknowledgementTimeoutMs) || acknowledgementTimeoutMs <= 0 ||
      !Number.isSafeInteger(retentionMs) || retentionMs <= 0 ||
      !Number.isSafeInteger(maxRetained) || maxRetained <= 0) {
    throw new Error('Desktop notification limits must be positive integers')
  }

  const active = new Map()
  const counts = { created: 0, shown: 0, failed: 0, timedOut: 0, clicked: 0, closed: 0,
    routeFailed: 0, unresolvedActivations: 0, released: 0 }
  let updaterNotificationSequence = 0
  let closing = false
  let disposed = false
  const clicksBlocked = () => closing || disposed || isQuitRequested()

  function describe(entry, phase, extra = {}) {
    diagnostic({ phase, identity: entry.identity, sessionId: entry.sessionId, kind: entry.kind, ...extra })
  }
  function release(entry, closeNative = true) {
    if (entry.released) return
    entry.released = true
    clearTimeout(entry.ackTimer)
    clearTimeout(entry.retentionTimer)
    entry.ackTimer = undefined
    entry.retentionTimer = undefined
    active.delete(entry.identity)
    for (const [event, listener] of Object.entries(entry.listeners)) {
      entry.native.removeListener(event, listener)
    }
    if (closeNative) {
      try { entry.native.close() } catch { describe(entry, 'cleanup-failed') }
    }
    counts.released++
  }
  function fail(entry, reason) {
    if (!entry.pending || entry.released) return
    entry.pending = false
    counts.failed++
    if (reason === 'ACKNOWLEDGEMENT_TIMEOUT') counts.timedOut++
    describe(entry, 'failed', { reason })
    // Never include native error text: OS errors can contain private data.
    entry.reject(new Error(`Desktop notification failed: ${reason}`))
    release(entry)
  }
  async function activateNotification(identity) {
    if (clicksBlocked()) return false
    const entry = active.get(identity)
    if (!entry || entry.pending || entry.released || !entry.routable) return false
    counts.clicked++
    describe(entry, 'click')
    try {
      // The callback receives only session identity. Main resolves its current
      // owned Control URL; payload control/report URLs are never read here.
      await onSessionClick(entry.sessionId)
      return true
    } catch {
      counts.routeFailed++
      describe(entry, 'click-failed')
      return false
    }
  }

  if (platform === 'win32' && typeof Notification.handleActivation === 'function') {
    try {
      Notification.handleActivation(() => {
        if (clicksBlocked()) return
        // Electron 44.4.3 ActivationArguments exposes type/raw arguments and
        // optional action/reply inputs, but no documented id/groupId or raw-string
        // identity encoding. Do not guess a parser
        // or treat arguments as a URL. Live instance clicks resolve via the
        // listener below. Persisted/cold-start clicks need packaged validation.
        counts.unresolvedActivations++
        diagnostic({ phase: 'activation-unresolved', reason: 'NO_DOCUMENTED_NOTIFICATION_ID' })
      })
    } catch {
      diagnostic({ phase: 'activation-unavailable' })
    }
  }

  function deliver(kind, notification) {
    if (disposed) return Promise.reject(new Error('Desktop notification provider is disposed'))
    if (typeof notification?.session?.id !== 'string' || !notification.session.id ||
        typeof notification.notificationId !== 'string' || !notification.notificationId) {
      return Promise.reject(new Error('Desktop notification requires durable session identity'))
    }
    const identity = desktopNotificationIdentity(kind, notification)
    const existing = active.get(identity)
    if (existing) return existing.delivery
    if (active.size >= maxRetained) {
      const settled = [...active.values()].find((entry) => !entry.pending)
      if (settled) release(settled)
      else return Promise.reject(new Error('Desktop notification capacity reached'))
    }

    let native
    try {
      const text = kind === 'UP_TO_DATE'
        ? { title: DESKTOP_IDENTITY.appName, body: `已是最新版本 v${notification.version}` }
        : NOTIFICATION_TEXT[kind]
      native = new Notification({
        ...text, id: identity,
        groupId: createHash('sha256').update(notification.session.id).digest('hex').slice(0, 32),
      })
    } catch {
      counts.failed++
      diagnostic({ phase: 'failed', identity, sessionId: notification.session.id, kind, reason: 'CONSTRUCTION_FAILED' })
      return Promise.reject(new Error('Desktop notification failed: CONSTRUCTION_FAILED'))
    }
    const entry = { native, identity, kind, sessionId: notification.session.id,
      routable: kind !== 'UP_TO_DATE', pending: true,
      released: false, ackTimer: undefined, retentionTimer: undefined, listeners: {},
      resolve: () => {}, reject: (_error) => {}, delivery: Promise.resolve() }
    entry.delivery = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject })
    entry.listeners = {
      show() {
        if (!entry.pending || entry.released) return
        entry.pending = false
        clearTimeout(entry.ackTimer)
        entry.ackTimer = undefined
        counts.shown++
        entry.retentionTimer = setTimeout(() => release(entry), retentionMs)
        entry.retentionTimer.unref?.()
        describe(entry, 'show')
        entry.resolve()
      },
      failed() { fail(entry, 'NATIVE_FAILED') },
      click() { void activateNotification(identity) },
      close() {
        counts.closed++
        if (entry.pending) fail(entry, 'CLOSED_BEFORE_ACKNOWLEDGEMENT')
        // Windows timeout-close can leave a toast in Action Center. Keep the
        // instance click listener until the bounded retention ends.
      },
    }
    active.set(identity, entry)
    for (const [event, listener] of Object.entries(entry.listeners)) native.on(event, listener)
    entry.ackTimer = setTimeout(() => fail(entry, 'ACKNOWLEDGEMENT_TIMEOUT'), acknowledgementTimeoutMs)
    // Ack timer stays referenced until delivery settles; callers awaiting a
    // delivery must receive its failure even in a process without other work.
    counts.created++
    describe(entry, 'created')
    try { native.show() } catch { fail(entry, 'SHOW_FAILED') }
    return entry.delivery
  }

  return {
    notificationChannel: /** @type {const} */ ('DESKTOP'),
    notificationKinds: /** @type {const} */ (['COMPLETED', 'FAILED', 'HUMAN_REQUIRED']),
    notifyCompleted: (notification) => deliver('COMPLETED', notification),
    notifyFailed: (notification) => deliver('FAILED', notification),
    notifyHumanRequired: (notification) => deliver('HUMAN_REQUIRED', notification),
    notifyUpToDate(version) {
      if (typeof version !== 'string' || version.length === 0) {
        return Promise.reject(new Error('Desktop update notification requires a version'))
      }
      updaterNotificationSequence++
      return deliver('UP_TO_DATE', {
        session: { id: UPDATER_NOTIFICATION_SESSION },
        notificationId: `${version}:${updaterNotificationSequence}`,
        version,
      })
    },
    activateNotification,
    snapshot() {
      const entries = [...active.values()]
      return {
        closing, disposed, counts: { ...counts },
        pendingDeliveries: entries.filter((entry) => entry.pending).length,
        activeNotificationRefs: active.size,
        timerCount: entries.reduce((total, entry) => total + Number(Boolean(entry.ackTimer)) + Number(Boolean(entry.retentionTimer)), 0),
        activeNotifications: entries.map(({ identity, sessionId, kind, pending }) => ({ identity, sessionId, kind, pending })),
      }
    },
    // Closing disables UI activation immediately, while the Host's already
    // admitted notification deliveries/retries still settle in strict drain.
    beginShutdown() { closing = true },
    dispose() {
      closing = true
      disposed = true
      for (const entry of [...active.values()]) {
        if (entry.pending) fail(entry, 'PROVIDER_DISPOSED')
        else release(entry)
      }
      // handleActivation is a process-lifetime registration with no unregister
      // API. Its closure is now fail-closed and can no longer access the Host.
    },
  }
}
