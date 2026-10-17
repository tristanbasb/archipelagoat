// The app's own WebSocket connections to a local server, in Archipelago's network protocol (0.6.8).
//
// - `pokeServer` opens a connection and closes it again. websockets logs both ends (`connection open`,
//   `connection closed`), and each log line flushes the server's stdout: ArchipelagoServer 0.6.8 is a
//   frozen build that ignores PYTHONUNBUFFERED, so what its console commands print() (/players,
//   /status, /help, /save…) stays in that buffer until the next log line, however long the server
//   stays quiet (docs/verification/2026-10-16-real-run.md). Such a connection never logs in: the
//   players are not told about it (MultiServer.py:1035-1037) and it needs no password.
// - `connectTracker` logs in as a Tracker of a slot (no game, no items, no slot data) to receive the
//   team's PrintJSON ItemSend packets. Their item flags tell the class of each item, which the log line
//   of a send does not (progression, useful, trap or filler, as NetUtils.py:304-316 colors them).
//   It carries the LINK_TAG tag, which its join and leave notices print: the server manager knows
//   them for its own.
import { randomUUID } from 'node:crypto'
import type { Logger } from '@main/core/logger'
import type { ItemClass } from '@shared/types'

/** The tag of the app's tracker: its join and leave notices print it (MultiServer.py:1056-1059, 1087-1089). */
export const LINK_TAG = 'ArchipelaGOAT'

/** `Tracker` lets a client connect without playing its slot's game (MultiServer.py:1970). */
export const TRACKER_TAGS: readonly string[] = ['Tracker', LINK_TAG]

/** How long a poke waits for the server's first packet before it closes its connection anyway. */
const POKE_TIMEOUT_MS = 3000
/** How long the tracker waits to be logged in before it tries again. */
const LOGIN_TIMEOUT_MS = 10_000
/** The waits before each new attempt of the tracker; it gives up after the last one. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10_000]
/** The version the tracker announces when the install's is unknown: the one the app supports. */
const DEFAULT_VERSION: readonly [number, number, number] = [0, 6, 8]

/** What a connection tells its owner. */
export interface SocketHandlers {
  open(): void
  /** A text frame: a JSON list of packets. */
  message(text: string): void
  /** Once, whatever ended the connection (an error included). */
  close(): void
}

export interface LinkSocket {
  send(text: string): void
  close(): void
}

/** Opens a WebSocket connection. Default: the WebSocket of Node and Electron. */
export type SocketFactory = (url: string, handlers: SocketHandlers) => LinkSocket

export const openWebSocket: SocketFactory = (url, handlers) => {
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    handlers.close()
  }
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    queueMicrotask(end)
    return { send: () => undefined, close: () => undefined }
  }
  ws.addEventListener('open', () => handlers.open())
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handlers.message(event.data)
  })
  ws.addEventListener('error', end)
  ws.addEventListener('close', end)
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text)
    },
    close: () => ws.close(),
  }
}

/** The class Archipelago's clients color an item with, from its flags (NetUtils.py:304-316). */
export function itemClassOf(flags: number): ItemClass {
  if (flags & 0b001) return 'progression'
  if (flags & 0b010) return 'useful'
  if (flags & 0b100) return 'trap'
  return 'filler'
}

/** Hooks a connection calls so that its owner can tell the lines the server logs about it. */
export interface ConnectionHooks {
  /** A connection is about to open: the server will log `connection open`. */
  onConnecting?: () => void
  /** That connection ended before it opened: the server logged no line about it. */
  onNeverOpened?: () => void
  /**
   * The app closes that connection, which opened: the server will log `connection closed`. Not called
   * when the server ends it first.
   */
  onClosing?: () => void
}

export interface PokeOptions extends ConnectionHooks {
  socket?: SocketFactory
  timeoutMs?: number
}

/**
 * Opens a connection to the server at `url` and closes it once the server answered (its RoomInfo) or
 * after 3 s. Resolves true when the connection opened, false otherwise; never rejects.
 */
export function pokeServer(url: string, opts: PokeOptions = {}): Promise<boolean> {
  const open = opts.socket ?? openWebSocket
  return new Promise((resolve) => {
    let opened = false
    let closing = false
    const close = (): void => {
      if (opened && !closing) opts.onClosing?.()
      closing = true
      socket.close()
    }
    opts.onConnecting?.()
    const socket = open(url, {
      open: () => {
        opened = true
      },
      message: close,
      close: () => {
        clearTimeout(timer)
        if (!opened) opts.onNeverOpened?.()
        resolve(opened)
      },
    })
    const timer = setTimeout(close, opts.timeoutMs ?? POKE_TIMEOUT_MS)
    timer.unref()
  })
}

/** An item a player found, as a PrintJSON ItemSend tells it. */
export interface ItemSend {
  /** As the log numbers it: `(Team #1)` for the first team. */
  team: number
  sender: string
  receiver: string
  itemClass: ItemClass
}

export interface TrackerOptions extends ConnectionHooks {
  url: string
  /** A slot of the game: a tracker logs in as one. */
  slot: string
  /** The game password, when there is one. */
  password: string | null
  /** The version of Archipelago (`0.6.8`), announced in the Connect packet. */
  version: string | null
  log: Logger
  onItem: (send: ItemSend) => void
  /** Logged in (true), or not any more (false). */
  onStatus?: (connected: boolean) => void
  socket?: SocketFactory
  retryDelaysMs?: readonly number[]
  loginTimeoutMs?: number
}

