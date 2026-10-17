import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocator, type Locator } from '@main/core/ap/locator'
import { apSpawnOptions, type ApProcess, type SpawnApOptions } from '@main/core/ap/process'
import type { Bizhawk } from '@main/core/play/bizhawk'
import {
  buildChecklist,
  createJoin,
  NO_CLIENT_ROUTE,
  parseJoinInput,
  romsForPatch,
  type ChecklistFacts,
  type Join,
  type JoinDeps,
} from '@main/core/play/join'
import type { Vault } from '@main/core/play/roms'
import { apUserAgent, createHttp } from '@main/core/system/http'
import type { TaskHandle } from '@main/core/tasks'
import type { RoomStatus, WebhostClient } from '@main/core/webhost/client'
import { registerHandlers } from '@main/ipc'
import registerJoinHandlers from '@main/ipc/join'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import type { ServiceContainer } from '@main/services/registry'
import { ROM_TABLE } from '@shared/data/rom-table'
import { AppError } from '@shared/errors'
import type { IpcResult } from '@shared/ipc/contract'
import type {
  ApInstall,
  BizhawkState,
  JoinPlan,
  JoinTarget,
  PatchManifest,
  RomTableEntry,
  TaskDone,
} from '@shared/types'
import { makeShims } from '../../fake-ap/make-shims.mjs'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { EMERALD_MD5, makePatchZip, patchManifest } from '../../helpers/make-patch.mjs'
import { startMockWebhost, type MockWebhost, type MockWebhostOptions } from '../../mock-webhost/server'

const ROOM_ID = 'aBcDeFgHiJkLmNoPqRsTuV'
const ROOM: JoinTarget = { kind: 'room', roomId: ROOM_ID }
const PROTEUS = 'b69fff40212b80c94f19e786d1efbf61'
const MM2_LC = '37f2c36ce7592f1e16b3434b3985c497'
const MM3_LC = '5266687de215e790b2008284402f3917'
const SMZ3_MD5 = '3a177ba9879e3dd04fb623a219d175b2'

const entryOf = (game: string): RomTableEntry => {
  const entry = ROM_TABLE.find((candidate) => candidate.game === game)
  if (!entry) throw new Error(`no ROM entry for ${game}`)
  return entry
}
const EMERALD = entryOf('Pokemon Emerald')
const BIZHAWK_ROUTE = {
  suffix: '.apemerald',
  client: 'bizhawk',
  exe: 'ArchipelagoBizHawkClient',
  tier: 'full',
} as const

const READY_BIZHAWK: BizhawkState = {
  installed: true,
  managed: true,
  version: '2.11.1',
  path: 'C:\\BizHawk',
  configuredInAp: true,
  prereqs: [],
}

let root: string
let core: TestCore
let mock: MockWebhost
let apDir: string
let recordFile: string
let locator: Locator
let settings: { set: ReturnType<typeof vi.fn<JoinDeps['settings']['set']>> }
let vault: { resolveRomForEntry: ReturnType<typeof vi.fn<Vault['resolveRomForEntry']>> }
let bizhawk: { state: ReturnType<typeof vi.fn<Bizhawk['state']>> }
let loadedGames: string[]

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat join é-'))
  core = createTestContext(join(root, 'core'))
  core.ctx.http = createHttp({
    userAgent: apUserAgent('0.1.0-test'),
    cacheDir: join(root, 'cache'),
    log: silentLogger,
    githubToken: () => null,
  })
  await startMock()
  // A fake Archipelago 0.6.8 whose clients are the Node fake: it records how it was started.
  apDir = join(root, 'Archipelago é')
  makeShims(apDir)
  writeFileSync(join(apDir, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
  recordFile = join(root, 'record.json')
  locator = createLocator(core.ctx, {
    fakeRoot: apDir,
    exeOverride: (name) => ({
      command: process.execPath,
      argsPrefix: [join(apDir, `${name}.mjs`)],
      env: { FAKE_RECORD: recordFile },
    }),
  })
  settings = { set: vi.fn<JoinDeps['settings']['set']>(() => Promise.resolve()) }
  // The effective key of the settings holds the ROM.
  vault = {
    resolveRomForEntry: vi.fn<Vault['resolveRomForEntry']>(() =>
      Promise.resolve({ status: 'ok', path: join(root, 'emerald.gba'), vaultPath: null }),
    ),
  }
  bizhawk = { state: vi.fn<Bizhawk['state']>(() => Promise.resolve(READY_BIZHAWK)) }
  loadedGames = ['Pokemon Emerald', 'Factorio']
})

