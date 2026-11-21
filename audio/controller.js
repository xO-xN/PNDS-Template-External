import dgram from 'node:dgram'
import { isIPv6 } from 'node:net'
import { encodeOsc } from './osc.js'

export function createAudio() {
  const target = process.env.PNDS_OSC_TARGET
  const separator = target?.lastIndexOf(':') ?? -1
  const host = (target?.slice(0, separator) ?? '').replace(/^\[(.*)\]$/, '$1')
  const port = Number(target?.slice(separator + 1))
  if (
    separator < 1 ||
    !host ||
    /\s/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('PNDS_OSC_TARGET must be host:port')

  let socket
  let closed = false
  return {
    status: 'ready',
    target,
    async send(address, args = []) {
      if (closed) throw new Error('The OSC controller is closed')
      if (address === '/pnds/v1/master/gain')
        throw new Error('The PNDS Host owns the master gain address')
      const packet = encodeOsc(address, args)
      socket ??= dgram.createSocket(isIPv6(host) ? 'udp6' : 'udp4')
      await new Promise((resolve, reject) =>
        socket.send(packet, port, host, error =>
          error ? reject(error) : resolve()
        )
      )
    },
    async close() {
      if (closed) return
      closed = true
      if (socket) await new Promise(resolve => socket.close(resolve))
    },
  }
}
