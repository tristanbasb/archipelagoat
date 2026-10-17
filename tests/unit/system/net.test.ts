import { createServer, type AddressInfo, type Server } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import type { Http } from '@main/core/context'
import {
  classifyInterface,
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
    expect(
      await findFreePort(reserved, reserved, new Set([reserved])).catch((e: unknown) => e),
    ).toMatchObject({
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

  it('leaves out WSL and labels Tailscale, as on the PC of the real run', () => {
    // The interfaces of docs/verification/2026-10-16-real-run.md, in the order Windows gives them.
    const ifaces = {
      Tailscale: [v4('100.85.10.20')],
      Ethernet: [v4('192.168.1.20')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
      'vEthernet (WSL (Hyper-V firewall))': [v4('172.23.160.1')],
    }
    expect(listAddresses(ifaces, 38281)).toEqual([
      { kind: 'localhost', host: 'localhost', port: 38281 },
      { kind: 'lan', host: '192.168.1.20', port: 38281 },
      { kind: 'vpn', network: 'Tailscale', host: '100.85.10.20', port: 38281 },
    ])
  })

  it('leaves out the networks of virtual machines and containers', () => {
    const ifaces = {
      'vEthernet (Default Switch)': [v4('172.20.48.1')],
      'vEthernet (WSL)': [v4('172.23.160.1')],
      'vEthernet (DockerNAT)': [v4('10.0.75.1')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1')],
      'VMware Network Adapter VMnet8': [v4('192.168.152.1')],
      docker0: [v4('172.17.0.1')],
      'br-0123456789ab': [v4('172.18.0.1')],
      veth1a2b3c4: [v4('172.18.0.2')],
      virbr0: [v4('192.168.122.1')],
      vboxnet0: [v4('192.168.57.1')],
      lxdbr0: [v4('10.10.10.1')],
      'cni-podman0': [v4('10.88.0.1')],
      wlan0: [v4('192.168.1.42')],
    }
    expect(listAddresses(ifaces, 38281)).toEqual([
      { kind: 'localhost', host: 'localhost', port: 38281 },
      { kind: 'lan', host: '192.168.1.42', port: 38281 },
    ])
  })

  it('keeps a Hyper-V switch the user made: an external one carries the real network', () => {
    expect(listAddresses({ 'vEthernet (External Switch)': [v4('192.168.1.20')] }, 5)).toEqual([
      { kind: 'localhost', host: 'localhost', port: 5 },
      { kind: 'lan', host: '192.168.1.20', port: 5 },
    ])
  })

  it('lists the VPN addresses after the local network ones', () => {
    const ifaces = {
      'ZeroTier One [8056c2e21c000001]': [v4('10.147.17.5')],
      ztabcdef12: [v4('10.147.18.5')],
      Hamachi: [v4('25.10.20.30')],
      tun0: [v4('10.8.0.6')],
      eth0: [v4('192.168.1.20')],
      nb0: [v4('100.100.1.2')],
    }
    expect(listAddresses(ifaces, 38281)).toEqual([
      { kind: 'localhost', host: 'localhost', port: 38281 },
      { kind: 'lan', host: '192.168.1.20', port: 38281 },
      { kind: 'vpn', network: 'ZeroTier', host: '10.147.17.5', port: 38281 },
      { kind: 'vpn', network: 'ZeroTier', host: '10.147.18.5', port: 38281 },
      { kind: 'vpn', network: 'Hamachi', host: '25.10.20.30', port: 38281 },
      { kind: 'vpn', host: '10.8.0.6', port: 38281 },
      { kind: 'vpn', host: '100.100.1.2', port: 38281 },
    ])
  })
})

describe('classifyInterface', () => {
  it('calls 100.64.0.0/10 a VPN whatever the interface, and only that range', () => {
    expect(classifyInterface('Ethernet 3', '100.64.0.1')).toEqual({ kind: 'vpn' })
    expect(classifyInterface('Ethernet 3', '100.127.255.254')).toEqual({ kind: 'vpn' })
    expect(classifyInterface('Ethernet 3', '100.63.255.255')).toEqual({ kind: 'lan' })
    expect(classifyInterface('Ethernet 3', '100.128.0.1')).toEqual({ kind: 'lan' })
  })

  it('names the VPNs players use to play together', () => {
    expect(classifyInterface('tailscale0', '100.101.102.103')).toEqual({ kind: 'vpn', network: 'Tailscale' })
    expect(classifyInterface('Radmin VPN', '26.1.2.3')).toEqual({ kind: 'vpn', network: 'Radmin VPN' })
    expect(classifyInterface('wg0', '10.6.0.2')).toEqual({ kind: 'vpn', network: 'WireGuard' })
    expect(classifyInterface('OpenVPN TAP-Windows6', '10.8.0.6')).toEqual({ kind: 'vpn', network: 'OpenVPN' })
  })

  it('keeps ordinary adapters as the local network', () => {
    for (const name of ['Ethernet', 'Wi-Fi', 'eth0', 'enp3s0', 'wlp2s0', 'en0', 'Ethernet 2']) {
      expect(classifyInterface(name, '192.168.1.20')).toEqual({ kind: 'lan' })
    }
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