afterEach(async () => {
  await mock.close()
  // A client the test started runs detached in the install's folder, and may still be exiting.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

async function startMock(opts?: MockWebhostOptions): Promise<void> {
  if (mock) await mock.close()
  mock = await startMockWebhost(opts)
  // Joining reads the site of the config (GOAT_WEBHOST_URL in the integration runs).
  core.ctx.config.updateInternal({ webhostUrl: mock.url })
}

function makeJoin(overrides: Partial<JoinDeps> = {}): Join {
  return createJoin(core.ctx, {
    locator,
    settings,
    vault,
    bizhawk,
    installedGames: () => Promise.resolve(new Map(loadedGames.map((game) => [game, { worldVersion: null }]))),
    ...overrides,
  })
}

function fakeTask(signal: AbortSignal = new AbortController().signal): TaskHandle & { stages: string[] } {
  const stages: string[] = []
  return {
    id: 'task-1',
    signal,
    stages,
    progress: (stage) => {
      if (stages.at(-1) !== stage) stages.push(stage)
    },
    log: () => undefined,
  }
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a failure')
}

function syncFailure(run: () => unknown): AppError {
  try {
    run()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a failure')
}

/** A room of the fake site, started on `port` (0: asleep, it starts on the next status read). */
function addRoom(port = 50123): string {
  const now = new Date()
  mock.state.rooms.set(ROOM_ID, {
    id: ROOM_ID,
    seedId: 'SSSSSSSSSSSSSSSSSSSSSS',
    owner: '00000000-0000-4000-8000-000000000000',
    tracker: 'TTTTTTTTTTTTTTTTTTTTTT',
    createdAt: now,
    lastActivity: now,
    port,
    statusPolls: 0,
    visits: 0,
    commands: [],
    log: '',
  })
  return ROOM_ID
}

async function patchBytes(name: string, manifest: Record<string, unknown> | string | null): Promise<Buffer> {
  return readFileSync(await makePatchZip(join(root, 'made', name), manifest))
}

/** Alice plays Pokemon Emerald (slot 1), Rocket plays Factorio (slot 2), each with their file. */
async function emeraldAndFactorioRoom(server = '127.0.0.1:50123'): Promise<void> {
  mock.state.players = [
    ['Alice', 'Pokemon Emerald'],
    ['Rocket', 'Factorio'],
  ]
  mock.state.slotFiles.set(1, await patchBytes('P1.apemerald', patchManifest({ server })))
  mock.state.slotFiles.set(
    2,
    await patchBytes('P2.zip', {
      compatible_version: 5,
      version: 7,
      server,
      player: 2,
      player_name: 'Rocket',
      game: 'Factorio',
      patch_file_ending: '.zip',
    }),
  )
  addRoom()
}

const downloadsAsked = (): string[] =>
  mock.state.requests.map((request) => request.url).filter((url) => url.startsWith('/dl_patch/'))

async function localPatch(
  fields: Record<string, unknown> = {},
  name = 'AP_1_P1_Alice.apemerald',
): Promise<string> {
  return makePatchZip(
    join(root, 'Mes patchs', name),
    patchManifest({ server: 'archipelago.gg:38281', ...fields }),
  )
}

async function install(): Promise<ApInstall> {
  const found = await locator.detect()
  if (!found) throw new Error('no install')
  return found
}

interface FakeSpawn {
  spawn: NonNullable<JoinDeps['spawn']>
  calls: SpawnApOptions[]
}

function fakeSpawn(events: string[] = []): FakeSpawn {
  const calls: SpawnApOptions[] = []
  const spawn = (_ctx: unknown, opts: SpawnApOptions): ApProcess => {
    events.push('spawn')
    calls.push(opts)
    return {
      pid: 4242,
      exited: new Promise(() => undefined),
      write: () => undefined,
      kill: () => undefined,
      lastLines: () => [],
    }
  }
  return { spawn, calls }
}

/** What the fake client wrote about its start, once it has run. */
async function recorded(): Promise<{ program: string; argv: string[]; cwd: string }> {
  return vi.waitFor(
    () => JSON.parse(readFileSync(recordFile, 'utf8')) as { program: string; argv: string[]; cwd: string },
    { timeout: 15_000, interval: 50 },
  )
}

// --- parseJoinInput ---------------------------------------------------------------------------------

const PATCH_WITH_SPACES = 'C:\\Users\\Jérôme Dupont\\Mes patchs\\AP 7731 P1 Alice.apemerald'
const existsOnly = (file: string): boolean => file === PATCH_WITH_SPACES

const address = (fields: Partial<Extract<JoinTarget, { kind: 'address' }>>): JoinTarget => ({
  kind: 'address',
  host: 'archipelago.gg',
  port: 38281,
  slot: null,
  password: null,
  game: null,
  ...fields,
})

const INPUTS: [string, string, JoinTarget | 'JOIN_BAD_INPUT'][] = [
  ['room URL with a trailing slash', `https://archipelago.gg/room/${ROOM_ID}/`, ROOM],
  ['room URL with www and a query', `http://www.archipelago.gg/room/${ROOM_ID}?update`, ROOM],
  [
    'encoded uri without game',
    'archipelago://Goat%20Two:p%40ss%3Aword@archipelago.gg:38281',
    address({ slot: 'Goat Two', password: 'p@ss:word' }),
  ],
  [
    'uri with a game',
    'archipelago://Goat@localhost:38281?game=Pokemon%20Emerald',
    address({ host: 'localhost', slot: 'Goat', game: 'Pokemon Emerald' }),
  ],
  ['uri without slot nor port (AP defaults to 38281)', 'archipelago://archipelago.gg', address({})],
  ['host:port', 'archipelago.gg:51234', address({ port: 51234 })],
  ['IP and port between spaces', '  127.0.0.1:38281 ', address({ host: '127.0.0.1' })],
  ['path with spaces', PATCH_WITH_SPACES, { kind: 'patch', path: PATCH_WITH_SPACES }],
  ['quoted path (copied as path)', `"${PATCH_WITH_SPACES}"`, { kind: 'patch', path: PATCH_WITH_SPACES }],
  ['invalid entry', 'rejoins-moi', 'JOIN_BAD_INPUT'],
  ['empty entry', '   ', 'JOIN_BAD_INPUT'],
  ['room id too short', 'https://archipelago.gg/room/aBcDeF', 'JOIN_BAD_INPUT'],
  ['room on another site', `https://example.com/room/${ROOM_ID}`, 'JOIN_BAD_INPUT'],
  ['seed page instead of a room', `https://archipelago.gg/seed/${ROOM_ID}`, 'JOIN_BAD_INPUT'],
  ['port out of range', 'localhost:70000', 'JOIN_BAD_INPUT'],
  ['port zero', 'archipelago://localhost:0', 'JOIN_BAD_INPUT'],
  [
    'uri with a broken escape, kept as it is (Python unquote)',
    'archipelago://Go%ZZat@localhost:38281',
    address({ host: 'localhost', slot: 'Go%ZZat' }),
  ],
  ['uri without host', 'archipelago://Goat@:38281', 'JOIN_BAD_INPUT'],
  ['patch that does not exist', 'C:\\Users\\Jérôme Dupont\\gone.apemerald', 'JOIN_BAD_INPUT'],
]

describe('parseJoinInput', () => {
  it.each(INPUTS)('parseJoinInput %s', (_label, input, expected) => {
    if (expected === 'JOIN_BAD_INPUT') {
      expect(syncFailure(() => parseJoinInput(input, existsOnly)).code).toBe('JOIN_BAD_INPUT')
    } else {
      expect(parseJoinInput(input, existsOnly)).toEqual(expected)
    }
  })
})

// --- ROMs of a patch and the checklist --------------------------------------------------------------

const manifestOf = (fields: Partial<PatchManifest>): PatchManifest => ({
  game: 'Pokemon Emerald',
  player: 1,
  playerName: 'Alice',
  server: null,
  patchFileEnding: '.apemerald',
  baseChecksums: [EMERALD_MD5],
  resultFileEnding: '.gba',
  compatibleVersion: 6,
  version: 7,
  ...fields,
})

describe('romsForPatch', () => {
  it('finds the entry of the base checksum', () => {
    expect(romsForPatch(manifestOf({}))).toEqual([{ entry: EMERALD, md5s: [EMERALD_MD5] }])
  })

  it('picks the entry of the game when Mega Man 2 and 3 share the hash, and accepts what AP accepts', () => {
    const [mm3] = romsForPatch(
      manifestOf({ game: 'Mega Man 3', patchFileEnding: '.apmm3', baseChecksums: [PROTEUS, MM3_LC] }),
    )
    expect(mm3?.entry.game).toBe('Mega Man 3')
    // A Mega Man 2 patch lists the ROM hashes only; AP still takes the Proteus program (mm2/rom.py:383).
    const [mm2] = romsForPatch(
      manifestOf({ game: 'Mega Man 2', patchFileEnding: '.apmm2', baseChecksums: [MM2_LC] }),
    )
    expect(mm2?.entry.game).toBe('Mega Man 2')
    expect(mm2?.md5s).toEqual(expect.arrayContaining([MM2_LC, PROTEUS]))
  })

  it('.apsmz3 needs both the Super Metroid and the A Link to the Past ROMs', () => {
    const needs = romsForPatch(
      manifestOf({ game: 'SMZ3', patchFileEnding: '.apsmz3', baseChecksums: [SMZ3_MD5] }),
    )
    expect(needs.map(({ entry, md5s }) => [entry.settingsKey, md5s])).toEqual([
      ['sm_options.rom_file', entryOf('Super Metroid').md5s],
      ['lttp_options.rom_file', entryOf('A Link to the Past').md5s],
    ])
  })

  it('needs nothing without a checksum, and knows nothing of an unknown one', () => {
    expect(romsForPatch(manifestOf({ baseChecksums: [] }))).toEqual([])
    expect(romsForPatch(manifestOf({ game: 'Custom', baseChecksums: ['0'.repeat(32)] }))).toEqual([])
  })
})

const facts = (overrides: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  apInstalled: true,
  apVersion: '0.6.8',
  game: 'Pokemon Emerald',
  loadedGames: new Set(['Pokemon Emerald']),
  baseChecksums: [EMERALD_MD5],
  roms: [{ entry: EMERALD, resolution: { status: 'ok', path: 'C:\\roms\\e.gba', vaultPath: null } }],
  route: BIZHAWK_ROUTE,
  bizhawk: READY_BIZHAWK,
  ...overrides,
})

describe('buildChecklist', () => {
  it('everything ready', () => {
    expect(buildChecklist(facts())).toEqual({
      checklist: {
        ap: { status: 'ok', code: 'ap-ok' },
        world: { status: 'ok', code: 'world-ok' },
        rom: { status: 'ok', code: 'rom-ok' },
        emulator: { status: 'ok', code: 'emulator-ok' },
      },
      ready: true,
    })
  })

  it('checklist missing rom and emulator → ready false', () => {
    const { checklist, ready } = buildChecklist(
      facts({
        roms: [{ entry: EMERALD, resolution: { status: 'missing', path: null, vaultPath: null } }],
        bizhawk: { ...READY_BIZHAWK, installed: false, configuredInAp: false },
      }),
    )
    expect(checklist.rom).toEqual({ status: 'missing', code: 'rom-missing' })
    expect(checklist.emulator).toEqual({ status: 'missing', code: 'emulator-missing' })
    expect(ready).toBe(false)
  })

  it('a ROM only the vault has does not block; a wrong ROM and an unconfigured BizHawk do', () => {
    const fromVault = buildChecklist(
      facts({ roms: [{ entry: EMERALD, resolution: { status: 'ok', path: 'v.gba', vaultPath: 'v.gba' } }] }),
    )
    expect(fromVault.checklist.rom).toEqual({ status: 'missing', code: 'rom-apply-from-vault' })
    expect(fromVault.ready).toBe(true)

    const wrong = buildChecklist(
      facts({ roms: [{ entry: EMERALD, resolution: { status: 'bad-hash', path: null, vaultPath: null } }] }),
    )
    expect(wrong.checklist.rom).toEqual({ status: 'missing', code: 'rom-bad-hash' })
    expect(wrong.ready).toBe(false)

    const unconfigured = buildChecklist(facts({ bizhawk: { ...READY_BIZHAWK, configuredInAp: false } }))
    expect(unconfigured.checklist.emulator).toEqual({ status: 'missing', code: 'emulator-not-configured' })
    expect(unconfigured.ready).toBe(false)
  })

  it('SMZ3: both ROMs must be found, one from the vault is applied', () => {
    const sm = entryOf('Super Metroid')
    const lttp = entryOf('A Link to the Past')
    const ok = { status: 'ok', path: 'sm.sfc', vaultPath: null } as const
    const vaulted = { status: 'ok', path: 'lttp.sfc', vaultPath: 'lttp.sfc' } as const
    const missing = { status: 'missing', path: null, vaultPath: null } as const
    const sni = { suffix: '.apsmz3', client: 'sni', exe: 'ArchipelagoSNIClient', tier: 'assisted' } as const
    const smz3 = (a: typeof ok | typeof missing, b: typeof vaulted | typeof missing): ChecklistFacts =>
      facts({
        game: 'SMZ3',
        loadedGames: new Set(['SMZ3']),
        baseChecksums: [SMZ3_MD5],
        route: sni,
        bizhawk: null,
        roms: [
          { entry: sm, resolution: a },
          { entry: lttp, resolution: b },
        ],
      })
    expect(buildChecklist(smz3(ok, vaulted)).checklist.rom).toEqual({
      status: 'missing',
      code: 'rom-apply-from-vault',
    })
    expect(buildChecklist(smz3(ok, missing)).checklist.rom).toEqual({
      status: 'missing',
      code: 'rom-missing',
    })
    expect(buildChecklist(smz3(missing, vaulted)).ready).toBe(false)
  })

  it('SNI games are assisted, other clients need no emulator check, and no checksum needs no ROM', () => {
    const sni = { suffix: '.aplttp', client: 'sni', exe: 'ArchipelagoSNIClient', tier: 'assisted' } as const
    const assisted = buildChecklist(facts({ route: sni, bizhawk: null }))
    expect(assisted.checklist.emulator).toEqual({ status: 'warning', code: 'emulator-assisted' })
    expect(assisted.ready).toBe(true)

    const none = buildChecklist(facts({ route: NO_CLIENT_ROUTE, bizhawk: null, baseChecksums: [], roms: [] }))
    expect(none.checklist.emulator).toEqual({ status: 'na', code: 'na' })
    expect(none.checklist.rom).toEqual({ status: 'na', code: 'na' })
    expect(none.ready).toBe(true)
  })

  it('a checksum no table entry knows is a warning: the client asks for the ROM itself', () => {
    const { checklist, ready } = buildChecklist(facts({ baseChecksums: ['0'.repeat(32)], roms: [] }))
    expect(checklist.rom).toEqual({ status: 'warning', code: 'rom-missing' })
    expect(ready).toBe(true)
  })

  it('world: a loaded world or a core world of the version; unknown game is not applicable', () => {
    // Pokemon Emerald ships with Archipelago 0.6.8 even when the scan did not list it.
    expect(buildChecklist(facts({ loadedGames: new Set() })).checklist.world).toEqual({
      status: 'ok',
      code: 'world-ok',
    })
    const custom = buildChecklist(facts({ game: 'Pokemon Crystal', loadedGames: new Set(), roms: [] }))
    expect(custom.checklist.world).toEqual({ status: 'missing', code: 'world-missing' })
    expect(custom.ready).toBe(false)
    expect(buildChecklist(facts({ game: null })).checklist.world).toEqual({ status: 'na', code: 'na' })
  })

  it('no Archipelago: nothing is ready', () => {
    const { checklist, ready } = buildChecklist(
      facts({ apInstalled: false, apVersion: null, loadedGames: new Set() }),
    )
    expect(checklist.ap).toEqual({ status: 'missing', code: 'ap-missing' })
    expect(checklist.world).toEqual({ status: 'missing', code: 'world-missing' })
    expect(ready).toBe(false)
  })
})

// --- prepare: rooms ---------------------------------------------------------------------------------

describe('join a room', () => {
  it('prepare without slot lists room slots and downloads nothing', async () => {
    await emeraldAndFactorioRoom()
    const task = fakeTask()
    const plan = await makeJoin().prepare(ROOM, null, task)

    expect(plan).toMatchObject({
      target: ROOM,
      slots: [
        { name: 'Alice', game: 'Pokemon Emerald' },
        { name: 'Rocket', game: 'Factorio' },
      ],
      slot: null,
      patchPath: null,
      manifest: null,
      connect: { host: '127.0.0.1', port: 50123, slot: null, hasPassword: false },
      warnings: [],
      ready: false,
    })
    expect(downloadsAsked()).toEqual([])
    expect(existsSync(join(core.ctx.platform.paths.dataRoot, 'rooms'))).toBe(false)
    expect(task.stages).toEqual(['room', 'done'])
    // A player needs no identity on the site: the organizer's cookie is never sent.
    expect(mock.state.requests.every((request) => request.headers.cookie === undefined)).toBe(true)
  })

  it('wakes a sleeping room and gives its new port', async () => {
    await startMock({ portDelayPolls: 1 })
    await emeraldAndFactorioRoom()
    mock.state.rooms.get(ROOM_ID)!.port = 0
    const task = fakeTask()
    const plan = await makeJoin().prepare(ROOM, null, task)

    expect(plan.connect.port).toBe(50123)
    expect(mock.state.rooms.get(ROOM_ID)?.visits).toBe(1)
    expect(task.stages).toEqual(['room', 'wake', 'done'])
  })

  it('prepare downloads slot patch from mock webhost room and routes .apemerald to bizhawk', async () => {
    await emeraldAndFactorioRoom()
    const task = fakeTask()
    const plan = await makeJoin().prepare(ROOM, 'Alice', task)

    const dir = join(core.ctx.platform.paths.dataRoot, 'rooms', ROOM_ID)
    expect(downloadsAsked()).toEqual([`/dl_patch/${ROOM_ID}/1`])
    expect(readdirSync(dir)).toEqual(['P1_Alice.apemerald'])
    expect(plan).toMatchObject({
      target: ROOM,
      slot: { name: 'Alice', game: 'Pokemon Emerald' },
      patchPath: join(dir, 'P1_Alice.apemerald'),
      manifest: { game: 'Pokemon Emerald', player: 1, playerName: 'Alice', baseChecksums: [EMERALD_MD5] },
      route: BIZHAWK_ROUTE,
      connect: { host: '127.0.0.1', port: 50123, slot: 'Alice', hasPassword: false },
      tutorialUrl: 'https://archipelago.gg/tutorial/Pokemon%20Emerald/setup/en',
      warnings: [],
      checklist: {
        ap: { status: 'ok', code: 'ap-ok' },
        world: { status: 'ok', code: 'world-ok' },
        rom: { status: 'ok', code: 'rom-ok' },
        emulator: { status: 'ok', code: 'emulator-ok' },
      },
      ready: true,
    })
    expect(vault.resolveRomForEntry).toHaveBeenCalledWith(EMERALD, [EMERALD_MD5])
    expect(task.stages).toEqual(['room', 'download', 'inspect', 'done'])
  })

  it('flags patch-server-stale when room port changed', async () => {
    await emeraldAndFactorioRoom('127.0.0.1:40000')
    const plan = await makeJoin().prepare(ROOM, 'Alice', fakeTask())

    expect(plan.warnings).toEqual([
      { severity: 'warning', code: 'patch-server-stale', params: { server: '127.0.0.1:40000' } },
    ])
    // The address to use is the room's current one.
    expect(plan.connect).toMatchObject({ host: '127.0.0.1', port: 50123 })
  })

  it('Factorio .zip slot gives route none with tutorial link', async () => {
    await emeraldAndFactorioRoom()
    const spawn = fakeSpawn()
    const join_ = makeJoin({ spawn: spawn.spawn })
    const plan = await join_.prepare(ROOM, 'Rocket', fakeTask())

    expect(plan.route).toEqual({ suffix: '', client: 'none', exe: null, tier: 'guided' })
    expect(plan.route).toEqual(NO_CLIENT_ROUTE)
    expect(plan.tutorialUrl).toBe('https://archipelago.gg/tutorial/Factorio/setup/en')
    // The mod zip is kept for the player to drop into Factorio; it never goes to the Launcher.
    expect(plan.patchPath).toBe(join(core.ctx.platform.paths.dataRoot, 'rooms', ROOM_ID, 'P2_Rocket.zip'))
    expect(plan.checklist).toMatchObject({
      world: { status: 'ok' },
      rom: { status: 'na', code: 'na' },
      emulator: { status: 'na', code: 'na' },
    })
    expect(vault.resolveRomForEntry).not.toHaveBeenCalled()
    expect((await failure(join_.play(plan.planId))).code).toBe('INVALID_INPUT')
    expect(spawn.calls).toEqual([])
  })

  it('a slot the site gives no file for (a PC game) downloads nothing', async () => {
    const status: RoomStatus = {
      tracker: null,
      players: [{ name: 'Fox', game: 'TUNIC' }],
      lastPort: 38281,
      lastActivity: null,
      timeoutS: 7200,
      downloads: [],
    }
    const wake = vi.fn<WebhostClient['wake']>(() => Promise.resolve())
    const client = {
      baseUrl: 'https://archipelago.gg',
      roomStatus: vi.fn<WebhostClient['roomStatus']>(() => Promise.resolve(status)),
      wake,
    } as Partial<WebhostClient> as WebhostClient
    loadedGames = ['TUNIC']
    const plan = await makeJoin({ webhost: () => client }).prepare(ROOM, 'Fox', fakeTask())

    expect(plan).toMatchObject({
      slot: { name: 'Fox', game: 'TUNIC' },
      patchPath: null,
      manifest: null,
      route: NO_CLIENT_ROUTE,
      connect: { host: 'archipelago.gg', port: 38281, slot: 'Fox', hasPassword: false },
      tutorialUrl: 'https://archipelago.gg/tutorial/TUNIC/setup/en',
      ready: true,
    })
    expect(wake).not.toHaveBeenCalled()
  })

  it('a download that is no patch container is not kept and leaves a guided plan', async () => {
    await emeraldAndFactorioRoom()
    mock.state.slotFiles.delete(1)
    const plan = await makeJoin().prepare(ROOM, 'Alice', fakeTask())

    expect(downloadsAsked()).toEqual([`/dl_patch/${ROOM_ID}/1`])
    expect(plan).toMatchObject({ patchPath: null, manifest: null, route: NO_CLIENT_ROUTE })
    expect(readdirSync(join(core.ctx.platform.paths.dataRoot, 'rooms', ROOM_ID))).toEqual([])
  })

  it('a slot that is not in the room is NOT_FOUND', async () => {
    await emeraldAndFactorioRoom()
    expect((await failure(makeJoin().prepare(ROOM, 'Mallory', fakeTask()))).code).toBe('NOT_FOUND')
    expect(downloadsAsked()).toEqual([])
  })

  it('an unknown room is NOT_FOUND', async () => {
    expect((await failure(makeJoin().prepare(ROOM, null, fakeTask()))).code).toBe('NOT_FOUND')
  })
})

// --- prepare: patches and addresses -----------------------------------------------------------------

describe('join from a patch or an address', () => {
  it('a local patch gives its slot, its server and its route', async () => {
    const path = await localPatch()
    const task = fakeTask()
    const plan = await makeJoin().prepare({ kind: 'patch', path }, null, task)

    expect(plan).toMatchObject({
      target: { kind: 'patch', path },
      slots: [],
      slot: { name: 'Alice', game: 'Pokemon Emerald' },
      patchPath: path,
      route: BIZHAWK_ROUTE,
      connect: { host: 'archipelago.gg', port: 38281, slot: 'Alice', hasPassword: false },
      warnings: [],
      ready: true,
    })
    expect(task.stages).toEqual(['inspect', 'done'])
  })

  it('a patch made without a server has no address', async () => {
    const path = await localPatch({ server: '' })
    const plan = await makeJoin().prepare({ kind: 'patch', path }, null, fakeTask())
    expect(plan.connect).toEqual({ host: '', port: null, slot: 'Alice', hasPassword: false })
  })

  it('a patch path goes through assertUserPath, and a broken patch is PATCH_INVALID', async () => {
    const join_ = makeJoin()
    expect(
      (await failure(join_.prepare({ kind: 'patch', path: 'relative.apemerald' }, null, fakeTask()))).code,
    ).toBe('PATH_FORBIDDEN')
    expect(
      (await failure(join_.prepare({ kind: 'patch', path: join(root, 'gone.apemerald') }, null, fakeTask())))
        .code,
    ).toBe('NOT_FOUND')
    const broken = join(root, 'broken.apemerald')
    writeFileSync(broken, 'nope')
    expect((await failure(join_.prepare({ kind: 'patch', path: broken }, null, fakeTask()))).code).toBe(
      'PATCH_INVALID',
    )
  })

  it('an address has no slot to choose and no patch', async () => {
    const target = address({ slot: 'Goat', password: 'hunter2', game: 'Pokemon Emerald' })
    const plan = await makeJoin().prepare(target, null, fakeTask())
    expect(plan).toMatchObject({
      target,
      slots: [],
      slot: { name: 'Goat', game: 'Pokemon Emerald' },
      patchPath: null,
      manifest: null,
      route: NO_CLIENT_ROUTE,
      connect: { host: 'archipelago.gg', port: 38281, slot: 'Goat', hasPassword: true },
      tutorialUrl: 'https://archipelago.gg/tutorial/Pokemon%20Emerald/setup/en',
      checklist: { world: { status: 'ok' }, rom: { status: 'na' }, emulator: { status: 'na' } },
    })

    const bare = await makeJoin().prepare(address({ host: 'localhost' }), null, fakeTask())
    expect(bare).toMatchObject({
      slot: null,
      tutorialUrl: null,
      connect: { host: 'localhost', port: 38281, slot: null, hasPassword: false },
      checklist: { world: { status: 'na' } },
    })
  })

  it('without Archipelago nothing is ready and play is AP_NOT_INSTALLED', async () => {
    const path = await localPatch()
    const none: JoinDeps['locator'] = {
      detect: () => Promise.resolve(null),
      exe: (ap, name) => locator.exe(ap, name),
    }
    const join_ = makeJoin({ locator: none })
    const plan = await join_.prepare({ kind: 'patch', path }, null, fakeTask())
    expect(plan.checklist.ap).toEqual({ status: 'missing', code: 'ap-missing' })
    expect(plan.ready).toBe(false)
    expect((await failure(join_.play(plan.planId))).code).toBe('AP_NOT_INSTALLED')
  })
})

// --- refresh, play and the Text Client ---------------------------------------------------------------

describe('play', () => {
  it('rom is rom-apply-from-vault when only the vault has it, and play applies the key before spawning', async () => {
    const vaultRom = join(root, 'Coffre', 'Pokemon Emerald.gba')
    vault.resolveRomForEntry.mockResolvedValue({ status: 'ok', path: vaultRom, vaultPath: vaultRom })
    const events: string[] = []
    settings.set.mockImplementation(() => {
      events.push('settings')
      return Promise.resolve()
    })
    const spawn = fakeSpawn(events)
    const join_ = makeJoin({ spawn: spawn.spawn })
    const plan = await join_.prepare({ kind: 'patch', path: await localPatch() }, null, fakeTask())

    expect(plan.checklist.rom).toEqual({ status: 'missing', code: 'rom-apply-from-vault' })
    expect(plan.ready).toBe(true)
    expect(await join_.play(plan.planId)).toEqual({ pid: 4242 })
    // That one key, before the client starts.
    expect(settings.set).toHaveBeenCalledExactlyOnceWith([
      { path: ['pokemon_emerald_settings', 'rom_file'], value: vaultRom },
    ])
    expect(events).toEqual(['settings', 'spawn'])
  })

  it('SETTINGS_LOCKED while applying the ROM stops the launch', async () => {
    vault.resolveRomForEntry.mockResolvedValue({ status: 'ok', path: 'v.gba', vaultPath: 'v.gba' })
    // A client the user left open (the app's own session server does not lock the file).
    settings.set.mockRejectedValue(new AppError('SETTINGS_LOCKED', { processes: 'ArchipelagoBizHawkClient' }))
    const spawn = fakeSpawn()
    const join_ = makeJoin({ spawn: spawn.spawn })
    const plan = await join_.prepare({ kind: 'patch', path: await localPatch() }, null, fakeTask())

    expect((await failure(join_.play(plan.planId))).code).toBe('SETTINGS_LOCKED')
    expect(spawn.calls).toEqual([])
  })

  it('a ROM the settings already point to is not written again', async () => {
    const spawn = fakeSpawn()
    const join_ = makeJoin({ spawn: spawn.spawn })
    const plan = await join_.prepare({ kind: 'patch', path: await localPatch() }, null, fakeTask())
    await join_.play(plan.planId)
    expect(settings.set).not.toHaveBeenCalled()
    expect(spawn.calls).toHaveLength(1)
  })

  it('clients are spawned with a visible window', async () => {
    const spawn = fakeSpawn()
    const join_ = makeJoin({ spawn: spawn.spawn })
    const path = await localPatch()
    const plan = await join_.prepare({ kind: 'patch', path }, null, fakeTask())
    await join_.play(plan.planId)
    await join_.textClient({ host: 'archipelago.gg', port: 38281, slot: 'Alice', password: null })

    const ap = await install()
    expect(spawn.calls).toEqual([
      {
        exe: locator.exe(ap, 'ArchipelagoBizHawkClient'),
        args: [path],
        cwd: ap.paths.userPath,
        stdin: 'ignore',
        window: 'visible',
        detached: true,
      },
      {
        exe: locator.exe(ap, 'ArchipelagoTextClient'),
        args: ['--connect', 'archipelago.gg:38281', '--name', 'Alice'],
        cwd: ap.paths.userPath,
        stdin: 'ignore',
        window: 'visible',
        detached: true,
      },
    ])
    // A shown window, and output not read: the client outlives the app.
    for (const opts of spawn.calls) {
      expect(apSpawnOptions(opts)).toMatchObject({ windowsHide: false, detached: true })
    }
  })

  it('play spawns client with patch path (fake client records argv)', async () => {
    const join_ = makeJoin()
    const path = await localPatch()
    const plan = await join_.prepare({ kind: 'patch', path }, null, fakeTask())
    const { pid } = await join_.play(plan.planId)

    expect(pid).toBeGreaterThan(0)
    expect(await recorded()).toMatchObject({
      program: 'ArchipelagoBizHawkClient',
      argv: [path],
      cwd: (await install()).paths.userPath,
    })
  })

  it('textClient starts ArchipelagoTextClient with connect, name and password', async () => {
    const { pid } = await makeJoin().textClient({
      host: 'archipelago.gg',
      port: 51234,
      slot: 'Goat Two',
      password: 'hunter2',
    })
    expect(pid).toBeGreaterThan(0)
    expect(await recorded()).toMatchObject({
      program: 'ArchipelagoTextClient',
      argv: ['--connect', 'archipelago.gg:51234', '--name', 'Goat Two', '--password', 'hunter2'],
    })
  })

  it('a client that cannot start is AP_NOT_INSTALLED', async () => {
    const missing: JoinDeps['locator'] = {
      detect: () => locator.detect(),
      exe: () => ({ command: join(root, 'nowhere', 'ArchipelagoTextClient.exe'), argsPrefix: [] }),
    }
    const error = await failure(
      makeJoin({ locator: missing }).textClient({ host: 'h', port: 1, slot: 's', password: null }),
    )
    expect(error.code).toBe('AP_NOT_INSTALLED')
  })

  it('refresh checks the plan again after a fix', async () => {
    bizhawk.state.mockResolvedValue({ ...READY_BIZHAWK, configuredInAp: false })
    const join_ = makeJoin()
    const plan = await join_.prepare({ kind: 'patch', path: await localPatch() }, null, fakeTask())
    expect(plan.checklist.emulator.code).toBe('emulator-not-configured')
    expect(plan.ready).toBe(false)

    bizhawk.state.mockResolvedValue(READY_BIZHAWK)
    const again = await join_.refresh(plan.planId)
    expect(again).toEqual({
      ...plan,
      checklist: { ...plan.checklist, emulator: { status: 'ok', code: 'emulator-ok' } },
      ready: true,
    })
  })

  it('a room plan without a slot stays not ready after a refresh', async () => {
    await emeraldAndFactorioRoom()
    const join_ = makeJoin()
    const plan = await join_.prepare(ROOM, null, fakeTask())
    expect((await join_.refresh(plan.planId)).ready).toBe(false)
  })

  it('an unknown plan is NOT_FOUND', async () => {
    const join_ = makeJoin()
    expect((await failure(join_.refresh('nope'))).code).toBe('NOT_FOUND')
    expect((await failure(join_.play('nope'))).code).toBe('NOT_FOUND')
  })

  it('keeps the last 32 plans, the one refreshed last counting as the newest', async () => {
    const join_ = makeJoin()
    const prepare = (): Promise<JoinPlan> => join_.prepare(address({}), null, fakeTask())
    const first = await prepare()
    const second = await prepare()
    for (let i = 0; i < 30; i++) await prepare()
    await join_.refresh(first.planId)
    await prepare()

    expect((await failure(join_.refresh(second.planId))).code).toBe('NOT_FOUND')
    expect((await join_.refresh(first.planId)).planId).toBe(first.planId)
  })
})

describe('resolve', () => {
  it('takes an existing absolute file as a patch, and nothing relative', async () => {
    const path = await localPatch()
    const join_ = makeJoin()
    expect(join_.resolve(` ${path} `)).toEqual({ kind: 'patch', path })
    expect(join_.resolve(`archipelago://Goat@localhost:38281`)).toEqual(
      address({ host: 'localhost', slot: 'Goat' }),
    )
    mkdirSync(join(root, 'folder.apemerald'))
    expect(syncFailure(() => join_.resolve(join(root, 'folder.apemerald'))).code).toBe('JOIN_BAD_INPUT')
    expect(syncFailure(() => join_.resolve('AP_1_P1_Alice.apemerald')).code).toBe('JOIN_BAD_INPUT')
  })
})

// --- IPC ----------------------------------------------------------------------------------------------

describe('join handlers', () => {
  it('route every join channel to the join service, prepare as a join-prepare task', async () => {
    const plan = { planId: 'plan-1' } as JoinPlan
    const service = {
      resolve: vi.fn<Join['resolve']>(() => ROOM),
      prepare: vi.fn<Join['prepare']>(() => Promise.resolve(plan)),
      refresh: vi.fn<Join['refresh']>(() => Promise.resolve(plan)),
      play: vi.fn<Join['play']>(() => Promise.resolve({ pid: 7 })),
      textClient: vi.fn<Join['textClient']>(() => Promise.resolve({ pid: 8 })),
    } satisfies Join
    const services = {
      ctx: core.ctx,
      get: (name: string) => {
        expect(name).toBe('join')
        return service
      },
      startEager: () => undefined,
    } as unknown as ServiceContainer
    const ipc = createIpcRegistry()
    registerJoinHandlers(ipc.registerHandler, services)
    const call = (name: string, input?: unknown): Promise<IpcResult<unknown>> =>
      ipc.dispatch(name, input, { senderId: 1 })

    expect(await call('join:resolve', { input: 'x' })).toEqual({ ok: true, value: ROOM })
    expect(service.resolve).toHaveBeenCalledWith('x')

    const done = new Promise<TaskDone>((resolve) => core.ctx.bus.on('task:done', resolve))
    const answer = await call('join:prepare', { target: ROOM, slotName: 'Alice' })
    expect(answer).toEqual({ ok: true, value: { taskId: expect.any(String) as string } })
    expect(await done).toMatchObject({ kind: 'join-prepare', result: plan })
    expect(service.prepare).toHaveBeenCalledWith(
      ROOM,
      'Alice',
      expect.objectContaining({ id: expect.any(String) as string }),
    )
    await call('join:prepare', { target: ROOM })
    await vi.waitFor(() => expect(service.prepare).toHaveBeenLastCalledWith(ROOM, null, expect.anything()))

    expect(await call('join:refresh', { planId: 'plan-1' })).toEqual({ ok: true, value: plan })
    expect(await call('join:play', { planId: 'plan-1' })).toEqual({ ok: true, value: { pid: 7 } })
    expect(service.play).toHaveBeenCalledWith('plan-1')
    expect(await call('join:textClient', { host: 'h', port: 2, slot: 's' })).toEqual({
      ok: true,
      value: { pid: 8 },
    })
    expect(service.textClient).toHaveBeenCalledWith({ host: 'h', port: 2, slot: 's', password: null })
    await call('join:textClient', { host: 'h', port: 2, slot: 's', password: 'pw' })
    expect(service.textClient).toHaveBeenLastCalledWith({ host: 'h', port: 2, slot: 's', password: 'pw' })

    service.resolve.mockImplementation(() => {
      throw new AppError('JOIN_BAD_INPUT')
    })
    expect(await call('join:resolve', { input: 'x' })).toEqual({
      ok: false,
      error: { code: 'JOIN_BAD_INPUT' },
    })
  })

  it('the join service is wired to the real services', async () => {
    const services = createServices(core.ctx)
    const ipc = createIpcRegistry()
    registerHandlers(services, ipc.registerHandler)
    expect(await ipc.dispatch('join:resolve', { input: 'archipelago.gg:38281' }, { senderId: 1 })).toEqual({
      ok: true,
      value: address({}),
    })
  })
})
