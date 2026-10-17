import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocator, type Locator } from '@main/core/ap/locator'
import type { ApExit, ApProcess, SpawnApOptions } from '@main/core/ap/process'
import type { Orphan } from '@main/core/ap/processes'
import {
  buildServerArgs,
  createServerManager,
  parseServerLine,
  quoteConsoleArg,
  type ServerManager,
  type ServerManagerDeps,
} from '@main/core/ap/server'
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
      resolveRomNeeds: () => Promise.resolve([]),
    },
    settings,
    locator,
    // The Node fakes run as node.exe: the real orphan check would never match them on Windows.
    orphans: { find: () => Promise.resolve([]), kill: () => Promise.resolve(true) },
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

const savefileOf = (session: Session): string => join(session.workspace, 'output', `${SEED}.apsave`)

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
      '/data/sessions/s_1/output/1.apsave',
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
      '/data/sessions/s_1/output/1.apsave',
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
    const answer = new Promise<string>((resolve) =>
      core.ctx.bus.on('server:log', ({ sessionId, line }) => {
        if (sessionId === session.id && line.includes('players of')) resolve(line)
      }),
    )

    manager.command(session.id, '/players')

    expect(await answer).toBe('0 players of 2 connected :: Team #1: (Alice) (Bob)')
    expect(manager.history(session.id).log).toContain('0 players of 2 connected :: Team #1: (Alice) (Bob)')
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
    // Stopped, the session keeps its hosting: it resumes from the same save.
    expect((await store.get(session.id)).hosting).toMatchObject({
      mode: 'local',
      savefile: savefileOf(session),
    })
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
    const manager = makeManager({ spawn, timeouts: { probeMs: 50, stopMs: 5000 } })
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
    const kill = vi.fn<(pid: number) => Promise<boolean>>(() => Promise.resolve(true))
    const manager = makeManager({ orphans: { find: () => Promise.resolve(orphans), kill } })
    const bus = recordBus()

    await manager.reconcile()

    expect(manager.get(hosted.id)).toMatchObject({
      sessionId: hosted.id,
      status: 'crashed',
      port: 38283,
      error: { code: 'SERVER_START_FAILED', params: { orphanPid: 9001 } },
    })
    expect(manager.get(web.id)).toBeNull()
    expect(bus.states.map((state) => state.sessionId)).toEqual([hosted.id])
    expect(manager.isBusy(hosted.id)).toBe(true)
    // A start would run a second server on the same save.
    expect((await failure(manager.start(hosted.id))).code).toBe('AP_RUNNING')

    await manager.stop(hosted.id)

    expect(kill).toHaveBeenCalledWith(9001)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(manager.get(hosted.id)).toMatchObject({ status: 'stopped', error: null })
    expect(manager.isBusy(hosted.id)).toBe(false)
  })

  it('keeps the orphan when it cannot be stopped', async () => {
    const hosted = await generatedSession()
    await store.setHosting(hosted.id, { mode: 'local', port: 38281, savefile: savefileOf(hosted) })
    const manager = makeManager({
      orphans: {
        find: () => Promise.resolve([{ pid: 9001, exe: 'ArchipelagoServer', sessionId: hosted.id }]),
        kill: () => Promise.resolve(false),
      },
    })
    await manager.reconcile()

    expect((await failure(manager.stop(hosted.id))).code).toBe('AP_RUNNING')
    expect(manager.get(hosted.id)?.status).toBe('crashed')
  })

  it('a failed orphan check is logged, not thrown', async () => {
    const manager = makeManager({
      orphans: {
        find: () => Promise.reject(new Error('tasklist failed')),
        kill: () => Promise.resolve(true),
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
    await vi.waitFor(async () =>
      expect(await call('server:history', { sessionId })).toMatchObject({
        value: {
          log: expect.arrayContaining(['0 players of 2 connected :: Team #1: (Alice) (Bob)']) as unknown,
        },
      }),
    )
    expect(await call('server:stop', { sessionId, force: false })).toEqual({ ok: true, value: undefined })
    expect(await call('server:get', { sessionId })).toMatchObject({ ok: true, value: { status: 'stopped' } })
  })
})
