/** Origins enter this registry only after a Host-owned server starts listening. */
export function createNavigationRegistry() {
  const owners = new Map()
  const parse = (value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port &&
        !url.username && !url.password ? url.origin : undefined
    } catch { return undefined }
  }
  return {
    register(owner, url) {
      const origin = parse(url)
      if (!origin) throw new Error('Owned server must return an explicit HTTP loopback port')
      owners.set(owner, origin)
      return origin
    },
    unregister(owner) { owners.delete(owner) },
    allows(url) {
      const origin = parse(url)
      return origin !== undefined && [...owners.values()].includes(origin)
    },
    origins() { return [...new Set(owners.values())] },
    clear() { owners.clear() },
  }
}
