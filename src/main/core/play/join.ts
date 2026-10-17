// Joining a game (spec §3.12): what the player gives (a room link, an archipelago:// link, host:port
// or a patch file), the room's slots, the slot's file downloaded from the site into
// dataRoot/rooms/<roomId>/, the client that opens it (patch-routes.ts), what is still missing before
// JOUER (the checklist), and the launch of the client.
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CheckCode } from '@shared/codes'
import { AP_EXES, DEFAULT_PORT } from '@shared/data/ap-constants'
import { coreWorldsFor } from '@shared/data/core-worlds'
import { routeForFile, TEXT_ROUTE } from '@shared/data/patch-routes'
import { findRomsByMd5, ROM_TABLE } from '@shared/data/rom-table'
import { tutorialUrl } from '@shared/data/tutorial-links'
import { AppError } from '@shared/errors'
import type {
  ApInstall,
  BizhawkState,
  CheckItem,
  Issue,
  JoinPlan,
  JoinTarget,
  PatchManifest,
  PatchRoute,
  RomTableEntry,
} from '@shared/types'
import type { Locator } from '../ap/locator'
import { spawnAp, type ApProcess, type SpawnApOptions } from '../ap/process'
import { SETTINGS_KEYS, type ApSettings, type SettingsEntry } from '../ap/settings'
import type { CoreContext } from '../context'
import { download } from '../system/downloads'
import { safeJoin } from '../system/fsx'
import { assertUserPath } from '../system/user-path'
import type { TaskHandle } from '../tasks'
import { createWebhostClient, type WebhostClient } from '../webhost/client'
import type { CookieJarStore } from '../webhost/cookies'
import { toWebRoom, waitForPort, type Sleep } from '../webhost/rooms'
import type { Bizhawk } from './bizhawk'
import { readPatchManifest } from './patch'
import type { RomResolution, Vault } from './roms'

/**
 * A slot the app has no client for: a PC game, a slot without a file, or a file no client opens (the
 * `.zip` of Factorio, which must never reach the Launcher). The player gets the connection details,
 * the tutorial and the Text Client.
 */
export const NO_CLIENT_ROUTE: Readonly<PatchRoute> = { suffix: '', client: 'none', exe: null, tier: 'guided' }

const TEXT_CLIENT = TEXT_ROUTE.exe ?? AP_EXES.textClient

// --- what the player gives ------------------------------------------------------------------------

const ROOM_HOSTS: ReadonlySet<string> = new Set(['archipelago.gg', 'www.archipelago.gg'])
/** A room id is an suuid: 22 URL-safe base64 characters. */
const ROOM_PATH = /^\/room\/([A-Za-z0-9_-]{22})\/?$/
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
/** A host name, an IPv4 address, or an IPv6 address between brackets. */
const HOST = `(?:\\[[0-9A-Fa-f:.]+\\]|${LABEL}(?:\\.${LABEL})*)`
const HOST_RE = new RegExp(`^${HOST}$`)
const HOST_PORT_RE = new RegExp(`^(${HOST}):(\\d{1,5})$`)
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/** Never carries the input: an archipelago:// link may hold a password. */
const badInput = (): AppError => new AppError('JOIN_BAD_INPUT')

