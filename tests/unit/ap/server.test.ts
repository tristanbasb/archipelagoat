import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocator, type Locator } from '@main/core/ap/locator'
import type { ApExit, ApProcess, SpawnApOptions } from '@main/core/ap/process'
import type { Orphan, OrphanStop } from '@main/core/ap/processes'
import {
  buildServerArgs,
  createServerManager,
  parseServerLine,
  quoteConsoleArg,
  type ServerManager,
  type ServerManagerDeps,
} from '@main/core/ap/server'
import type { SocketFactory, SocketHandlers } from '@main/core/ap/server-link'
import { createApSettings, type ApSettings } from '@main/core/ap/settings'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import { MASK } from '@main/core/system/redact'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `sessions` and `servers` entries of Services (the files are loaded by import.meta.glob at run time).
import type {} from '@main/services/servers.service'
import type {} from '@main/services/sessions.service'
import { AppError } from '@shared/errors'
import type { IpcResult } from '@shared/ipc/contract'
import { defaultRules, RULE_PRESETS } from '@shared/rules'
import type { Generation, QuitRequest, ServerEvent, ServerState, Session } from '@shared/types'
import { apOutputLines } from '../../helpers/ap-output'
import { createTestContext, hostOs, type TestCore } from '../../helpers/core'
import { makeShims } from '../../fake-ap/make-shims.mjs'

const FAKE_AP = fileURLToPath(new URL('../../fake-ap/', import.meta.url))
const SEED = '47305681920473519826'

let root: string
let core: TestCore
let store: SessionStore
let locator: Locator
let settings: ApSettings
/** The environment the fake programs get (FAKE_MODE, FAKE_RECORD). */
let fakeEnv: Record<string, string>
let managers: ServerManager[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat server é-'))
  core = createTestContext(join(root, 'core'))
  store = createSessionStore(core.ctx, {
    validationContext: () =>
      Promise.resolve({
        installedGames: new Map([['TUNIC', { worldVersion: null }]]),
        apVersion: '0.6.8',
        schemaFor: () => undefined,
        allowQuantity: false,
        plandoEnabled: [],
      }),
  })
  // A fake install whose programs are the Node fakes of tests/fake-ap.
  const ap = join(root, 'AP')
  mkdirSync(ap)
  writeFileSync(join(ap, 'ArchipelagoLauncher.mjs'), '')
  fakeEnv = {}
  locator = createLocator(core.ctx, {
    fakeRoot: ap,
    exeOverride: (name) => ({
      command: process.execPath,
      argsPrefix: [join(FAKE_AP, `${name}.mjs`)],
      env: { ...fakeEnv },
    }),
  })
  settings = createApSettings(core.ctx, locator)
  managers = []
})

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.disposeAll()))
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

function makeManager(overrides: Partial<ServerManagerDeps> = {}): ServerManager {
  const manager = createServerManager(core.ctx, {
    sessions: {
      get: (id) => store.get(id),
      getSecrets: (id) => store.getSecrets(id),
      setHosting: (id, hosting) => store.setHosting(id, hosting),
      setFinished: (id) => store.setFinished(id),
      resolveRomNeeds: () => Promise.resolve([]),
    },
    settings,
    locator,
    // The Node fakes run as node.exe: the real orphan check would never match them on Windows.
    orphans: { find: () => Promise.resolve([]), stop: () => Promise.resolve('stopped') },
    publicIp: () => Promise.resolve(null),
    // Only the ready line makes a server ready, unless a test asks for the TCP probe.
    timeouts: { probeMs: 60_000, stopMs: 5000 },
    ...overrides,
  })
  managers.push(manager)
  return manager
}

function generation(workspace: string, slots: Generation['slots'] = []): Generation {
  const zipPath = join(workspace, 'output', `AP_${SEED}.zip`)
  writeFileSync(zipPath, 'not really a zip: the fake server only needs its path')
  return {
    seedName: SEED,
    zipPath,
    spoilerName: null,
    slots: slots.length > 0 ? slots : [{ slot: 1, name: 'Alice', game: 'TUNIC', patchFile: null }],
    durationS: 3,
    logPath: join(workspace, 'logs', 'generate.log'),
  }
}

/** A session with a generated game, ready to be hosted. */
async function generatedSession(name = 'Soirée'): Promise<Session> {
  const session = await store.create(name)
  return store.setGeneration(session.id, generation(session.workspace))
}

/**
 * Where MultiServer 0.6.8 saves: next to the multidata, AP_<seed>.zip → AP_<seed>.apsave. It parses
 * --savefile but never reads it (MultiServer.py:694-701, 2708; the real run of
 * docs/verification/2026-10-16-real-run.md), and the fake server does the same.
 */
const savefileOf = (session: Session): string => join(session.workspace, 'output', `AP_${SEED}.apsave`)

