import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'

/**
 * Own TCP preconnections separately from admitted HTTP requests. Node considers
 * a socket awaiting its first headers active, so server.close() can leave it
 * open even after every application operation and SSE response has drained.
 *
 * Invoke the returned cleanup immediately AFTER server.close() stops listening.
 * It never destroys a socket that has emitted a request: that request and any
 * response/SSE stream remain owned by the existing strict shutdown path.
 */
export function trackHttpPreconnections(server: Server): () => void {
  const pending = new Map<Socket, () => void>()
  let closing = false

  function forget(socket: Socket): void {
    const onClose = pending.get(socket)
    if (onClose === undefined) return
    pending.delete(socket)
    socket.off('close', onClose)
  }

  server.on('connection', (socket: Socket) => {
    // A connection already accepted by the OS can be delivered while close is
    // settling. It owns no admitted HTTP operation and must not extend drain.
    if (closing) {
      socket.destroy()
      return
    }
    const onClose = (): void => forget(socket)
    pending.set(socket, onClose)
    socket.once('close', onClose)
  })
  // Mark the ownership transfer before a request handler can reenter close().
  server.prependListener('request', (request: IncomingMessage) => forget(request.socket))

  return () => {
    closing = true
    for (const socket of pending.keys()) {
      forget(socket)
      socket.destroy()
    }
  }
}