function portOf(text: string): number | null {
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/** `Goat%20Two` → `Goat Two`; a broken escape stays as it is, as with Python's `unquote`. */
function unquote(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function roomIdOf(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!ROOM_HOSTS.has(url.hostname) || url.port !== '') return null
  return ROOM_PATH.exec(url.pathname)?.[1] ?? null
}

/**
 * `archipelago://[slot[:password]@]host[:port][?game=…]`. Without a port the clients connect to 38281
 * (CommonClient.py:892), and `game` is optional, unlike in the Launcher (Launcher.py:46).
 */
function addressOf(url: URL): JoinTarget | null {
  const port = url.port === '' ? DEFAULT_PORT : portOf(url.port)
  if (!HOST_RE.test(url.hostname) || port === null) return null
  return {
    kind: 'address',
    host: url.hostname,
    port,
    slot: url.username === '' ? null : unquote(url.username),
    password: url.password === '' ? null : unquote(url.password),
    game: url.searchParams.get('game') || null,
  }
}

/**
 * What the player gave: a room URL of archipelago.gg (`https?://(www.)?archipelago.gg/room/<id>`, a
 * trailing slash or a query allowed), an `archipelago://` link (decoded), `host:port`, or the path of
 * an existing patch (between double quotes too, as Windows copies a path). JOIN_BAD_INPUT otherwise.
 */
export function parseJoinInput(input: string, existsFile: (p: string) => boolean): JoinTarget {
  const text = input.trim()
  if (text === '') throw badInput()
  if (SCHEME_RE.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw badInput()
    }
    if (url.protocol === 'archipelago:') {
      const target = addressOf(url)
      if (target) return target
    } else {
      const roomId = roomIdOf(url)
      if (roomId) return { kind: 'room', roomId }
    }
    throw badInput()
  }
  const hostPort = HOST_PORT_RE.exec(text)
  if (hostPort) {
    const port = portOf(hostPort[2] ?? '')
    if (port === null) throw badInput()
    return { kind: 'address', host: hostPort[1] ?? '', port, slot: null, password: null, game: null }
  }
  const file = text.replace(/^"(.+)"$/, '$1')
  if (existsFile(file)) return { kind: 'patch', path: file }
  throw badInput()
}

/** An absolute path to a regular file (never a network share, which could hang the check). */
function isLocalFile(file: string): boolean {
  if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file)) return false
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// --- the ROMs of a patch and the checklist --------------------------------------------------------

/** A base ROM a patch needs: its table entry, and the MD5s that satisfy it. */
export interface PatchRom {
  entry: RomTableEntry
  md5s: string[]
}

/** SMZ3 reads two ROMs and checks the MD5 of their combination (worlds/smz3/Rom.py:25, 68-83). */
const SMZ3_KEYS = ['sm_options.rom_file', 'lttp_options.rom_file']

/**
 * The base ROMs the patch needs. An `.apsmz3` needs the Super Metroid and the A Link to the Past ones.
 * Otherwise the entry that accepts one of the `base_checksum`s, the one of the patch's game first (Mega
 * Man 2 and 3 share the Proteus program); its MD5s count too, since AP takes every file its settings
 * accept (worlds/mm2/rom.py:383 extracts the ROM from that program). None when the table knows no
 * checksum of the patch (a custom world).
 */
export function romsForPatch(manifest: PatchManifest): PatchRom[] {
  if (manifest.baseChecksums.length === 0) return []
  if (manifest.patchFileEnding.toLowerCase() === '.apsmz3' || manifest.game === 'SMZ3') {
    return SMZ3_KEYS.flatMap((key) => {
      const entry = ROM_TABLE.find((candidate) => candidate.settingsKey === key)
      return entry ? [{ entry, md5s: [...entry.md5s] }] : []
    })
  }
  const candidates = manifest.baseChecksums.flatMap((md5) => findRomsByMd5(md5))
  const entry = candidates.find((candidate) => candidate.game === manifest.game) ?? candidates[0]
  if (!entry) return []
  return [{ entry, md5s: [...new Set([...manifest.baseChecksums, ...entry.md5s])] }]
}

export interface ChecklistFacts {
  apInstalled: boolean
  /** The version of the install, for its core worlds; null without one. */
  apVersion: string | null
  /** The game of the slot; null when it is not known (an address without `game`). */
  game: string | null
  /** The games of the worlds Archipelago loads. */
  loadedGames: ReadonlySet<string>
  /** Loaded custom worlds whose game nothing tells (Worlds.unknownWorlds): one may be the slot's. */
  unknownWorlds?: number
  baseChecksums: readonly string[]
  /** Where each ROM of `romsForPatch` is (`Vault.resolveRomForEntry`). */
  roms: readonly { entry: RomTableEntry; resolution: RomResolution }[]
  route: PatchRoute
  /** Asked for the BizHawk route only. */
  bizhawk: Pick<BizhawkState, 'installed' | 'configuredInAp'> | null
}

/** Applied by `play` before the client starts: such a ROM does not hold the player back. */
const FROM_VAULT: CheckCode = 'rom-apply-from-vault'

const item = (status: CheckItem['status'], code: CheckCode): CheckItem => ({ status, code })

