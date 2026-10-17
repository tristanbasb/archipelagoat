// Network helpers of the local server (spec §3.11): a free port for it, a TCP probe that tells when it
// accepts connections, and the addresses players can use. The app never listens on anything but
// loopback: a listen on 0.0.0.0 would make Windows ask whether to let ArchipelaGOAT through its firewall.
import { connect, createServer } from 'node:net'
import os from 'node:os'
import { AppError } from '@shared/errors'
import type { Address } from '@shared/types'
import type { Http } from '../context'

/** Archipelago's default port, then the next ones (spec §3.11). */
export const DEFAULT_PORT = 38281
export const MAX_PORT = 38381

const PUBLIC_IP_URL = 'https://checkip.amazonaws.com'
const PUBLIC_IP_TIMEOUT_MS = 5000
const PROBE_TIMEOUT_MS = 1000
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/** True when something accepts a TCP connection on `host:port` within `timeoutMs`. */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Whether this process may listen on `127.0.0.1:port` (a port reserved by Windows answers EACCES). */
function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/**
 * True when Archipelago can take `port`: nothing answers on it, over IPv4 or IPv6 loopback (Windows
 * lets a server hold 0.0.0.0 or ::1 while 127.0.0.1 can still be bound), and loopback can be bound.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (await probePort(port, '127.0.0.1')) return false
  if (await probePort(port, '::1')) return false
  return canBindLoopback(port)
}

/** The first free port from `start` to `max`; PORT_IN_USE{port: start} when there is none. */
export async function findFreePort(start = DEFAULT_PORT, max = MAX_PORT): Promise<number> {
  for (let port = start; port <= max; port++) {
    if (await isPortFree(port)) return port
  }
  throw new AppError('PORT_IN_USE', { port: start }, { detail: `no free port from ${start} to ${max}` })
}

/**
 * The addresses to give players: localhost, then every IPv4 address of the network interfaces, once
 * each. Internal (loopback) and link-local (169.254/16, which no router serves) addresses are left out,
 * so is IPv6, which players rarely can use.
 */
export function listAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  port: number,
): Address[] {
  const lan = new Set<string>()
  for (const infos of Object.values(ifaces)) {
    for (const info of infos ?? []) {
      // Node 18.0 to 18.3 gave the family as a number.
      const ipv4 = String(info.family) === 'IPv4' || String(info.family) === '4'
      if (ipv4 && !info.internal && !info.address.startsWith('169.254.')) lan.add(info.address)
    }
  }
  return [
    { kind: 'localhost', host: 'localhost', port },
    ...[...lan].map((host): Address => ({ kind: 'lan', host, port })),
  ]
}

/** This machine's public IPv4 address, as checkip.amazonaws.com sees it; null when it cannot tell. */
export async function fetchPublicIp(http: Pick<Http, 'fetchRaw'>): Promise<string | null> {
  try {
    const res = await http.fetchRaw(PUBLIC_IP_URL, {
      timeoutMs: PUBLIC_IP_TIMEOUT_MS,
      // fetchRaw's timeout ends with the headers: this one covers the body too.
      signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return null
    }
    const text = (await res.text()).trim()
    return IPV4.test(text) ? text : null
  } catch {
    return null
  }
}
