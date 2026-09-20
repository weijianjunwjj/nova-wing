import { createHook } from 'node:async_hooks'

const trackedTypes = new Set([
  'Timeout', 'PROCESSWRAP', 'TCPWRAP', 'TCPSERVERWRAP', 'PIPEWRAP',
  'PIPESERVERWRAP', 'UDPWRAP', 'UDPSENDWRAP', 'TLSWRAP',
])

/** Track each resource created after observation begins, including unref handles. */
export function createResourceTracker() {
  /** @type {Map<number, { type: string, triggerAsyncId: number, resource: { hasRef?: () => boolean } }>} */
  const live = new Map()
  /** @type {Record<string, number>} */
  const created = {}
  const hook = createHook({
    init(asyncId, type, triggerAsyncId, resource) {
      if (!trackedTypes.has(type)) return
      live.set(asyncId, { type, triggerAsyncId, resource })
      created[type] = (created[type] ?? 0) + 1
    },
    destroy(asyncId) { live.delete(asyncId) },
  })
  hook.enable()
  return {
    snapshot() {
      return {
        created: { ...created },
        live: [...live].map(([asyncId, { type, triggerAsyncId, resource }]) => ({
          asyncId,
          type,
          triggerAsyncId,
          refed: typeof resource.hasRef === 'function' ? resource.hasRef() : null,
        })),
      }
    },
    stop() { hook.disable() },
  }
}