function worldCheck({ game, loadedGames, apVersion, unknownWorlds = 0 }: ChecklistFacts): CheckItem {
  if (game === null) return item('na', 'na')
  const core = apVersion === null ? null : coreWorldsFor(apVersion)
  const provided = loadedGames.has(game) || (core?.some((world) => world.game === game) ?? false)
  if (provided) return item('ok', 'world-ok')
  // A world without a readable game may be this one: the client tells, it does not block JOUER.
  return unknownWorlds > 0 ? item('warning', 'world-unconfirmed') : item('missing', 'world-missing')
}

function romCheck({ baseChecksums, roms }: ChecklistFacts): CheckItem {
  if (baseChecksums.length === 0) return item('na', 'na')
  // A ROM no table entry knows (a custom world): its client asks for the file itself.
  if (roms.length === 0) return item('warning', 'rom-missing')
  const resolutions = roms.map(({ resolution }) => resolution)
  if (resolutions.some(({ status }) => status === 'bad-hash')) return item('missing', 'rom-bad-hash')
  if (resolutions.some(({ status }) => status !== 'ok')) return item('missing', 'rom-missing')
  // Only the vault has it: `play` writes its path into the settings first.
  if (resolutions.some(({ vaultPath }) => vaultPath !== null)) return item('missing', FROM_VAULT)
  return item('ok', 'rom-ok')
}

function emulatorCheck({ route, bizhawk }: ChecklistFacts): CheckItem {
  switch (route.client) {
    case 'bizhawk':
      if (!bizhawk?.installed) return item('missing', 'emulator-missing')
      return bizhawk.configuredInAp ? item('ok', 'emulator-ok') : item('missing', 'emulator-not-configured')
    case 'sni':
      // The player picks and starts an SNES emulator: the steps say how.
      return item('warning', 'emulator-assisted')
    default:
      return item('na', 'na')
  }
}

/** What is still missing before JOUER. Ready when nothing is missing but a ROM `play` takes from the vault. */
export function buildChecklist(facts: ChecklistFacts): Pick<JoinPlan, 'checklist' | 'ready'> {
  const checklist: JoinPlan['checklist'] = {
    ap: facts.apInstalled ? item('ok', 'ap-ok') : item('missing', 'ap-missing'),
    world: worldCheck(facts),
    rom: romCheck(facts),
    emulator: emulatorCheck(facts),
  }
  const ready = Object.values(checklist).every(
    ({ status, code }) => status !== 'missing' || code === FROM_VAULT,
  )
  return { checklist, ready }
}

// --- the join service -----------------------------------------------------------------------------

export interface JoinDeps {
  locator: Pick<Locator, 'detect' | 'exe'>
  settings: Pick<ApSettings, 'set'>
  vault: Pick<Vault, 'resolveRomForEntry'>
  bizhawk: Pick<Bizhawk, 'state'>
  /** The games of the worlds Archipelago loads, core games included (the worlds service). */
  installedGames: () => Promise<ReadonlyMap<string, unknown>>
  /** The loaded custom worlds whose game nothing tells (the worlds service). Default: none. */
  unknownWorlds?: () => Promise<readonly string[]>
  /** The site rooms are read from. Default: an anonymous client of the site of the config. */
  webhost?: () => WebhostClient
  /** Default: spawnAp. */
  spawn?: (ctx: CoreContext, opts: SpawnApOptions) => ApProcess
  /** join:resolve: whether a path is an existing file. Default: an absolute path to a regular file. */
  existsFile?: (p: string) => boolean
  /** Replace the waits for the port of a room that wakes up (tests). */
  sleep?: Sleep
  now?: () => number
}

export interface TextClientOptions {
  host: string
  port: number
  slot: string
  password: string | null
}

export interface Join {
  /** What the player gave (`parseJoinInput`). */
  resolve(input: string): JoinTarget
  /**
   * The plan of a target (task `join-prepare`). A room without `slotName` gives its slots (it is
   * woken up when it has no port) and downloads nothing; with one, the slot's file is downloaded into
   * dataRoot/rooms/<roomId>/. A patch path goes through `assertUserPath`. A patch whose `server` is not
   * the room's current port gets the warning `patch-server-stale`.
   */
  prepare(target: JoinTarget, slotName: string | null, task: TaskHandle): Promise<JoinPlan>
  /** The plan checked again (after a fix); NOT_FOUND for a plan this run does not know. */
  refresh(planId: string): Promise<JoinPlan>
  /**
   * Starts the plan's client with its patch, in a window of its own that outlives the app. A ROM only
   * the vault has is written into Archipelago's settings first (that key only: SETTINGS_LOCKED and the
   * other errors of the settings stop the launch). INVALID_INPUT when no client opens the slot.
   */
  play(planId: string): Promise<{ pid: number }>
  /** `ArchipelagoTextClient --connect host:port --name slot [--password pw]`. */
  textClient(opts: TextClientOptions): Promise<{ pid: number }>
}

