import { createServer, type AddressInfo } from 'node:net'
import {
  connectTracker,
  itemClassOf,
  openWebSocket,
  pokeServer,
  type ItemSend,
  type SocketFactory,
  type SocketHandlers,
  type TrackerOptions,
} from '@main/core/ap/server-link'
import { silentLogger } from '../../helpers/core'

/** A connection the test plays the server of. */
interface FakeSocket {
  url: string
  sent: Record<string, unknown>[]
  closed: boolean
  /** The app asked to close it. */
  closing: boolean
  handlers: SocketHandlers
  open(): void
  receive(...packets: unknown[]): void
  end(): void
}

function fakeSockets(): { socket: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const socket: SocketFactory = (url, handlers) => {
    const fake: FakeSocket = {
      url,
      sent: [],
      closed: false,
      closing: false,
      handlers,
      open: () => handlers.open(),
      receive: (...packets) => handlers.message(JSON.stringify(packets)),
      end() {
        if (fake.closed) return
        fake.closed = true
        handlers.close()
      },
    }
    sockets.push(fake)
    return {
      send: (text) => void fake.sent.push(...(JSON.parse(text) as Record<string, unknown>[])),
      close() {
        fake.closing = true
        queueMicrotask(() => fake.end())
      },
    }
  }
  return { socket, sockets }
}

const SLOT_INFO = {
  '1': { name: 'Alice', game: 'Pokemon Emerald', type: 1, group_members: [], class: 'NetworkSlot' },
  '2': { name: 'Bob', game: 'A Hat in Time', type: 1, group_members: [], class: 'NetworkSlot' },
}

const itemSend = (player: number, receiving: number, flags?: number): Record<string, unknown> => ({
  cmd: 'PrintJSON',
  type: 'ItemSend',
  receiving,
  item: { item: 77, location: 88, player, ...(flags === undefined ? {} : { flags }), class: 'NetworkItem' },
  data: [],
})

function track(overrides: Partial<TrackerOptions> = {}) {
  const { socket, sockets } = fakeSockets()
  const items: ItemSend[] = []
  const statuses: boolean[] = []
  const hooks = { connecting: 0, neverOpened: 0, closing: 0 }
  const tracker = connectTracker({
    url: 'ws://127.0.0.1:38281',
    slot: 'Alice',
    password: null,
    version: '0.6.8',
    log: silentLogger,
    socket,
    onItem: (send) => void items.push(send),
    onStatus: (connected) => void statuses.push(connected),
    onConnecting: () => void hooks.connecting++,
    onNeverOpened: () => void hooks.neverOpened++,
    onClosing: () => void hooks.closing++,
    ...overrides,
  })
  return { tracker, sockets, items, statuses, hooks }
}

/** A port nothing listens on. */
async function releasedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

describe('itemClassOf', () => {
  it('colors an item as Archipelago does: progression first, then useful, then trap', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(itemClassOf)).toEqual([
      'filler',
      'progression',
      'useful',
      'progression',
      'trap',
      'progression',
      'useful',
      'progression',
    ])
    // Flags Archipelago does not know make no class of their own.
    expect(itemClassOf(0b1000)).toBe('filler')
  })
})

describe('pokeServer', () => {
  it('opens a connection and closes it once the server answered, without a word', async () => {
    const { socket, sockets } = fakeSockets()
    const onNeverOpened = vi.fn()
    const onClosing = vi.fn()
    const poked = pokeServer('ws://127.0.0.1:38281', { socket, onNeverOpened, onClosing })
    const [fake] = sockets
    if (!fake) throw new Error('no connection')
    expect(fake.url).toBe('ws://127.0.0.1:38281')
    fake.open()
    expect(fake.closing).toBe(false)
    fake.receive({ cmd: 'RoomInfo' })
    // Said before the closing goes out: the server logs it afterwards.
    expect(onClosing).toHaveBeenCalledOnce()
    expect(fake.closing).toBe(true)

    expect(await poked).toBe(true)
    expect(fake.closed).toBe(true)
    expect(fake.sent).toEqual([])
    expect(onNeverOpened).not.toHaveBeenCalled()
    expect(onClosing).toHaveBeenCalledOnce()
  })

  it('gives up after its timeout on a server that never answers', async () => {
    const { socket, sockets } = fakeSockets()
    const onClosing = vi.fn()
    const poked = pokeServer('ws://127.0.0.1:38281', { socket, timeoutMs: 20, onClosing })
    sockets[0]?.open()
    expect(await poked).toBe(true)
    expect(sockets[0]?.closed).toBe(true)
    expect(onClosing).toHaveBeenCalledOnce()
  })

  it('owes no closing for a connection that never opened', async () => {
    const { socket, sockets } = fakeSockets()
    const onClosing = vi.fn()
    const poked = pokeServer('ws://127.0.0.1:38281', { socket, timeoutMs: 20, onClosing })
    expect(await poked).toBe(false)
    expect(sockets[0]?.closed).toBe(true)
    expect(onClosing).not.toHaveBeenCalled()
  })

  it('answers false, and says so, when nothing listens (a real WebSocket)', async () => {
    const onConnecting = vi.fn()
    const onNeverOpened = vi.fn()
    const url = `ws://127.0.0.1:${await releasedPort()}`
    expect(await pokeServer(url, { socket: openWebSocket, onConnecting, onNeverOpened })).toBe(false)
    expect(onConnecting).toHaveBeenCalledOnce()
    expect(onNeverOpened).toHaveBeenCalledOnce()
  })

  it('answers false for an address WebSocket refuses', async () => {
    expect(await pokeServer('not a url')).toBe(false)
  })
})