export interface Tracker {
  readonly connected: boolean
  /** Closes the connection; the tracker never connects again. */
  close(): void
}

type Packet = Record<string, unknown>

/** A connection of the tracker: `closing` once the app ends it. */
interface Link {
  socket: LinkSocket
  opened: boolean
  closing: boolean
}

const isRecord = (value: unknown): value is Packet =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The packets of a text frame; none when it is not a JSON list. */
function packetsOf(text: string): Packet[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

function versionOf(version: string | null): { major: number; minor: number; build: number } {
  const parts =
    /^(\d+)\.(\d+)\.(\d+)/
      .exec(version ?? '')
      ?.slice(1, 4)
      .map(Number) ?? DEFAULT_VERSION
  const [major = 0, minor = 0, build = 0] = parts
  return { major, minor, build }
}

/** The names of the slots, from the `slot_info` of a Connected packet (its keys are the slot numbers). */
function slotNames(slotInfo: unknown): Map<number, string> {
  const names = new Map<number, string>()
  if (!isRecord(slotInfo)) return names
  for (const [slot, info] of Object.entries(slotInfo)) {
    if (isRecord(info) && typeof info.name === 'string') names.set(Number(slot), info.name)
  }
  return names
}

/** The send a PrintJSON ItemSend packet stands for (MultiServer.py:1362-1380); null when it lacks a field. */
function itemSendOf(packet: Packet, names: ReadonlyMap<number, string>, team: number): ItemSend | null {
  const { item, receiving } = packet
  if (!isRecord(item) || typeof item.player !== 'number' || typeof receiving !== 'number') return null
  const sender = names.get(item.player)
  const receiver = names.get(receiving)
  if (sender === undefined || receiver === undefined) return null
  const flags = typeof item.flags === 'number' ? item.flags : 0
  return { team, sender, receiver, itemClass: itemClassOf(flags) }
}

/**
 * Logs in to the server at `url` as a Tracker of `opts.slot`, and reports the items of its team. It
 * connects again after a lost connection, or a login that takes over 10 s (1 s, 3 s, then 10 s later,
 * then gives up), but never after the server refused it (a wrong password, an unknown slot).
 */
export function connectTracker(opts: TrackerOptions): Tracker {
  const open = opts.socket ?? openWebSocket
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS
  /** The connection of the current attempt. */
  let link: Link | null = null
  let connected = false
  let stopped = false
  let failures = 0
  let retry: NodeJS.Timeout | undefined
  let login: NodeJS.Timeout | undefined
  let names = new Map<number, string>()
  let team = 1

  /** Ends the current connection from the app's side: once it opened, the server logs its closing. */
  function closeLink(): void {
    if (!link) return
    if (link.opened && !link.closing) opts.onClosing?.()
    link.closing = true
    link.socket.close()
  }

  const setConnected = (value: boolean): void => {
    if (connected === value) return
    connected = value
    opts.onStatus?.(value)
  }

  const connectPacket = (): Packet => ({
    cmd: 'Connect',
    password: opts.password,
    game: '',
    name: opts.slot,
    uuid: randomUUID(),
    version: { ...versionOf(opts.version), class: 'Version' },
    items_handling: 0,
    tags: [...TRACKER_TAGS],
    slot_data: false,
  })

  function onPackets(text: string): void {
    for (const packet of packetsOf(text)) {
      switch (packet.cmd) {
        case 'RoomInfo':
          link?.socket.send(JSON.stringify([connectPacket()]))
          break
        case 'Connected':
          clearTimeout(login)
          team = (typeof packet.team === 'number' ? packet.team : 0) + 1
          names = slotNames(packet.slot_info)
          failures = 0
          setConnected(true)
          break
        case 'ConnectionRefused':
          opts.log.warn('servers: the server refused the item tracker', { errors: packet.errors })
          stopped = true
          closeLink()
          break
        case 'PrintJSON': {
          const send = packet.type === 'ItemSend' ? itemSendOf(packet, names, team) : null
          if (send) opts.onItem(send)
          break
        }
      }
    }
  }

  function attempt(): void {
    opts.onConnecting?.()
    // A socket calls its handlers once open() returned (WebSocket events never fire synchronously).
    const handlers: SocketHandlers = {
      open: () => {
        current.opened = true
      },
      message: onPackets,
      close: () => {
        clearTimeout(login)
        link = null
        if (!current.opened) opts.onNeverOpened?.()
        setConnected(false)
        if (stopped) return
        const delay = delays[failures++]
        if (delay === undefined) {
          opts.log.warn('servers: the item tracker gave up on the server', { url: opts.url })
          return
        }
        retry = setTimeout(attempt, delay)
        retry.unref()
      },
    }
    const current: Link = { socket: open(opts.url, handlers), opened: false, closing: false }
    link = current
    login = setTimeout(closeLink, opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS)
    login.unref()
  }

  attempt()
  return {
    get connected() {
      return connected
    },
    close() {
      stopped = true
      clearTimeout(retry)
      clearTimeout(login)
      closeLink()
    },
  }
}