/** A player needs no identity on the site: no cookie is sent and none is kept, so the organizer's stays as it is. */
const NO_COOKIES: CookieJarStore = { cookieHeader: () => '', store: () => undefined }

/** Plans kept for refresh and play; the oldest goes first. */
const MAX_PLANS = 32

/** A patch file ending as AP writes them (`.apemerald`); anything else is left out of a file name. */
const ENDING_RE = /^\.[A-Za-z0-9_-]{1,16}$/

/** A slot name as part of a file name: without what Windows refuses, nor a trailing dot or space. */
const fileSafe = (name: string): string =>
  name
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '')
    .slice(0, 64)
    .replace(/[. ]+$/, '')

/** `archipelago.gg:38281`, as AP writes `server`; the host alone when there is no port in it. */
function serverAddress(server: string | null): { host: string; port: number | null } {
  if (!server) return { host: '', port: null }
  const match = /^(.+):(\d{1,5})$/.exec(server.trim())
  const port = match ? portOf(match[2] ?? '') : null
  return match && port !== null ? { host: match[1] ?? '', port } : { host: server.trim(), port: null }
}

/** The patch was made while the room ran on another port (the site writes `server` at download time). */
function staleWarnings(manifest: PatchManifest | null, port: number | null): Issue[] {
  if (!manifest?.server || port === null) return []
  const written = serverAddress(manifest.server).port
  if (written === null || written === port) return []
  return [{ severity: 'warning', code: 'patch-server-stale', params: { server: manifest.server } }]
}

const routeOf = (file: string): PatchRoute => ({ ...(routeForFile(file) ?? NO_CLIENT_ROUTE) })

/** A plan before its checklist. */
type PlanBase = Omit<JoinPlan, 'planId' | 'checklist' | 'ready'>

interface Kept {
  plan: JoinPlan
  /** The game whose world is checked. */
  game: string | null
  /** A room whose slot is not chosen yet: never ready. */
  choosing: boolean
  /** The keys `play` writes: the ROMs only the vault has. */
  fromVault: SettingsEntry[]
}