/** What the bus sends, in order. */
function recordBus(): {
  states: ServerState[]
  logs: string[]
  events: ServerEvent[]
  order: string[]
} {
  const out = {
    states: [] as ServerState[],
    logs: [] as string[],
    events: [] as ServerEvent[],
    order: [] as string[],
  }
  core.ctx.bus.on('server:state', (state) => {
    out.states.push(state)
    out.order.push(`state:${state.status}`)
  })
  core.ctx.bus.on('server:log', ({ line }) => {
    out.logs.push(line)
    out.order.push(`log:${line}`)
  })
  core.ctx.bus.on('server:event', ({ event }) => {
    out.events.push(event)
    out.order.push(`event:${event.kind}`)
  })
  return out
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

interface FakeProc {
  opts: SpawnApOptions
  writes: string[]
  killed: boolean
  line(text: string, stream?: 'stdout' | 'stderr'): void
  exit(code: number | null): void
}

/** A spawn whose processes the test drives: it prints their lines and ends them; /exit ends them too. */
function fakeSpawn(): { spawn: NonNullable<ServerManagerDeps['spawn']>; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  const spawn: NonNullable<ServerManagerDeps['spawn']> = (_ctx, opts) => {
    let resolveExit: (exit: ApExit) => void = () => undefined
    const exited = new Promise<ApExit>((resolve) => {
      resolveExit = resolve
    })
    const fake: FakeProc = {
      opts,
      writes: [],
      killed: false,
      line: (text, stream = 'stdout') => opts.onLine?.(stream, text),
      exit: (code) => resolveExit({ code, signal: code === null ? 'SIGKILL' : null }),
    }
    const proc: ApProcess = {
      pid: 4242 + procs.length,
      exited,
      write: (line) => {
        fake.writes.push(line)
        if (line === '/exit') fake.exit(0)
      },
      kill: () => {
        fake.killed = true
        fake.exit(null)
      },
      lastLines: () => [],
    }
    procs.push(fake)
    return proc
  }
  return { spawn, procs }
}

/** A connection the test plays the server of. */
interface FakeSocket {
  url: string
  /** The packets the app sent, in order. */
  sent: Record<string, unknown>[]
  closed: boolean
  handlers: SocketHandlers
  /** The server answers the handshake and sends its RoomInfo. */
  open(): void
  receive(...packets: Record<string, unknown>[]): void
  /** The connection ends (the app's close, or the server's). */
  end(): void
}

/** Connections the test plays the server of, instead of real WebSockets. */
function fakeSockets(): { socket: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const socket: SocketFactory = (url, handlers) => {
    const fake: FakeSocket = {
      url,
      sent: [],
      closed: false,
      handlers,
      open() {
        handlers.open()
        fake.receive({ cmd: 'RoomInfo', password: false })
      },
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
      close: () => queueMicrotask(() => fake.end()),
    }
  }
  return { socket, sockets }
}

/** Connections that never reach a server. */
const offline: SocketFactory = (_url, handlers) => {
  queueMicrotask(() => handlers.close())
  return { send: () => undefined, close: () => undefined }
}

const ALICE_AND_BOB: Generation['slots'] = [
  { slot: 1, name: 'Alice', game: 'Pokemon Emerald', patchFile: null },
  { slot: 2, name: 'Bob', game: 'A Hat in Time', patchFile: null },
]

/** What a server says to a client that logged in, its slots being Alice (1) and Bob (2). */
const CONNECTED = {
  cmd: 'Connected',
  team: 0,
  slot: 1,
  slot_info: {
    '1': { name: 'Alice', game: 'Pokemon Emerald', type: 1, group_members: [], class: 'NetworkSlot' },
    '2': { name: 'Bob', game: 'A Hat in Time', type: 1, group_members: [], class: 'NetworkSlot' },
  },
}

const TRACKER_JOIN =
  "Notice (all): Alice (Team #1) tracking Pokemon Emerald has joined. Client(0.6.8), ['Tracker', 'ArchipelaGOAT']."
const TUTORIAL =
  'Now that you are connected, you can use !help to list commands to run via the server. If your client supports it, you may have additional local commands you can list with /help.'

/** A PrintJSON ItemSend (MultiServer.py:1362-1380): slot `player` found an item of `receiving`. */
const itemSend = (player: number, receiving: number, flags: number): Record<string, unknown> => ({
  cmd: 'PrintJSON',
  type: 'ItemSend',
  receiving,
  item: { item: 77, location: 88, player, flags, class: 'NetworkItem' },
  data: [],
})

/** The `--port` a driven process was given. */
const portOf = (proc: FakeProc): number => Number(proc.opts.args[proc.opts.args.indexOf('--port') + 1])

/** Starts the server of `id` with a fake spawn and makes it ready with its listening line. */
async function startFake(
  manager: ServerManager,
  procs: FakeProc[],
  id: string,
): Promise<{ state: ServerState; proc: FakeProc }> {
  const count = procs.length
  const starting = manager.start(id)
  await vi.waitFor(() => expect(procs.length).toBe(count + 1))
  const proc = procs[count]!
  proc.line(`server listening on 0.0.0.0:${portOf(proc)}`)
  return { state: await starting, proc }
}

// --- pure helpers ---------------------------------------------------------------------------------

describe('buildServerArgs', () => {
  it('buildServerArgs passes every mode flag with explicit value', () => {
    const rules = { ...defaultRules(), ...RULE_PRESETS.async }
    const args = buildServerArgs(
      '/data/sessions/s_1/output/AP_1.zip',
      38282,
      '/data/sessions/s_1/output/AP_1.apsave',
      {
        ...rules,
        releaseMode: 'goal',
        collectMode: 'auto-enabled',
        remainingMode: 'disabled',
        countdownMode: 'enabled',
        hintCost: 7,
        locationCheckPoints: 2,
        autoShutdown: 0,
      },
    )
    expect(args).toEqual([
      '/data/sessions/s_1/output/AP_1.zip',
      '--port',
      '38282',
      '--savefile',
      '/data/sessions/s_1/output/AP_1.apsave',
      '--release_mode',
      'goal',
      '--collect_mode',
      'auto-enabled',
      '--remaining_mode',
      'disabled',
      '--countdown_mode',
      'enabled',
      '--hint_cost',
      '7',
      '--location_check_points',
      '2',
      '--auto_shutdown',
      '0',
    ])
    // The passwords go through the session host.yaml, never on the command line.
    expect(args.join(' ')).not.toMatch(/password/)
  })
})

describe('parseServerLine', () => {
  it('parses join, leave, item send, goal and all-goals lines', () => {
    const at = new Date('2026-10-17T20:00:00.000Z')
    const parsed = apOutputLines('server-session.txt').map((line) => parseServerLine(line, at))
    const kinds = parsed.map((event) => event?.kind ?? null)
    expect(kinds).toEqual([
      'join',
      'join',
      'join',
      'item',
      'item',
      'chat',
      null, // a refused connection is no event
      'leave',
      'leave',
      'goal',
      'goal',
      'all-goals',
    ])
    expect(parsed[0]).toEqual({
      ts: '2026-10-17T20:00:00.000Z',
      kind: 'join',
      text: "Notice (all): Alice (Team #1) playing Pokemon Emerald has joined. Client(0.6.8), ['AP'].",
      player: 'Alice',
    })
    expect(parsed[3]).toMatchObject({
      kind: 'item',
      player: 'Alice',
      item: 'Progressive Hat',
      receiver: 'Bob',
      location: 'Littleroot Town - Pokemon Center',
    })
    expect(parsed[5]).toMatchObject({ kind: 'chat', player: 'Bob', text: 'Notice (all): Bob: gg, nice run' })
    expect(parsed[7]).toMatchObject({ kind: 'leave', player: 'Carol' })
    expect(parsed[9]).toMatchObject({ kind: 'goal', player: 'Alice' })
    expect(parsed[11]).toMatchObject({ kind: 'all-goals' })
    expect(parsed[11]).not.toHaveProperty('player')
  })

  it('reads the real session of Archipelago 0.6.8: a Text Client that joins and leaves, the host chat', () => {
    // What the real server printed (docs/verification/2026-10-16-real-run.md), public address
    // replaced: the /players answers are print() lines, held back until the next log line.
    const parsed = apOutputLines('real-server-session.txt').map((line) => parseServerLine(line))
    const events = parsed.filter((event) => event !== null)
    expect(events.map((event) => [event.kind, event.player])).toEqual([
      ['chat', '[Server]'],
      ['chat', '[Server]'],
      ['join', 'Goat1'],
      ['leave', 'Goat1'],
    ])
    expect(events[1]).toMatchObject({ text: 'Notice (all): [Server]: accents: café élève ü — 日本' })
  })

  it('takes the startup lines for no event', () => {
    for (const line of apOutputLines('server-startup.txt')) expect(parseServerLine(line)).toBeNull()
    expect(
      parseServerLine('[2026-10-17 20:00:00] Notice (all): Bob (Team #1) has completed their goal.'),
    ).toMatchObject({ kind: 'goal', player: 'Bob' })
  })
})

describe('quoteConsoleArg', () => {
  it('quotes a word with spaces or quotes, as shlex reads it', () => {
    expect(quoteConsoleArg('Alice')).toBe('Alice')
    expect(quoteConsoleArg('Master Sword')).toBe('"Master Sword"')
    expect(quoteConsoleArg('Link\'s "Hat"')).toBe('"Link\'s \\"Hat\\""')
    expect(quoteConsoleArg('C:\\a b')).toBe('"C:\\\\a b"')
    expect(quoteConsoleArg('')).toBe('""')
  })
})

// --- with the fake ArchipelagoServer --------------------------------------------------------------

describe('local server (fake ArchipelagoServer)', () => {
  it('ready only after "server listening on", not after "Hosting game at"', async () => {
    const manager = makeManager()
    const session = await generatedSession()
    const bus = recordBus()
    let statusAtHosting: string | null = null
    core.ctx.bus.on('server:log', ({ line }) => {
      if (line.startsWith('Hosting game at ')) statusAtHosting = manager.get(session.id)?.status ?? 'none'
    })

    const state = await manager.start(session.id)

    expect(statusAtHosting).toBe('starting')
    expect(state).toMatchObject({
      sessionId: session.id,
      status: 'ready',
      error: null,
      resumedFromSave: false,
    })
    expect(state.addresses[0]).toEqual({ kind: 'localhost', host: 'localhost', port: state.port })
    const listening = bus.order.findIndex((entry) => entry.startsWith('log:server listening on'))
    const hosting = bus.order.findIndex((entry) => entry.startsWith('log:Hosting game at'))
    expect(bus.order.indexOf('state:starting')).toBeLessThan(hosting)
    expect(hosting).toBeLessThan(listening)
    expect(listening).toBeLessThan(bus.order.indexOf('state:ready'))
    expect(manager.get(session.id)).toEqual(state)
    expect(await canConnect(state.port)).toBe(true)
    // The session remembers where it is hosted.
    expect((await store.get(session.id)).hosting).toEqual({
      mode: 'local',
      port: state.port,
      savefile: savefileOf(session),
    })
  })

  it('command is written to stdin and output line emitted', async () => {
    const manager = makeManager()
    const session = await generatedSession()
    await manager.start(session.id)
    // The item tracker logs in as the first slot, and the server counts it there.
    await vi.waitFor(() => expect(manager.get(session.id)?.tracker).toBe('Alice'))
    const answer = new Promise<string>((resolve) =>
      core.ctx.bus.on('server:log', ({ sessionId, line }) => {
        if (sessionId === session.id && line.includes('players of')) resolve(line)
      }),
    )

    manager.command(session.id, '/players')

    expect(await answer).toBe('1 players of 2 connected :: Team #1: Alice (Bob)')
    const { log, events } = manager.history(session.id)
    expect(log).toContain('1 players of 2 connected :: Team #1: Alice (Bob)')
    // The lines about the app's own connections stay out of the log and of the events.
    expect(
      log.filter((line) => /connection (?:open|closed)|ArchipelaGOAT|Notice \(Player /.test(line)),
    ).toEqual([])
    expect(events).toEqual([])
  })

  it('answers a console command at once, although the server holds what it prints until it logs', async () => {
    // Without the app's connections, the answer waits for the next log line, as on the real run.
    fakeEnv = { FAKE_MODE: 'no-websocket' }
    const manager = makeManager()
    const session = await generatedSession()
    await manager.start(session.id)
    manager.command(session.id, '/players')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(manager.history(session.id).log.filter((line) => line.includes('players of'))).toEqual([])
    // Any log line lets it out: here a message to everyone.
    manager.command(session.id, 'bonjour')
    await vi.waitFor(() =>
      expect(manager.history(session.id).log.slice(-2)).toEqual([
        '0 players of 2 connected :: Team #1: (Alice) (Bob)',
        'Notice (all): [Server]: bonjour',
      ]),
    )
    await manager.stop(session.id)

    // With them, it comes within a second of the command.
    fakeEnv = {}
    await manager.start(session.id)
    await vi.waitFor(() => expect(manager.get(session.id)?.tracker).toBe('Alice'))
    const sent = Date.now()
    manager.command(session.id, '/players')
    await vi.waitFor(
      () =>
        expect(manager.history(session.id).log).toContain('1 players of 2 connected :: Team #1: Alice (Bob)'),
      { timeout: 1000 },
    )
    expect(Date.now() - sent).toBeLessThan(1000)
  })

  it('gives each item event the class the item tracker tells, in the order of the lines', async () => {
    const manager = makeManager()
    const session = await generatedSession()
    await manager.start(session.id)
    await vi.waitFor(() => expect(manager.get(session.id)?.tracker).toBe('Alice'))
    const bus = recordBus()

    manager.command(session.id, '/fake_items')

    await vi.waitFor(() => expect(bus.events).toHaveLength(5))
    expect(
      bus.events.map(({ player, item, receiver, itemClass }) => ({ player, item, receiver, itemClass })),
    ).toEqual([
      { player: 'Alice', item: 'Umbrella', receiver: 'Bob', itemClass: 'progression' },
      { player: 'Bob', item: 'Rare Candy', receiver: 'Alice', itemClass: 'useful' },
      { player: 'Alice', item: 'Baby Trap', receiver: 'Bob', itemClass: 'trap' },
      { player: 'Bob', item: '10 Pons', receiver: 'Bob', itemClass: 'filler' },
      // Progression and useful: progression, as Archipelago's clients color it.
      { player: 'Bob', item: 'Stone Badge', receiver: 'Alice', itemClass: 'progression' },
    ])
    expect(manager.history(session.id).events).toEqual(bus.events)

    // Stopped, the tracker leaves first, and its leave stays out of the feed too.
    await manager.stop(session.id)
    expect(manager.get(session.id)).not.toHaveProperty('tracker')
    expect(manager.history(session.id).events).toHaveLength(5)
    expect(manager.history(session.id).log.some((line) => line.includes('ArchipelaGOAT'))).toBe(false)
  })

  it('logs the tracker in with the game password of the session', async () => {
    const manager = makeManager()
    const session = await generatedSession()
    await store.setSecrets(session.id, { password: 'hunter2' })
    await manager.start(session.id)
    await vi.waitFor(() => expect(manager.get(session.id)?.tracker).toBe('Alice'))
  })

  it('stop sends /exit and fake writes the savefile', async () => {
    const manager = makeManager()
    const session = await generatedSession()
    const { port } = await manager.start(session.id)
    const bus = recordBus()

    await manager.stop(session.id)

    expect(existsSync(savefileOf(session))).toBe(true)
    expect(bus.states.map((state) => state.status)).toEqual(['stopping', 'stopped'])
    expect(manager.get(session.id)).toMatchObject({ status: 'stopped', error: null, port })
    expect(await canConnect(port)).toBe(false)
    // Stopped, the game is over until a restart, which resumes from the same save.
    expect(await store.get(session.id)).toMatchObject({
      status: 'finished',
      hosting: { mode: 'local', savefile: savefileOf(session) },
    })
  })

  it('ends the game of the session before it says the server stopped or crashed', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    // What the session says when each state goes out: the screens read it again on that event.
    const seen: string[] = []
    core.ctx.bus.on('server:state', (state) => {
      void store.get(session.id).then(({ status }) => seen.push(`${state.status}:${status}`))
    })

    await startFake(manager, procs, session.id)
    expect((await store.get(session.id)).status).toBe('hosting')
    await manager.stop(session.id)
    await vi.waitFor(() => expect(seen).toContain('stopped:finished'))

    const { proc } = await startFake(manager, procs, session.id)
    expect((await store.get(session.id)).status).toBe('hosting')
    proc.exit(3)
    await vi.waitFor(() => expect(seen).toContain('crashed:finished'))
  })

  it('stop force-kills after timeout when server ignores /exit', async () => {
    fakeEnv = { FAKE_MODE: 'ignore-exit' }
    const manager = makeManager({ timeouts: { probeMs: 60_000, stopMs: 300 } })
    const session = await generatedSession()
    const { port } = await manager.start(session.id)

    await manager.stop(session.id)

    expect(manager.get(session.id)).toMatchObject({
      status: 'stopped',
      error: { code: 'PROCESS_TIMEOUT', params: { command: 'ArchipelagoServer' } },
    })
    expect(existsSync(savefileOf(session))).toBe(false)
    expect(await canConnect(port)).toBe(false)
  })

  it('stop with force kills at once, without waiting for /exit', async () => {
    fakeEnv = { FAKE_MODE: 'ignore-exit' }
    const manager = makeManager({ timeouts: { probeMs: 60_000, stopMs: 60_000 } })
    const session = await generatedSession()
    await manager.start(session.id)

    const started = Date.now()
    await manager.stop(session.id, { force: true })

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(manager.get(session.id)).toMatchObject({ status: 'stopped', error: { code: 'PROCESS_TIMEOUT' } })
  })

  it('PORT_IN_USE when port busy', async () => {
    fakeEnv = { FAKE_MODE: 'port-busy' }
    const manager = makeManager()
    const session = await generatedSession()
    const bus = recordBus()

    const error = await failure(manager.start(session.id))

    expect(error.code).toBe('PORT_IN_USE')
    const state = manager.get(session.id)
    expect(state).toMatchObject({
      status: 'crashed',
      error: { code: 'PORT_IN_USE', params: { port: state?.port } },
    })
    expect(bus.states.map((s) => s.status)).toEqual(['starting', 'crashed'])
    // The traceback is in the console.
    expect(bus.logs.some((line) => line.includes('error while attempting to bind'))).toBe(true)
    expect((await store.get(session.id)).hosting).toBeNull()
  })

  it('disposeAll stops every running server', async () => {
    const manager = makeManager()
    const first = await generatedSession('Un')
    const second = await generatedSession('Deux')
    await manager.start(first.id)
    await manager.start(second.id)
    expect(manager.running().sort()).toEqual([first.id, second.id].sort())

    await manager.disposeAll()

    expect(existsSync(savefileOf(first))).toBe(true)
    expect(existsSync(savefileOf(second))).toBe(true)
    expect(manager.get(first.id)?.status).toBe('stopped')
    expect(manager.get(second.id)?.status).toBe('stopped')
    expect(manager.running()).toEqual([])
  })

  it('start rewrites session host.yaml with the current password and spawns with cwd = workspace', async () => {
    const record = join(root, 'record.json')
    fakeEnv = { FAKE_RECORD: record }
    const manager = makeManager()
    const session = await generatedSession()
    await store.setSecrets(session.id, { password: 'first one', serverPassword: 'admin pass' })
    await manager.start(session.id)
    await manager.stop(session.id)

    await store.setSecrets(session.id, { password: 'second one' })
    await store.update(session.id, { rules: { ...session.rules, hintCost: 25, itemCheat: false } })
    await manager.start(session.id)

    const hostYaml = readFileSync(join(session.workspace, 'host.yaml'), 'utf8')
    expect(hostYaml).toMatch(/^ {2}password: second one$/m)
    expect(hostYaml).toMatch(/^ {2}server_password: admin pass$/m)
    expect(hostYaml).toMatch(/^ {2}hint_cost: 25$/m)
    expect(hostYaml).toMatch(/^ {2}disable_item_cheat: true$/m)
    expect(hostYaml).not.toMatch(/first one/)
    if (hostOs === 'linux') expect(statSync(join(session.workspace, 'host.yaml')).mode & 0o777).toBe(0o600)

    const run = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; cwd: string }
    expect(run.cwd).toBe(session.workspace)
    expect(run.argv[0]).toBe(join(session.workspace, 'output', `AP_${SEED}.zip`))
    expect(run.argv).toEqual(expect.arrayContaining(['--savefile', savefileOf(session), '--hint_cost', '25']))
    expect(run.argv.join(' ')).not.toMatch(/second one|admin pass/)
  })

  it('start reports resumedFromSave when the .apsave exists', async () => {
    const manager = makeManager()
    const session = await generatedSession()
    expect((await manager.start(session.id)).resumedFromSave).toBe(false)
    await manager.stop(session.id)

    const resumed = await manager.start(session.id)

    expect(resumed).toMatchObject({ status: 'ready', resumedFromSave: true })
  })

  it('tolerates FAKE_MODE=buffered: ready via TCP probe fallback', async () => {
    fakeEnv = { FAKE_MODE: 'buffered' }
    const manager = makeManager({ timeouts: { probeMs: 100, stopMs: 5000 } })
    const session = await generatedSession()
    const bus = recordBus()

    const state = await manager.start(session.id)

    expect(state.status).toBe('ready')
    // Nothing was printed: the fake holds its output until /save or its exit.
    expect(bus.logs).toEqual([])
    expect(await canConnect(state.port)).toBe(true)
  })
})

