// Network helpers of the local server (spec §3.11): a free port for it, a TCP probe that tells when it
// accepts connections, and the addresses players can use. The app never listens on anything but
// loopback: a listen on 0.0.0.0 would make Windows ask whether to let ArchipelaGOAT through its firewall.
import { connect, createServer } from 'node:net'
import os from 'node:os'
import { DEFAULT_PORT } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { Address } from '@shared/types'
import type { Http } from '../context'

/** The last port a server may take: Archipelago's default (38281), then the next ones (spec §3.11). */
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

/**
 * The first free port from `start` to `max`; PORT_IN_USE{port: start} when there is none. The ports
 * in `exclude` are skipped without a probe: those of servers that are still starting, which the OS
 * calls free until they bind, and those of running servers, whose console a probe would litter.
 */
export async function findFreePort(
  start = DEFAULT_PORT,
  max = MAX_PORT,
  exclude: ReadonlySet<number> = new Set(),
): Promise<number> {
  for (let port = start; port <= max; port++) {
    if (!exclude.has(port) && (await isPortFree(port))) return port
  }
  throw new AppError('PORT_IN_USE', { port: start }, { detail: `no free port from ${start} to ${max}` })
}

/**
 * Networks only the virtual machines and containers of this PC reach, by interface name: a friend can
 * never use their addresses. Hyper-V's own switches only (a switch the user made may be the one that
 * carries the real LAN, as an external switch does).
 */
const HOST_ONLY_INTERFACES: readonly RegExp[] = [
  /^vEthernet \((?:WSL|Default Switch|DockerNAT|nat)\b/i, // Hyper-V: WSL, the Default Switch, Docker Desktop
  /^(?:docker\d+|br-[0-9a-f]{12}|veth\w*)$/i, // Docker under Linux: its bridges and container links
  /^(?:virbr|vboxnet|vmnet|lxcbr|lxdbr|incusbr|cni|cni-podman|podman)\d+$/i, // libvirt, VirtualBox, VMware, LXC/LXD/Incus, Podman
  /^(?:VirtualBox Host-Only|VMware Network Adapter VMnet)/i, // VirtualBox and VMware under Windows
]

/** VPNs players can join, by interface name, with the name players know them by. */
const VPN_INTERFACES: readonly (readonly [RegExp, string])[] = [
  [/tailscale/i, 'Tailscale'],
  [/zerotier|^zt[0-9a-z]{6,}$/i, 'ZeroTier'],
  [/hamachi|^ham\d+$/i, 'Hamachi'],
  [/radmin vpn/i, 'Radmin VPN'],
  [/wireguard|^wg\d+$/i, 'WireGuard'],
  [/openvpn/i, 'OpenVPN'],
]

/** Other tunnels: a VPN whose name does not say which. */
const TUNNEL_INTERFACE = /^(?:tun|tap|utun|ppp)\d+$/i

/**
 * 100.64.0.0/10, the shared address space of RFC 6598: no home router hands it out, and Tailscale
 * (or another mesh VPN) gives every machine of its network an address there.
 */
function isSharedAddressSpace(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 100 && b !== undefined && b >= 64 && b <= 127
}

/**
 * What an interface is to the players: their local network, a VPN they must also be on (with its
 * name when the interface tells it), or a network of this PC's virtual machines and containers,
 * which no player reaches (null).
 */
export function classifyInterface(
  name: string,
  address: string,
): { kind: 'lan' } | { kind: 'vpn'; network?: string } | null {
  if (HOST_ONLY_INTERFACES.some((re) => re.test(name))) return null
  const vpn = VPN_INTERFACES.find(([re]) => re.test(name))
  if (vpn) return { kind: 'vpn', network: vpn[1] }
  if (TUNNEL_INTERFACE.test(name) || isSharedAddressSpace(address)) return { kind: 'vpn' }
  return { kind: 'lan' }
}

/**
 * The addresses to give players: localhost, then every IPv4 address of the network interfaces, once
 * each: the local network ones, then the VPN ones. Internal (loopback) and link-local (169.254/16,
 * which no router serves) addresses are left out, so are the networks of this PC's virtual machines
 * and containers (WSL, Docker…), and IPv6, which players rarely can use.
 */
export function listAddresses(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  port: number,
): Address[] {
  const found = new Map<string, Address>()
  for (const [name, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      // Node 18.0 to 18.3 gave the family as a number.
      const ipv4 = String(info.family) === 'IPv4' || String(info.family) === '4'
      if (!ipv4 || info.internal || info.address.startsWith('169.254.') || found.has(info.address)) continue
      const what = classifyInterface(name, info.address)
      if (what) found.set(info.address, { ...what, host: info.address, port })
    }
  }
  const addresses = [...found.values()]
  return [
    { kind: 'localhost', host: 'localhost', port },
    ...addresses.filter((address) => address.kind === 'lan'),
    ...addresses.filter((address) => address.kind === 'vpn'),
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