export function createJoin(ctx: CoreContext, deps: JoinDeps): Join {
  const { log } = ctx
  const spawn = deps.spawn ?? spawnAp
  const existsFile = deps.existsFile ?? isLocalFile
  const webhost =
    deps.webhost ??
    ((): WebhostClient => createWebhostClient(ctx, { baseUrl: ctx.config.get().webhostUrl, jar: NO_COOKIES }))
  const plans = new Map<string, Kept>()

  function keep(kept: Kept): void {
    plans.delete(kept.plan.planId)
    plans.set(kept.plan.planId, kept)
    for (const oldest of plans.keys()) {
      if (plans.size <= MAX_PLANS) break
      plans.delete(oldest)
    }
  }

  function find(planId: string): Kept {
    const kept = plans.get(planId)
    if (!kept) throw new AppError('NOT_FOUND', undefined, { detail: 'join plan' })
    return kept
  }

  async function requireInstall(): Promise<ApInstall> {
    const install = await deps.locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    return install
  }

  /** The checklist of a plan, and the keys `play` applies. */
  async function evaluate(
    base: PlanBase,
    game: string | null,
    choosing: boolean,
  ): Promise<Pick<JoinPlan, 'checklist' | 'ready'> & { fromVault: SettingsEntry[] }> {
    const install = await deps.locator.detect()
    const loaded = install ? await deps.installedGames() : new Map<string, unknown>()
    const unknown = install ? ((await deps.unknownWorlds?.()) ?? []) : []
    const needs = base.manifest ? romsForPatch(base.manifest) : []
    const roms = await Promise.all(
      needs.map(async ({ entry, md5s }) => ({
        entry,
        resolution: await deps.vault.resolveRomForEntry(entry, md5s),
      })),
    )
    const bizhawk = base.route.client === 'bizhawk' ? await deps.bizhawk.state() : null
    const { checklist, ready } = buildChecklist({
      apInstalled: install !== null,
      apVersion: install?.version ?? null,
      game,
      loadedGames: new Set(loaded.keys()),
      unknownWorlds: unknown.length,
      baseChecksums: base.manifest?.baseChecksums ?? [],
      roms,
      route: base.route,
      bizhawk,
    })
    const fromVault = roms.flatMap(({ entry, resolution }) =>
      resolution.status === 'ok' && resolution.vaultPath !== null
        ? [{ path: SETTINGS_KEYS.romFile(entry.settingsKey), value: resolution.vaultPath }]
        : [],
    )
    return { checklist, ready: ready && !choosing, fromVault }
  }

  async function finish(
    base: PlanBase,
    game: string | null,
    choosing: boolean,
    task: TaskHandle,
  ): Promise<JoinPlan> {
    if (!choosing) task.progress('inspect', 85)
    const { checklist, ready, fromVault } = await evaluate(base, game, choosing)
    const plan: JoinPlan = { planId: randomUUID(), ...base, checklist, ready }
    keep({ plan, game, choosing, fromVault })
    task.progress('done', 100)
    return plan
  }

  /** The room, woken up when it has no port (0 before a start, -1 after an error). */
  async function readRoom(web: WebhostClient, roomId: string, task: TaskHandle) {
    task.progress('room', 10)
    let status = await web.roomStatus(roomId, task.signal)
    if (status.lastPort <= 0) {
      task.progress('wake', 25)
      await web.wake(roomId, task.signal)
      status = await waitForPort(web, roomId, { signal: task.signal, sleep: deps.sleep, now: deps.now })
    }
    return toWebRoom(roomId, '', status, web.baseUrl)
  }

  /**
   * Downloads a slot's file into dataRoot/rooms/<roomId>/ and keeps it as `P<n>_<name><ending>` (the
   * site's name without the room id, which the folder holds). A file without a readable manifest
   * (`.apsm64ex`, `.apv6`…) is no patch the app can open: it is not kept.
   */
  async function fetchSlotFile(
    roomId: string,
    slot: number,
    name: string,
    url: string,
    task: TaskHandle,
  ): Promise<{ path: string; manifest: PatchManifest } | null> {
    task.progress('download', 40)
    const dir = safeJoin(ctx.platform.paths.dataRoot, 'rooms', roomId)
    const fetched = await download(ctx.http, {
      url,
      dest: path.join(dir, `P${slot}.download`),
      sha256: null,
      signal: task.signal,
    })
    task.progress('inspect', 80)
    let manifest: PatchManifest
    try {
      manifest = await readPatchManifest(fetched.path)
    } catch (error) {
      await rm(fetched.path, { force: true })
      if (!(error instanceof AppError && error.code === 'PATCH_INVALID')) throw error
      log.info('join: the file of the slot is no patch container', { roomId, slot })
      return null
    }
    const ending = ENDING_RE.test(manifest.patchFileEnding) ? manifest.patchFileEnding : ''
    const kept = path.join(dir, `P${slot}_${fileSafe(name)}${ending}`)
    await rename(fetched.path, kept)
    return { path: kept, manifest }
  }

  async function prepareRoom(roomId: string, slotName: string | null, task: TaskHandle): Promise<JoinPlan> {
    const target: JoinTarget = { kind: 'room', roomId }
    const room = await readRoom(webhost(), roomId, task)
    const slots = room.players
    const connect = { host: room.host, port: room.port, hasPassword: false }
    if (slotName === null) {
      const base: PlanBase = {
        target,
        slots,
        slot: null,
        patchPath: null,
        manifest: null,
        route: { ...NO_CLIENT_ROUTE },
        connect: { ...connect, slot: null },
        tutorialUrl: null,
        warnings: [],
      }
      return finish(base, null, true, task)
    }
    // room_status lists the players by slot number, and slots are numbered from 1
    // (WebHostLib/api/__init__.py get_players).
    const index = slots.findIndex((slot) => slot.name === slotName)
    const slot = slots[index]
    if (!slot) throw new AppError('NOT_FOUND', undefined, { detail: 'no such slot in the room' })
    const number = index + 1
    const file = room.downloads.find((candidate) => candidate.slot === number)
    const fetched = file ? await fetchSlotFile(roomId, number, slot.name, file.url, task) : null
    const base: PlanBase = {
      target,
      slots,
      slot: { ...slot },
      patchPath: fetched?.path ?? null,
      manifest: fetched?.manifest ?? null,
      route: fetched ? routeOf(fetched.path) : { ...NO_CLIENT_ROUTE },
      connect: { ...connect, slot: slot.name },
      tutorialUrl: tutorialUrl(slot.game),
      warnings: staleWarnings(fetched?.manifest ?? null, room.port),
    }
    return finish(base, slot.game, false, task)
  }

  async function preparePatch(target: JoinTarget & { kind: 'patch' }, task: TaskHandle): Promise<JoinPlan> {
    const file = await assertUserPath(target.path, { kind: 'file' })
    task.progress('inspect', 30)
    const manifest = await readPatchManifest(file)
    const base: PlanBase = {
      target,
      slots: [],
      slot: { name: manifest.playerName, game: manifest.game },
      patchPath: file,
      manifest,
      route: routeOf(file),
      connect: { ...serverAddress(manifest.server), slot: manifest.playerName, hasPassword: false },
      tutorialUrl: tutorialUrl(manifest.game),
      warnings: [],
    }
    return finish(base, manifest.game, false, task)
  }

  function prepareAddress(target: JoinTarget & { kind: 'address' }, task: TaskHandle): Promise<JoinPlan> {
    const { host, port, slot, password, game } = target
    const base: PlanBase = {
      target,
      slots: [],
      slot: slot !== null && game !== null ? { name: slot, game } : null,
      patchPath: null,
      manifest: null,
      route: { ...NO_CLIENT_ROUTE },
      connect: { host, port, slot, hasPassword: Boolean(password) },
      tutorialUrl: game === null ? null : tutorialUrl(game),
      warnings: [],
    }
    return finish(base, game, false, task)
  }

  /** A client in a window of its own, run from Archipelago's user folder, that outlives the app. */
  async function launch(install: ApInstall, program: string, args: string[]): Promise<{ pid: number }> {
    const proc = spawn(ctx, {
      exe: deps.locator.exe(install, program),
      args,
      // AP loads the settings file of its cwd; an AppImage has no readable local folder (localPath '').
      cwd: install.paths.userPath,
      stdin: 'ignore',
      window: 'visible',
      // spawnAp unrefs it and leaves its output alone.
      detached: true,
    })
    if (proc.pid === 0) {
      const cause = await proc.exited.then(
        () => undefined,
        (error: unknown) => error,
      )
      throw new AppError('AP_NOT_INSTALLED', undefined, { detail: `${program}: ${String(cause)}`, cause })
    }
    return { pid: proc.pid }
  }

  return {
    resolve: (input) => parseJoinInput(input, existsFile),

    prepare(target, slotName, task) {
      switch (target.kind) {
        case 'room':
          return prepareRoom(target.roomId, slotName, task)
        case 'patch':
          return preparePatch(target, task)
        case 'address':
          return prepareAddress(target, task)
      }
    },

    async refresh(planId) {
      const kept = find(planId)
      const { checklist, ready, fromVault } = await evaluate(kept.plan, kept.game, kept.choosing)
      const plan: JoinPlan = { ...kept.plan, checklist, ready }
      keep({ ...kept, plan, fromVault })
      return plan
    },

    async play(planId) {
      const { plan, fromVault } = find(planId)
      if (plan.route.exe === null || plan.patchPath === null) {
        throw new AppError('INVALID_INPUT', undefined, { detail: 'no client opens this slot' })
      }
      const install = await requireInstall()
      const { rom } = plan.checklist
      if (rom.status === 'missing' && rom.code === FROM_VAULT && fromVault.length > 0) {
        await deps.settings.set(fromVault)
      }
      return launch(install, plan.route.exe, [plan.patchPath])
    },

    async textClient({ host, port, slot, password }) {
      const install = await requireInstall()
      const args = ['--connect', `${host}:${port}`, '--name', slot]
      if (password) args.push('--password', password)
      return launch(install, TEXT_CLIENT, args)
    },
  }
}