// --- with a fake spawn ----------------------------------------------------------------------------

describe('local server (driven process)', () => {
  it('history returns past events after a late subscriber', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const { proc } = await startFake(manager, procs, session.id)

    for (const line of apOutputLines('server-session.txt')) proc.line(line)
    const late = recordBus()

    const history = manager.history(session.id)
    expect(late.events).toEqual([])
    expect(history.events.map((event) => event.kind)).toEqual([
      'join',
      'join',
      'join',
      'item',
      'item',
      'chat',
      'leave',
      'leave',
      'goal',
      'goal',
      'all-goals',
    ])
    expect(history.log.at(-1)).toBe(
      'Notice (all): Team #1 has completed all of their games! Congratulations!',
    )
    // The password a client sent is masked in the console too.
    expect(history.log.join('\n')).not.toContain('hunter2')
    expect(manager.history('s_unknown')).toEqual({ events: [], log: [] })
  })

  it('keeps the last 500 events and lines', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const { proc } = await startFake(manager, procs, session.id)

    for (let i = 0; i < 600; i++) proc.line(`Notice (all): Bob: message ${i}`)

    const history = manager.history(session.id)
    expect(history.events).toHaveLength(500)
    expect(history.log).toHaveLength(500)
    expect(history.events[0]?.text).toBe('Notice (all): Bob: message 100')
    expect(history.log.at(-1)).toBe('Notice (all): Bob: message 599')
  })

  it('server:log lines are redacted with session password', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    await store.setSecrets(session.id, { password: 'open sesame', serverPassword: 'root!' })
    const bus = recordBus()
    const starting = manager.start(session.id)
    await vi.waitFor(() => expect(procs).toHaveLength(1))
    const proc = procs[0]!

    proc.line('Hosting game at 203.0.113.7:38281 (Password: open sesame)')
    proc.line('server listening on 0.0.0.0:38281')
    await starting
    proc.line('Notice (all): Bob: the password is open sesame, admin is root!')

    const all = [
      ...bus.logs,
      ...manager.history(session.id).log,
      ...bus.events.map((event) => event.text),
    ].join('\n')
    expect(all).not.toContain('open sesame')
    expect(all).not.toContain('root!')
    expect(bus.logs).toContain('Hosting game at 203.0.113.7:38281 (Password: •••)')
    expect(bus.logs).toContain(`Notice (all): Bob: the password is ${MASK}, admin is ${MASK}`)
    expect(bus.events).toEqual([expect.objectContaining({ kind: 'chat', player: 'Bob' })])
  })

  it('emits events and lines in order, the history holding each one as it is sent', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const { proc } = await startFake(manager, procs, session.id)
    const seen: { events: number; log: number }[] = []
    core.ctx.bus.on('server:event', () => {
      const history = manager.history(session.id)
      seen.push({ events: history.events.length, log: history.log.length })
    })

    proc.line("Notice (all): Alice (Team #1) playing TUNIC has joined. Client(0.6.8), ['AP'].")

    // The renderer reads server:history then ignores what came before its answer: the history must
    // already hold an event when it is sent.
    expect(seen).toEqual([{ events: 1, log: 2 }])
  })

  it('adds the public address once it is known', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn, publicIp: () => Promise.resolve('203.0.113.7') })
    const session = await generatedSession()
    const bus = recordBus()
    const { state } = await startFake(manager, procs, session.id)

    await vi.waitFor(() =>
      expect(manager.get(session.id)?.addresses).toContainEqual({
        kind: 'public',
        host: '203.0.113.7',
        port: state.port,
      }),
    )
    expect(bus.states.at(-1)?.status).toBe('ready')
  })

  it('while lines come, the TCP probe waits for the Hosting line', async () => {
    const { spawn, procs } = fakeSpawn()
    // The listener below would never answer the tracker's handshake.
    const manager = makeManager({ spawn, socket: offline, timeouts: { probeMs: 50, stopMs: 5000 } })
    const session = await generatedSession()
    const starting = manager.start(session.id)
    await vi.waitFor(() => expect(procs).toHaveLength(1))
    const proc = procs[0]!
    const port = Number(proc.opts.args[proc.opts.args.indexOf('--port') + 1])
    proc.line('Loading embedded data package for game TUNIC')
    // Something answers on the port, but the server has not said it binds yet.
    const listener = createServer((socket) => socket.on('error', () => undefined))
    await new Promise<void>((resolve) => listener.listen(port, '127.0.0.1', resolve))
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(manager.get(session.id)?.status).toBe('starting')

      proc.line(`Hosting game at 203.0.113.7:${port} (No password)`)

      expect(await starting).toMatchObject({ status: 'ready', port })
    } finally {
      await new Promise((resolve) => listener.close(resolve))
    }
  })

  it('SERVER_START_FAILED when the server never gets ready, and the process is killed', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn, timeouts: { readyMs: 200, probeMs: 60_000, stopMs: 5000 } })
    const session = await generatedSession()

    const error = await failure(manager.start(session.id))

    expect(error.code).toBe('SERVER_START_FAILED')
    expect(procs[0]?.killed).toBe(true)
    expect(manager.get(session.id)).toMatchObject({
      status: 'crashed',
      error: { code: 'SERVER_START_FAILED' },
    })
  })

  it('SERVER_START_FAILED with the last lines when the server exits before it is ready', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const starting = manager.start(session.id)
    await vi.waitFor(() => expect(procs).toHaveLength(1))

    procs[0]!.line('Traceback (most recent call last):', 'stderr')
    procs[0]!.line('FileNotFoundError: [Errno 2] No such file or directory', 'stderr')
    procs[0]!.exit(1)

    const error = await failure(starting)
    expect(error.code).toBe('SERVER_START_FAILED')
    expect(error.detail).toContain('FileNotFoundError')
    // It never ran: a failed start, not a crash of a running server.
    expect(error.params).toBeUndefined()
    expect(manager.get(session.id)?.error?.params).toBeUndefined()
  })

  it('reports an Archipelago error it recognizes in the output', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const starting = manager.start(session.id)
    await vi.waitFor(() => expect(procs).toHaveLength(1))

    procs[0]!.line('Exception: No .archipelago found in archive.', 'stderr')
    procs[0]!.exit(1)

    expect((await failure(starting)).code).toBe('AP_NO_ARCHIPELAGO_IN_ZIP')
  })

  it('a server that exits on its own is stopped (exit 0) or crashed', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()

    const first = await startFake(manager, procs, session.id)
    first.proc.line('Shutting down due to inactivity.')
    first.proc.exit(0)
    await vi.waitFor(() => expect(manager.get(session.id)).toMatchObject({ status: 'stopped', error: null }))

    const second = await startFake(manager, procs, session.id)
    second.proc.exit(3)
    // It had been ready: the error says it crashed while running.
    await vi.waitFor(() =>
      expect(manager.get(session.id)).toMatchObject({
        status: 'crashed',
        error: { code: 'SERVER_START_FAILED', params: { phase: 'running' } },
      }),
    )
    // A new run starts with an empty history.
    expect(manager.history(session.id).log).not.toContain('Shutting down due to inactivity.')
  })

  it('gives each server its own port before any listens, and never probes the port of another', async () => {
    const { spawn, procs } = fakeSpawn()
    // The first two starts finish writing their host.yaml together, so they look for a port at once.
    let written = 0
    const together = Promise.withResolvers<void>()
    const manager = makeManager({
      spawn,
      settings: {
        makeSessionSettings: async (dir, entries) => {
          const file = await settings.makeSessionSettings(dir, entries)
          if (++written === 2) together.resolve()
          if (written <= 2) await together.promise
          return file
        },
      },
    })
    const first = await generatedSession('Un')
    const second = await generatedSession('Deux')
    const third = await generatedSession('Trois')

    const starting: Promise<ServerState>[] = []
    const start = (id: string): void => {
      const promise = manager.start(id)
      // Left pending by a failed assertion, they are cancelled by the teardown.
      promise.catch(() => undefined)
      starting.push(promise)
    }

    // Two starts at once, then a third while neither server is ready nor even listening: the OS
    // alone would call the same port free for all three.
    start(first.id)
    start(second.id)
    await vi.waitFor(() => expect(procs).toHaveLength(2))
    // The first server now binds its port: the third start must skip it without connecting, which
    // would print a refused connection in that game's console.
    let connections = 0
    const listener = createServer((socket) => {
      connections++
      socket.on('error', () => undefined)
      socket.destroy()
    })
    await new Promise<void>((resolve) => listener.listen(portOf(procs[0]!), '127.0.0.1', resolve))
    try {
      start(third.id)
      await vi.waitFor(() => expect(procs).toHaveLength(3))

      const ports = new Map(procs.map((proc) => [proc.opts.sessionId, portOf(proc)]))
      expect(new Set(ports.values()).size).toBe(3)
      expect(connections).toBe(0)
      for (const proc of procs) proc.line(`server listening on 0.0.0.0:${portOf(proc)}`)
      for (const state of await Promise.all(starting)) expect(state.port).toBe(ports.get(state.sessionId))
    } finally {
      await new Promise((resolve) => listener.close(resolve))
    }
  })

  it('starts one server per session: a second start answers the running one', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const { state } = await startFake(manager, procs, session.id)

    expect(await manager.start(session.id)).toEqual(state)
    expect(procs).toHaveLength(1)
    expect(manager.isBusy(session.id)).toBe(true)
  })

  it('command needs a ready server and takes one line', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    expect(() => manager.command(session.id, '/players')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )

    const { proc } = await startFake(manager, procs, session.id)
    expect(() => manager.command(session.id, '/players\n/exit')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
    manager.command(session.id, '/send Bob "Master Sword"')
    expect(proc.writes).toEqual(['/send Bob "Master Sword"'])
  })

  it('stops a server that is still starting', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const starting = manager.start(session.id)
    await vi.waitFor(() => expect(procs).toHaveLength(1))

    await manager.stop(session.id)
    expect(procs[0]?.writes).toEqual(['/exit'])

    expect((await failure(starting)).code).toBe('TASK_CANCELLED')
    expect(manager.get(session.id)).toMatchObject({ status: 'stopped', error: null })
  })

  it('spawns hidden, with stdin piped, self-managed and detached under Linux only', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    await startFake(manager, procs, session.id)

    expect(procs[0]?.opts).toMatchObject({
      cwd: session.workspace,
      stdin: 'pipe',
      selfManaged: true,
      detached: core.ctx.platform.os === 'linux',
      sessionId: session.id,
    })
  })

  it('refuses a session without a generation, and without Archipelago', async () => {
    const manager = makeManager()
    const draft = await store.create('Brouillon')
    expect((await failure(manager.start(draft.id))).code).toBe('INVALID_INPUT')

    const generated = await generatedSession()
    const noInstall = makeManager({
      locator: { detect: () => Promise.resolve(null), exe: (install, name) => locator.exe(install, name) },
    })
    expect((await failure(noInstall.start(generated.id))).code).toBe('AP_NOT_INSTALLED')
  })

  it('refuses to start while the session generates: the new seed would replace the one it serves', async () => {
    const { spawn, procs } = fakeSpawn()
    const generating = new Set<string>()
    const manager = makeManager({ spawn, isGenerating: (id) => generating.has(id) })
    const session = await generatedSession()
    const other = await generatedSession('Autre')
    generating.add(session.id)

    const refused = await failure(manager.start(session.id))
    expect(refused).toMatchObject({ code: 'AP_RUNNING', params: { reason: 'generating' } })
    expect(procs).toHaveLength(0)
    expect(manager.isBusy(session.id)).toBe(false)
    // Another session starts; this one too once its generation is over.
    await startFake(manager, procs, other.id)
    generating.delete(session.id)
    expect((await startFake(manager, procs, session.id)).state.status).toBe('ready')
  })

  it('refuses to start over an archipelago.gg room unless asked to replace it', async () => {
    const { spawn, procs } = fakeSpawn()
    const manager = makeManager({ spawn })
    const session = await generatedSession()
    const room = {
      mode: 'web',
      seedId: 'seed1',
      roomId: 'room1',
      roomUrl: 'https://archipelago.gg/room/room1',
      port: 38281,
    } as const
    await store.setHosting(session.id, room)

    const refused = await failure(manager.start(session.id))
    expect(refused).toMatchObject({ code: 'AP_RUNNING', params: { reason: 'web-room' } })
    expect(procs).toHaveLength(0)
    expect((await store.get(session.id)).hosting).toEqual(room)

    // Confirmed: the local server becomes the hosting (the room stays on the site).
    const starting = manager.start(session.id, { replaceWeb: true })
    await vi.waitFor(() => expect(procs).toHaveLength(1))
    procs[0]?.line(`server listening on 0.0.0.0:${portOf(procs[0])}`)
    const state = await starting
    expect((await store.get(session.id)).hosting).toEqual({
      mode: 'local',
      port: state.port,
      savefile: savefileOf(session),
    })
  })

  it('refuses with WORLD_CORRUPT_BLOCKING when a world would stop the server', async () => {
    const { spawn, procs } = fakeSpawn()
    const corruptWorld = vi.fn(() => Promise.resolve<string | null>('broken.apworld'))
    const manager = makeManager({ spawn, corruptWorld })
    const session = await generatedSession()
    expect(await failure(manager.start(session.id))).toMatchObject({
      code: 'WORLD_CORRUPT_BLOCKING',
      params: { file: 'broken.apworld' },
    })
    expect(corruptWorld).toHaveBeenCalledWith(expect.objectContaining({ root: join(root, 'AP') }))
    expect(procs).toHaveLength(0)
  })

  it('writes the ROMs the vault resolved into the session host.yaml', async () => {
    const { spawn, procs } = fakeSpawn()
    const rom = join(root, 'roms', 'zelda.sfc')
    const resolveRomNeeds = vi.fn(() =>
      Promise.resolve([
        {
          game: 'A Link to the Past',
          settingsKey: 'lttp_options.rom_file',
          status: 'ok' as const,
          path: rom,
          vaultPath: rom,
        },
        {
          game: 'Super Metroid',
          settingsKey: 'sm_options.rom_file',
          status: 'missing' as const,
          path: null,
          vaultPath: null,
        },
      ]),
    )
    const manager = makeManager({
      spawn,
      sessions: {
        get: (id) => store.get(id),
        getSecrets: (id) => store.getSecrets(id),
        setHosting: (id, hosting) => store.setHosting(id, hosting),
        setFinished: (id) => store.setFinished(id),
        resolveRomNeeds,
      },
    })
    const session = await store.create('ROMs')
    await store.setGeneration(session.id, {
      ...generation(session.workspace),
      slots: [
        { slot: 1, name: 'Alice', game: 'A Link to the Past', patchFile: null },
        { slot: 2, name: 'Bob', game: 'Super Metroid', patchFile: null },
        { slot: 3, name: 'Carol', game: 'A Link to the Past', patchFile: null },
      ],
    })

    await startFake(manager, procs, session.id)

    expect(resolveRomNeeds).toHaveBeenCalledWith(['A Link to the Past', 'Super Metroid'])
    const hostYaml = readFileSync(join(session.workspace, 'host.yaml'), 'utf8')
    expect(hostYaml).toContain(`rom_file: ${rom}`)
    expect(hostYaml).not.toContain('sm_options')
  })
})

