import { createServer, type AddressInfo, type Server } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import type { Http } from '@main/core/context'
import {
  fetchPublicIp,
  findFreePort,
  isPortFree,
  listAddresses,
  MAX_PORT,
  probePort,
} from '@main/core/system/net'
import { DEFAULT_PORT } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'

let held: Server[]

beforeEach(() => {
  held = []
})

afterEach(async () => {
  await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))))
})

/** Listens on `host` (an ephemeral port when `port` is 0) until the end of the test; null when refused. */
async function hold(host: string, port = 0): Promise<number | null> {
  const server = createServer((socket) => socket.on('error', () => undefined))
  const bound = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => resolve(true))
  })
  if (!bound) return null
  held.push(server)
  return (server.address() as AddressInfo).port
}

async function heldPort(host = '127.0.0.1'): Promise<number> {
  const port = await hold(host)
  if (port === null) throw new Error(`cannot listen on ${host}`)
  return port
}

/** A port that nothing listens on (the test released it). */
async function releasedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

const v4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:11:22:33:44:55',
  internal,
  cidr: `${address}/24`,
})

const v6 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:11:22:33:44:55',
  internal,
  cidr: `${address}/64`,
  scopeid: 0,
})

describe('ports', () => {
  it('uses 38281 to 38381 by default', () => {
    expect([DEFAULT_PORT, MAX_PORT]).toEqual([38281, 38381])
  })

  it('isPortFree tells a free port from one held on loopback', async () => {
    const port = await heldPort()
    expect(await isPortFree(port)).toBe(false)
    expect(await isPortFree(await releasedPort())).toBe(true)
  })

  it('isPortFree sees a port held on ::1 only, which binding 127.0.0.1 alone would miss', async () => {
    const port = await hold('::1')
    if (port === null) return // no IPv6 on this machine
    expect(await isPortFree(port)).toBe(false)
  })

  it('findFreePort skips the ports in use', async () => {
    const busy = await heldPort()
    const port = await findFreePort(busy, busy + 20)
    expect(port).toBeGreaterThan(busy)
    expect(port).toBeLessThanOrEqual(busy + 20)
  })

  it('findFreePort answers PORT_IN_USE when every port of the range is taken', async () => {
    const busy = await heldPort()
    const error = await findFreePort(busy, busy).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ code: 'PORT_IN_USE', params: { port: busy } })
  })

  it('findFreePort skips the excluded ports without connecting to them', async () => {
    let connections = 0
    const server = createServer((socket) => {
      connections++
      socket.on('error', () => undefined)
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    held.push(server)
    const reserved = (server.address() as AddressInfo).port
    const free = await releasedPort()

    // A port in use is not even probed when it is excluded...
    expect(await findFreePort(reserved, reserved, new Set([reserved])).catch((e: unknown) => e)).toMatchObject({
      code: 'PORT_IN_USE',
      params: { port: reserved },
    })
    expect(connections).toBe(0)
    // ...and a free port is not taken.
    expect(await findFreePort(free, free, new Set([free])).catch((e: unknown) => e)).toMatchObject({
      code: 'PORT_IN_USE',
      params: { port: free },
    })
    expect(await findFreePort(free, free, new Set([reserved]))).toBe(free)
  })

  it('probePort connects to a listening port only', async () => {
    expect(await probePort(await heldPort())).toBe(true)
    expect(await probePort(await releasedPort())).toBe(false)
  })
})

describe('listAddresses', () => {
  it('listAddresses excludes internal and IPv6 link-local', () => {
    const ifaces = {
      lo: [v4('127.0.0.1', true), v6('::1', true)],
      eth0: [v4('192.168.1.20'), v6('fe80::1c2d:3e4f:5a6b:7c8d')],
      wlan0: [v4('10.0.0.5'), v6('2001:db8::5'), v4('169.254.10.20')],
      docker0: undefined,
    }
    expect(listAddresses(ifaces, 38281)).toEqual([
      { kind: 'localhost', host: 'localhost', port: 38281 },
      { kind: 'lan', host: '192.168.1.20', port: 38281 },
      { kind: 'lan', host: '10.0.0.5', port: 38281 },
    ])
  })

  it('lists an address once and keeps localhost alone without a network', () => {
    expect(listAddresses({ a: [v4('192.168.1.20')], b: [v4('192.168.1.20')] }, 5)).toEqual([
      { kind: 'localhost', host: 'localhost', port: 5 },
      { kind: 'lan', host: '192.168.1.20', port: 5 },
    ])
    expect(listAddresses({}, 38282)).toEqual([{ kind: 'localhost', host: 'localhost', port: 38282 }])
  })

  it('reads the interfaces of this machine by default', () => {
    expect(listAddresses(undefined, 38281)[0]).toEqual({ kind: 'localhost', host: 'localhost', port: 38281 })
  })
})

describe('fetchPublicIp', () => {
  function http(answer: () => Promise<Response>): Pick<Http, 'fetchRaw'> {
    return { fetchRaw: () => answer() }
  }

  it('asks checkip.amazonaws.com with a 5 s timeout and trims the answer', async () => {
    const fetchRaw = vi.fn<Http['fetchRaw']>(() => Promise.resolve(new Response('203.0.113.7\n')))
    expect(await fetchPublicIp({ fetchRaw })).toBe('203.0.113.7')
    expect(fetchRaw).toHaveBeenCalledWith(
      'https://checkip.amazonaws.com',
      expect.objectContaining({ timeoutMs: 5000 }),
    )
  })

  it('answers null when offline, on an HTTP error or for anything but an IPv4 address', async () => {
    expect(await fetchPublicIp(http(() => Promise.reject(new AppError('NETWORK_OFFLINE'))))).toBeNull()
    expect(await fetchPublicIp(http(() => Promise.resolve(new Response('busy', { status: 503 }))))).toBeNull()
    expect(await fetchPublicIp(http(() => Promise.resolve(new Response('<html>portal</html>'))))).toBeNull()
    expect(await fetchPublicIp(http(() => Promise.resolve(new Response('999.1.2.3'))))).toBeNull()
  })
})