describe('connectTracker', () => {
  it('logs in as a Tracker of its slot once the server sent its RoomInfo', () => {
    const { sockets, hooks } = track({ password: 'hunter2', version: '0.6.8' })
    const [fake] = sockets
    expect(hooks.connecting).toBe(1)
    fake?.open()
    expect(fake?.sent).toEqual([])
    fake?.receive({ cmd: 'RoomInfo', password: true })
    expect(fake?.sent).toEqual([
      {
        cmd: 'Connect',
        password: 'hunter2',
        game: '',
        name: 'Alice',
        uuid: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        version: { major: 0, minor: 6, build: 8, class: 'Version' },
        items_handling: 0,
        tags: ['Tracker', 'ArchipelaGOAT'],
        slot_data: false,
      },
    ])
  })

  it('announces the version of the install, or 0.6.8 when it is unknown', () => {
    for (const [version, expected] of [
      ['0.7.1', { major: 0, minor: 7, build: 1 }],
      ['0.6.9-rc1', { major: 0, minor: 6, build: 9 }],
      [null, { major: 0, minor: 6, build: 8 }],
      ['dev', { major: 0, minor: 6, build: 8 }],
    ] as const) {
      const { sockets, tracker } = track({ version })
      sockets[0]?.receive({ cmd: 'RoomInfo' })
      expect(sockets[0]?.sent[0]?.version).toEqual({ ...expected, class: 'Version' })
      tracker.close()
    }
  })

  it('reports each item of the team with its class, the slots named after the Connected packet', () => {
    const { tracker, sockets, items, statuses } = track()
    const [fake] = sockets
    fake?.open()
    fake?.receive({ cmd: 'RoomInfo' })
    expect(tracker.connected).toBe(false)
    fake?.receive({ cmd: 'Connected', team: 1, slot: 1, slot_info: SLOT_INFO })
    expect(tracker.connected).toBe(true)
    expect(statuses).toEqual([true])

    fake?.receive(
      itemSend(1, 2, 0b001),
      itemSend(2, 2),
      { cmd: 'PrintJSON', type: 'Chat', data: [{ text: 'Bob: hi' }] },
      // A slot the Connected packet did not name, and a packet without its item.
      itemSend(9, 2, 0b001),
      { cmd: 'PrintJSON', type: 'ItemSend', receiving: 2 },
    )
    fake?.handlers.message('not json')
    fake?.handlers.message('{"cmd": "PrintJSON"}')

    expect(items).toEqual([
      { team: 2, sender: 'Alice', receiver: 'Bob', itemClass: 'progression' },
      { team: 2, sender: 'Bob', receiver: 'Bob', itemClass: 'filler' },
    ])
  })

  it('connects again after a lost connection, then gives up', async () => {
    const warn = vi.fn()
    const { sockets, statuses, hooks } = track({
      retryDelaysMs: [5, 5],
      log: { ...silentLogger, warn },
    })
    sockets[0]?.open()
    sockets[0]?.receive({ cmd: 'RoomInfo' }, { cmd: 'Connected', team: 0, slot: 1, slot_info: SLOT_INFO })
    sockets[0]?.end()
    expect(statuses).toEqual([true, false])

    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    // Refused at the TCP level: it never opened.
    sockets[1]?.end()
    await vi.waitFor(() => expect(sockets).toHaveLength(3))
    sockets[2]?.end()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sockets).toHaveLength(3)
    // The server ended them: the app closed none.
    expect(hooks).toEqual({ connecting: 3, neverOpened: 2, closing: 0 })
    expect(warn).toHaveBeenCalledWith('servers: the item tracker gave up on the server', {
      url: 'ws://127.0.0.1:38281',
    })
  })

  it('a login counts as a success: the next lost connection gets every retry again', async () => {
    const { sockets } = track({ retryDelaysMs: [5] })
    sockets[0]?.end()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    sockets[1]?.open()
    sockets[1]?.receive({ cmd: 'RoomInfo' }, { cmd: 'Connected', team: 0, slot: 1, slot_info: SLOT_INFO })
    sockets[1]?.end()
    await vi.waitFor(() => expect(sockets).toHaveLength(3))
  })

  it('never comes back once refused', async () => {
    const warn = vi.fn()
    const { sockets, statuses, hooks } = track({ retryDelaysMs: [5], log: { ...silentLogger, warn } })
    sockets[0]?.open()
    sockets[0]?.receive({ cmd: 'RoomInfo' }, { cmd: 'ConnectionRefused', errors: ['InvalidSlot'] })
    await vi.waitFor(() => expect(sockets[0]?.closed).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sockets).toHaveLength(1)
    expect(statuses).toEqual([])
    expect(hooks.closing).toBe(1)
    expect(warn).toHaveBeenCalledWith('servers: the server refused the item tracker', {
      errors: ['InvalidSlot'],
    })
  })

  it('tries again when the login takes too long', async () => {
    const { sockets, hooks } = track({ retryDelaysMs: [5], loginTimeoutMs: 20 })
    sockets[0]?.open()
    await vi.waitFor(() => expect(sockets[0]?.closing).toBe(true))
    expect(hooks.closing).toBe(1)
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
  })

  it('close() ends the connection for good', async () => {
    const { tracker, sockets, statuses, hooks } = track({ retryDelaysMs: [5] })
    sockets[0]?.open()
    sockets[0]?.receive({ cmd: 'RoomInfo' }, { cmd: 'Connected', team: 0, slot: 1, slot_info: SLOT_INFO })

    tracker.close()
    tracker.close()

    expect(hooks.closing).toBe(1)
    await vi.waitFor(() => expect(sockets[0]?.closed).toBe(true))
    expect(statuses).toEqual([true, false])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sockets).toHaveLength(1)
  })
})