describe("the app's own connections (driven process, fake sockets)", () => {
  /** A ready server whose tracker logged in as Alice, of a game of Alice and Bob. */
  async function trackedServer(timeouts: ServerManagerDeps['timeouts'] = {}) {
    const { spawn, procs } = fakeSpawn()
    const { socket, sockets } = fakeSockets()
    const manager = makeManager({ spawn, socket, timeouts: { probeMs: 60_000, stopMs: 5000, ...timeouts } })
    const created = await store.create('Suivie')
    const session = await store.setGeneration(created.id, generation(created.workspace, ALICE_AND_BOB))
    const bus = recordBus()
    const { state, proc } = await startFake(manager, procs, session.id)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const tracker = sockets[0]!
    // What the server logs about the tracker's login (MultiServer.py:1044-1067).
    tracker.open()
    proc.line('connection open')
    tracker.receive(CONNECTED)
    proc.line(TRACKER_JOIN)
    proc.line(`Notice (Player Alice in team 1): ${TUTORIAL}`)
    await vi.waitFor(() => expect(manager.get(session.id)?.tracker).toBe('Alice'))
    expect(bus.logs.slice(-1)).toEqual([`server listening on 0.0.0.0:${state.port}`])
    return { manager, session, state, proc, tracker, sockets, bus }
  }

  it('logs the tracker in as the first slot, with no game, no items and its tags', async () => {
    const { tracker, state } = await trackedServer()
    expect(tracker.url).toBe(`ws://127.0.0.1:${state.port}`)
    expect(tracker.sent).toEqual([
      {
        cmd: 'Connect',
        password: null,
        game: '',
        name: 'Alice',
        uuid: expect.any(String) as unknown,
        version: { major: 0, minor: 6, build: 8, class: 'Version' },
        items_handling: 0,
        tags: ['Tracker', 'ArchipelaGOAT'],
        slot_data: false,
      },
    ])
  })

  it('an item waits for its class, which may come before or after its line, or not at all', async () => {
    const { proc, tracker, bus } = await trackedServer({ classifyMs: 300 })

    // The line first, then the packet.
    proc.line('(Team #1) Alice sent Hookshot to Bob (Spiral Cave)')
    expect(bus.events).toEqual([])
    tracker.receive(itemSend(1, 2, 0b001))
    expect(bus.events.at(-1)).toMatchObject({ item: 'Hookshot', itemClass: 'progression' })

    // The packet first, then the line.
    tracker.receive(itemSend(2, 1, 0b100))
    proc.line('(Team #1) Bob sent Ice Trap to Alice (Ice Palace)')
    expect(bus.events.at(-1)).toMatchObject({ item: 'Ice Trap', itemClass: 'trap' })

    // A line whose packet never comes goes out plain, and what came after it waits behind it.
    proc.line('(Team #1) Bob sent Bow to Alice (Spiral Cave)')
    proc.line('Notice (all): Alice: bonjour')
    expect(bus.events).toHaveLength(2)
    await vi.waitFor(() => expect(bus.events).toHaveLength(4))
    expect(bus.events.slice(2).map(({ kind, item, itemClass }) => ({ kind, item, itemClass }))).toEqual([
      { kind: 'item', item: 'Bow', itemClass: undefined },
      { kind: 'chat', item: undefined, itemClass: undefined },
    ])
    // The log never waits.
    expect(bus.logs.slice(-2)).toEqual([
      '(Team #1) Bob sent Bow to Alice (Spiral Cave)',
      'Notice (all): Alice: bonjour',
    ])
  })

  it('matches the sends of one sender and receiver in turn, each team on its own', async () => {
    const { proc, tracker, bus } = await trackedServer()
    proc.line('(Team #1) Alice sent Hookshot to Bob (Spiral Cave)')
    proc.line('(Team #1) Alice sent 20 Rupees to Bob (Lost Woods)')
    // The tracker is in team 1: a send of team 2 gets no packet.
    proc.line('(Team #2) Alice sent Bow to Bob (Spiral Cave)')
    tracker.receive(itemSend(1, 2, 0b001), itemSend(1, 2, 0))
    expect(bus.events.map(({ item, itemClass }) => ({ item, itemClass }))).toEqual([
      { item: 'Hookshot', itemClass: 'progression' },
      { item: '20 Rupees', itemClass: 'filler' },
    ])
  })

  it('leaves the lines about its own connections out of the log, and its join out of the feed', async () => {
    const { manager, session, proc, sockets, bus } = await trackedServer({ pokeMs: 10 })
    // trackedServer fed the lines of the tracker's login: none of them came out.
    expect(bus.events).toEqual([])
    // A player's notice to Alice and a player's connection are not the tracker's.
    proc.line('Notice (Player Alice in team 1): Hint: your Bow is at Spiral Cave.')
    proc.line('connection open')
    expect(bus.logs.slice(-2)).toEqual([
      'Notice (Player Alice in team 1): Hint: your Bow is at Spiral Cave.',
      'connection open',
    ])

    // A console command, then the connection that flushes its answer.
    manager.command(session.id, '/players')
    expect(proc.writes).toEqual(['/players'])
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const poke = sockets[1]!
    expect(poke.url).toBe(sockets[0]!.url)
    proc.line('1 players of 2 connected :: Team #1: Alice (Bob)')
    proc.line('connection open')
    poke.open()
    // It closes once the server answered, without logging in.
    await vi.waitFor(() => expect(poke.closed).toBe(true))
    expect(poke.sent).toEqual([])
    proc.line('connection closed')
    expect(bus.logs.slice(-1)).toEqual(['1 players of 2 connected :: Team #1: Alice (Bob)'])

    // A real player's join and leave are events, as before.
    proc.line("Notice (all): Bob (Team #1) playing A Hat in Time has joined. Client(0.6.8), ['AP'].")
    proc.line(`Notice (Player Bob in team 1): ${TUTORIAL}`)
    // The real Alice joins, and gets the notice the tracker got: it stays.
    proc.line("Notice (all): Alice (Team #1) playing Pokemon Emerald has joined. Client(0.6.8), ['AP'].")
    proc.line(`Notice (Player Alice in team 1): ${TUTORIAL}`)
    expect(bus.events.map(({ kind, player }) => ({ kind, player }))).toEqual([
      { kind: 'join', player: 'Bob' },
      { kind: 'join', player: 'Alice' },
    ])
    expect(bus.logs.slice(-2)).toEqual([
      "Notice (all): Alice (Team #1) playing Pokemon Emerald has joined. Client(0.6.8), ['AP'].",
      `Notice (Player Alice in team 1): ${TUTORIAL}`,
    ])
  })

  it('a connection that never opened owes no line', async () => {
    const { manager, session, proc, sockets, bus } = await trackedServer({ pokeMs: 10 })
    manager.command(session.id, '/players')
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    sockets[1]!.end()
    proc.line('connection open')
    expect(bus.logs.at(-1)).toBe('connection open')
  })

  it('without the tracker, items go out at once and plain; a lost tracker comes back', async () => {
    const { manager, session, proc, tracker, sockets, bus } = await trackedServer({
      trackerRetryMs: [10, 10],
    })
    tracker.end()
    await vi.waitFor(() => expect(manager.get(session.id)).not.toHaveProperty('tracker'))
    proc.line('(Team #1) Alice sent Hookshot to Bob (Spiral Cave)')
    expect(bus.events.map(({ item, itemClass }) => ({ item, itemClass }))).toEqual([
      { item: 'Hookshot', itemClass: undefined },
    ])

    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    sockets[1]!.open()
    sockets[1]!.receive(CONNECTED)
    await vi.waitFor(() => expect(manager.get(session.id)?.tracker).toBe('Alice'))
  })

  it('a refused tracker never comes back, and the items go out plain', async () => {
    const { spawn, procs } = fakeSpawn()
    const { socket, sockets } = fakeSockets()
    const manager = makeManager({ spawn, socket, timeouts: { probeMs: 60_000, trackerRetryMs: [10] } })
    const created = await store.create('Refusée')
    const session = await store.setGeneration(created.id, generation(created.workspace, ALICE_AND_BOB))
    const bus = recordBus()
    const warn = vi.spyOn(core.ctx.log, 'warn')
    const { proc } = await startFake(manager, procs, session.id)
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.open()
    sockets[0]!.receive({ cmd: 'ConnectionRefused', errors: ['InvalidPassword'] })
    await vi.waitFor(() => expect(sockets[0]!.closed).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sockets).toHaveLength(1)
    expect(manager.get(session.id)).not.toHaveProperty('tracker')
    proc.line('(Team #1) Alice sent Hookshot to Bob (Spiral Cave)')
    expect(bus.events).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('servers: the server refused the item tracker', {
      errors: ['InvalidPassword'],
    })
    warn.mockRestore()
  })

  it('stop closes the tracker before /exit, sends its items, and says the server stopped once', async () => {
    const { manager, session, proc, tracker, bus } = await trackedServer({ classifyMs: 60_000 })
    proc.line('(Team #1) Alice sent Hookshot to Bob (Spiral Cave)')
    expect(bus.events).toEqual([])
    bus.states.length = 0

    await manager.stop(session.id)

    expect(tracker.closed).toBe(true)
    expect(proc.writes).toEqual(['/exit'])
    expect(bus.events.map(({ item, itemClass }) => ({ item, itemClass }))).toEqual([
      { item: 'Hookshot', itemClass: undefined },
    ])
    expect(bus.states.map((state) => state.status)).toEqual(['stopping', 'stopped'])
    expect(bus.states.every((state) => !('tracker' in state))).toBe(true)
  })
})

describe('orphan servers of a previous run', () => {
  it('marks crashed a local session whose orphan server still runs, and stop kills it', async () => {
    const hosted = await generatedSession('Hébergée')
    await store.setHosting(hosted.id, { mode: 'local', port: 38283, savefile: savefileOf(hosted) })
    const web = await generatedSession('Web')
    await store.setHosting(web.id, {
      mode: 'web',
      seedId: 's',
      roomId: 'r',
      roomUrl: 'https://archipelago.gg/room/r',
      port: null,
    })
    const orphans: Orphan[] = [
      { pid: 9001, exe: 'ArchipelagoServer', sessionId: hosted.id },
      { pid: 9002, exe: 'ArchipelagoServer', sessionId: web.id },
      { pid: 9003, exe: 'ArchipelagoServer', sessionId: 's_gone' },
      { pid: 9004, exe: 'ArchipelagoGenerate', sessionId: hosted.id },
    ]
    const stop = vi.fn<(pid: number) => Promise<OrphanStop>>(() => Promise.resolve('stopped'))
    const manager = makeManager({ orphans: { find: () => Promise.resolve(orphans), stop } })
    const bus = recordBus()

    await manager.reconcile()

    expect(manager.get(hosted.id)).toMatchObject({
      sessionId: hosted.id,
      status: 'crashed',
      port: 38283,
      // Its own text: it still runs from an earlier run of the app, it did not fail to start.
      error: { code: 'SERVER_START_FAILED', params: { orphanPid: 9001, phase: 'orphan' } },
    })
    // It still serves its players: its addresses stay on the screen.
    expect(manager.get(hosted.id)?.addresses).toContainEqual({
      kind: 'localhost',
      host: 'localhost',
      port: 38283,
    })
    expect(manager.get(web.id)).toBeNull()
    expect(bus.states.map((state) => state.sessionId)).toEqual([hosted.id])
    expect(manager.isBusy(hosted.id)).toBe(true)
    // A start would run a second server on the same save.
    expect((await failure(manager.start(hosted.id))).code).toBe('AP_RUNNING')

    await manager.stop(hosted.id)

    expect(stop).toHaveBeenCalledWith(9001)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(manager.get(hosted.id)).toMatchObject({ status: 'stopped', error: null })
    expect(manager.isBusy(hosted.id)).toBe(false)
    expect(bus.states.map((state) => state.status)).toEqual(['crashed', 'stopping', 'stopped'])
  })

  it('an orphan killed without its save stops with PROCESS_TIMEOUT, as a server that ignores /exit', async () => {
    const hosted = await generatedSession()
    await store.setHosting(hosted.id, { mode: 'local', port: 38281, savefile: savefileOf(hosted) })
    const manager = makeManager({
      orphans: {
        find: () => Promise.resolve([{ pid: 9001, exe: 'ArchipelagoServer', sessionId: hosted.id }]),
        stop: () => Promise.resolve('forced'),
      },
    })
    await manager.reconcile()
    await manager.stop(hosted.id)
    expect(manager.get(hosted.id)).toMatchObject({
      status: 'stopped',
      error: { code: 'PROCESS_TIMEOUT', params: { command: 'ArchipelagoServer' } },
    })
    expect((await store.get(hosted.id)).status).toBe('finished')
  })

  it('keeps the orphan when it cannot be stopped', async () => {
    const hosted = await generatedSession()
    await store.setHosting(hosted.id, { mode: 'local', port: 38281, savefile: savefileOf(hosted) })
    const manager = makeManager({
      orphans: {
        find: () => Promise.resolve([{ pid: 9001, exe: 'ArchipelagoServer', sessionId: hosted.id }]),
        stop: () => Promise.resolve('failed'),
      },
    })
    await manager.reconcile()

    expect((await failure(manager.stop(hosted.id))).code).toBe('AP_RUNNING')
    expect(manager.get(hosted.id)).toMatchObject({
      status: 'crashed',
      error: { code: 'SERVER_START_FAILED', params: { orphanPid: 9001 } },
    })
  })

  it('a failed orphan check is logged, not thrown', async () => {
    const manager = makeManager({
      orphans: {
        find: () => Promise.reject(new Error('tasklist failed')),
        stop: () => Promise.resolve('stopped'),
      },
    })
    await expect(manager.reconcile()).resolves.toBeUndefined()
  })
})

// --- the service ----------------------------------------------------------------------------------

describe('servers service', () => {
  let savedFakeDir: string | undefined

  beforeEach(() => {
    savedFakeDir = process.env.GOAT_FAKE_AP_DIR
    const shims = join(root, 'shims')
    makeShims(shims)
    process.env.GOAT_FAKE_AP_DIR = shims
  })

  afterEach(() => {
    if (savedFakeDir === undefined) delete process.env.GOAT_FAKE_AP_DIR
    else process.env.GOAT_FAKE_AP_DIR = savedFakeDir
  })

  async function startService(): Promise<{ services: ReturnType<typeof createServices>; session: Session }> {
    const services = createServices(core.ctx)
    services.startEager()
    const sessions = services.get('sessions')
    const created = await sessions.create('Soirée')
    const session = await sessions.setGeneration(created.id, generation(created.workspace))
    return { services, session }
  }

  it('quit with a running fake server still writes the savefile (early before late)', async () => {
    const { services, session } = await startService()
    const servers = services.get('servers')
    await servers.start(session.id)
    let savedBeforeLate: boolean | null = null
    core.ctx.lifecycle.onBeforeQuit(
      () => {
        savedBeforeLate = existsSync(savefileOf(session))
        return Promise.resolve()
      },
      { phase: 'late' },
    )

    await core.lifecycle.runBeforeQuit()

    expect(savedBeforeLate).toBe(true)
    expect(servers.get(session.id)?.status).toBe('stopped')
  })

  it('a running server holds the window close and refuses the deletion of its session', async () => {
    const { services, session } = await startService()
    const servers = services.get('servers')
    const sessions = services.get('sessions')
    const requests: QuitRequest[] = []
    core.ctx.bus.on('app:quitRequested', (request) => void requests.push(request))
    expect(core.lifecycle.requestClose()).toBe(true)

    await servers.start(session.id)

    expect(core.lifecycle.requestClose()).toBe(false)
    expect(requests).toEqual([expect.objectContaining({ runningServers: [session.id], runningTasks: [] })])
    expect((await failure(sessions.delete(session.id))).code).toBe('AP_RUNNING')

    await servers.stop(session.id)
    await sessions.delete(session.id)
    expect((await failure(sessions.get(session.id))).code).toBe('NOT_FOUND')
  })

  it('server:* handlers start, read, command and stop through the servers service', async () => {
    const { services, session } = await startService()
    const ipc = createIpcRegistry()
    registerHandlers(services, ipc.registerHandler)
    const call = (name: string, input: unknown): Promise<IpcResult<unknown>> =>
      ipc.dispatch(name, input, { senderId: 1 })
    const sessionId = session.id

    expect(await call('server:get', { sessionId })).toEqual({ ok: true, value: null })
    expect(await call('server:history', { sessionId })).toEqual({ ok: true, value: { events: [], log: [] } })
    expect(await call('server:command', { sessionId, command: '/players' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    })

    expect(await call('server:start', { sessionId })).toMatchObject({ ok: true, value: { status: 'ready' } })
    expect(await call('server:get', { sessionId })).toMatchObject({ ok: true, value: { status: 'ready' } })
    expect(await call('server:command', { sessionId, command: '/players' })).toEqual({
      ok: true,
      value: undefined,
    })
    // 0 or 1 connected, whether the tracker logged in before the command ran.
    await vi.waitFor(async () =>
      expect(await call('server:history', { sessionId })).toMatchObject({
        value: {
          log: expect.arrayContaining([
            expect.stringMatching(/^[01] players of 2 connected :: Team #1: /),
          ]) as unknown,
        },
      }),
    )
    expect(await call('server:stop', { sessionId, force: false })).toEqual({ ok: true, value: undefined })
    expect(await call('server:get', { sessionId })).toMatchObject({ ok: true, value: { status: 'stopped' } })
  })
})
