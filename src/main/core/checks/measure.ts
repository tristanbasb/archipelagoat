// Exact check counts (spec §3.4). A player is measured alone: its document goes to
// `dataRoot/tmp/measure-<uuid>/players/`, next to the settings file its real generation would have (the
// session's rules, or the defaults outside a session, and the ROM paths the vault resolves; never the
// session's passwords, which no count depends on), and
// ArchipelagoGenerate runs there without spoiler nor progression balancing on seed 42, or on 42, 1337
// and 2026 for a YAML that rolls dice. The count is the size of the slot's locations in the
// `.archipelago`; the folder goes right after. At most two test generations run at once, two minutes
// each at most; a measure asked in the background (the refinement of profiles) takes one of the two
// at most, and only when no measure asked in the foreground waits (unless its lane is raised to the
// foreground meanwhile). A count once measured is kept in `dataRoot/checks/measures.json` (by world
// versions, YAML and seed) and never measured again; the last counts of a session, measured or read
// from its real generation, in `dataRoot/checks/sessions/<id>.json`.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AP_EXES } from '@shared/data/ap-constants'
import { AppError, isAppErrorData, toAppErrorData, type AppErrorData } from '@shared/errors'
import { defaultRules } from '@shared/rules'
import type {
  ApInstall,
  PlayerChecks,
  PlayerDoc,
  PlayerFile,
  PlayerMeasure,
  RomNeed,
  SessionChecks,
} from '@shared/types'
import {
  buildMeasureArgs,
  extractGenerationError,
  romPathsOf,
  runProcess,
  type ProcessRun,
} from '../ap/generate'
import { throwIfCancelled } from '../ap/install-steps'
import type { Locator } from '../ap/locator'
import type { spawnAp } from '../ap/process'
import type { ApSettings, SettingsEntry } from '../ap/settings'
import type { CoreContext } from '../context'
import { readJsonSync } from '../json-file'
import { buildSessionSettingsEntries, type SessionSecrets } from '../sessions/rules'
import type { PlayerSource, SessionStore } from '../sessions/store'
import { SESSION_ID_RE, writeSessionHostYaml } from '../sessions/workspace'
import { writeFileAtomic } from '../system/fsx'
import { redact } from '../system/redact'
import type { TaskHandle } from '../tasks'
import { loadedWorldVersion } from '../worlds/world-version'
import { loadYaml11 } from '../yaml/load'
import { gamesIn, type ValidationContext } from '../yaml/validate'
import { parsePlayerYaml, renderPlayerYaml } from '../yaml/writer'
import type { CheckEstimates } from './datapackage'
import { readMultidataFromZip } from './multidata'

const SEED = 42
const WEIGHTED_SEEDS = [42, 1337, 2026]
/** A test generation of one player takes about a second: past this it is stopped. */
const TIMEOUT_MS = 2 * 60 * 1000
/** Test generations running at once, whoever asked for them. */
const MAX_RUNNING = 2
/** Of them, the background ones: a measure asked in the foreground always has a free slot soon. */
const MAX_BACKGROUND = 1
const DIR_PREFIX = 'measure-'
const PLAYER_FILE = 'p.yaml'
/** The measures kept, the oldest dropped first: refining profiles measures a dozen variants per game. */
const MAX_KEPT = 10_000
/** Where a session measure's bar stands once every player is measured. */
const MEASURED_PERCENT = 95
/** A measure's settings file never holds passwords: a crash would leave them in tmp/. */
const NO_SECRETS: SessionSecrets = { password: null, serverPassword: null }

// --- weighted documents ------------------------------------------------------------------------------

/** `random`, `random-low`, `random-range-1-10`…: a value Archipelago rolls. */
const RANDOM_VALUE = /^random(?:-|$)/i

/**
 * The options whose mapping or list is their value, not weights (OptionDict, OptionSet, OptionList,
 * ItemLinks and the plando options): `start_inventory: { Dash: 1, Claw: 1 }` rolls nothing.
 */
const VALUE_OPTIONS = new Set([
  'local_items',
  'non_local_items',
  'start_inventory',
  'start_inventory_from_pool',
  'start_hints',
  'start_location_hints',
  'exclude_locations',
  'priority_locations',
  'item_links',
  'plando_items',
  'plando_connections',
  'plando_texts',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A weight as Archipelago reads it (`int(weight)`); null for what cannot be one. */
function weightOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return Number(value)
  return null
}

/** The choices of a mapping of weights that weigh more than 0; null for what is not weights. */
function liveChoices(value: unknown): { choice: string; weight: number }[] | null {
  if (!isRecord(value)) return null
  const live: { choice: string; weight: number }[] = []
  for (const [choice, weight] of Object.entries(value)) {
    const n = weightOf(weight)
    // A mapping that is not weights is the option's own value.
    if (n === null) return null
    if (n > 0) live.push({ choice, weight: n })
  }
  return live
}

/** True when `value` leaves the choice to the dice: weights on several choices, or a random one. */
function rolls(value: unknown): boolean {
  if (typeof value === 'string') return RANDOM_VALUE.test(value.trim())
  const live = liveChoices(value)
  return live !== null && (live.length > 1 || live.some(({ choice }) => RANDOM_VALUE.test(choice.trim())))
}

/**
 * The one choice a mapping of weights always gives, with its weight: a single weight above 0, on a
 * choice that is not random (Archipelago's templates write every option so, `goal: { nap: 50,
 * photo: 0 }`). Null when the mapping rolls dice, gives nothing, or is not weights.
 */
export function soleChoice(value: unknown): { choice: string; weight: number } | null {
  const [only, ...more] = liveChoices(value) ?? []
  return only === undefined || more.length > 0 || RANDOM_VALUE.test(only.choice.trim()) ? null : only
}

/**
 * True when the document rolls dice that may change its count (spec §3.4): its `game` among several
 * games, or an option of `game`'s section with more than one choice of non-zero weight or a `random*`
 * value. Without the schema, an option whose mapping is its value (an OptionDict of the game) may be
 * taken for weights: that only costs two more measures, which then agree.
 */
export function isWeighted(doc: unknown, game: string): boolean {
  if (!isRecord(doc)) return false
  const rolled = doc.game
  if (Array.isArray(rolled) ? new Set(rolled).size > 1 : rolls(rolled)) return true
  const section = doc[game]
  if (!isRecord(section)) return false
  return Object.entries(section).some(([key, value]) => !VALUE_OPTIONS.has(key) && rolls(value))
}

/** One count as it is; three as their middle one, and their range when they differ. */
function combine(counts: readonly number[]): PlayerMeasure {
  const sorted = [...counts].sort((a, b) => a - b)
  const fewest = sorted[0] ?? 0
  const most = sorted.at(-1) ?? 0
  return {
    checks: sorted[Math.floor(sorted.length / 2)] ?? null,
    range: fewest === most ? null : [fewest, most],
    error: null,
  }
}

/** The one document of `yamlText` as the writer renders it: the same options give the same text. */
function normalized(yamlText: string): string {
  const { docs, issues } = parsePlayerYaml(yamlText)
  const [doc, ...more] = docs
  if (doc === undefined || more.length > 0 || issues.length > 0) {
    const detail = issues[0]?.code ?? `${docs.length} player documents, one expected`
    throw new AppError('AP_YAML_INVALID', undefined, { detail })
  }
  return renderPlayerYaml(doc)
}

/** How many players a document makes: its `quantity` (a whole number above 0), else 1. */
function quantityOf(doc: unknown): number {
  const quantity = isRecord(doc) ? doc.quantity : undefined
  return typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1
}

/**
 * The first slot Archipelago gives each document of a session, and how many players they make: a
 * session keeps its files in Archipelago's order (the store sorts them as Generate does), each file
 * its documents in order, and a document with `quantity: N` takes N slots in a row.
 */
function firstSlots(files: readonly PlayerSource[]): {
  docs: { file: PlayerFile; doc: PlayerDoc; slot: number }[]
  players: number
} {
  const docs: { file: PlayerFile; doc: PlayerDoc; slot: number }[] = []
  let next = 1
  for (const { file, text } of files) {
    // The documents as PlayerDoc.index counts them: the empty ones left out.
    const loaded = loadYaml11(text).docs.filter((doc) => doc !== null && doc !== undefined)
    for (const doc of file.docs) {
      docs.push({ file, doc, slot: next })
      next += quantityOf(loaded[doc.index])
    }
  }
  return { docs, players: next - 1 }
}

// --- the files -----------------------------------------------------------------------------------------

/** `dataRoot/checks/measures.json`: key (world versions, YAML hash, seed) → count. */
const keptSchema = z.object({
  version: z.literal(1),
  measures: z.record(
    z.string(),
    z.object({ checks: z.number().int().nonnegative(), measuredAt: z.string() }),
  ),
})
type Kept = z.infer<typeof keptSchema>['measures'][string]

/** `dataRoot/checks/sessions/<id>.json`. A file that does not have this shape is as good as none. */
const sessionChecksSchema = z.object({
  measuredAt: z.string(),
  players: z.array(
    z.object({
      fileId: z.string(),
      docIndex: z.number().int().nonnegative(),
      name: z.string(),
      game: z.string().nullable(),
      checks: z.number().int().nonnegative().nullable(),
      range: z.tuple([z.number(), z.number()]).nullable(),
      source: z.enum(['measure', 'generation', 'estimate']),
      error: z.custom<AppErrorData>(isAppErrorData).nullable(),
    }),
  ),
})

// --- the queue of test generations ----------------------------------------------------------------

export type MeasurePriority = 'foreground' | 'background'

/**
 * A priority its owner changes while its measures wait: the background refinement of a game goes to
 * the foreground while a « Jeu prêt » waits for it, and back once nobody does (Ruling 34).
 */
export interface MeasureLane {
  /** The priority its measures wait with now. */
  priority(): MeasurePriority
  /** Calls `listener` each time the priority changes. */
  watch(listener: () => void): void
}

/** A lane at `priority`, which `set` changes. */
export function createLane(priority: MeasurePriority): MeasureLane & { set(next: MeasurePriority): void } {
  let current = priority
  const listeners: (() => void)[] = []
  return {
    priority: () => current,
    watch: (listener) => void listeners.push(listener),
    set(next) {
      if (next === current) return
      current = next
      for (const listener of listeners) listener()
    },
  }
}

/**
 * Runs the jobs given to it, MAX_RUNNING at once and MAX_BACKGROUND of them background at most; a
 * waiting foreground job always starts before a waiting background one, each kind in its order. A
 * lane's jobs wait with its priority of the moment, and start with it.
 */
function createQueue(): <T>(priority: MeasurePriority | MeasureLane, job: () => Promise<T>) => Promise<T> {
  const waiting: { priority: () => MeasurePriority; start: () => void }[] = []
  const watched = new WeakSet<MeasureLane>()
  let running = 0
  let background = 0
  const startNext = (): void => {
    while (running < MAX_RUNNING) {
      const foreground = waiting.findIndex((job) => job.priority() === 'foreground')
      // Without a foreground job, the first one waiting is the first background one.
      const next = foreground !== -1 ? foreground : background < MAX_BACKGROUND && waiting.length > 0 ? 0 : -1
      if (next === -1) return
      waiting.splice(next, 1)[0]?.start()
    }
  }
  return (priority, job) => {
    const priorityNow = typeof priority === 'string' ? () => priority : () => priority.priority()
    // A lane raised lets its jobs take a free slot at once.
    if (typeof priority !== 'string' && !watched.has(priority)) {
      watched.add(priority)
      priority.watch(startNext)
    }
    return new Promise((resolve, reject) => {
      waiting.push({
        priority: priorityNow,
        start: () => {
          const isBackground = priorityNow() === 'background'
          running++
          if (isBackground) background++
          void job()
            .then(resolve, reject)
            .finally(() => {
              running--
              if (isBackground) background--
              startNext()
            })
        },
      })
      startNext()
    })
  }
}

// --- the measurer -------------------------------------------------------------------------------------

export interface MeasureInput {
  /** The session whose rules and passwords the settings file gets; null: the default rules. */
  sessionId: string | null
  /** The game whose options are looked at for dice (`isWeighted`). */
  game: string
  /** One player document. */
  yamlText: string
  /** Only its signal is used: a measure reports no stage, it runs within its caller's task. */
  task: TaskHandle
  /**
   * `background` for a measure nobody waits for (the refinement of profiles): it starts only when no
   * foreground measure waits, one at a time. A lane's priority may change while it waits. Default:
   * `foreground`.
   */
  priority?: MeasurePriority | MeasureLane
}

export interface Measurer {
  /**
   * The checks of one player document, measured alone (or kept from an identical measure). Rejects
   * only with TASK_CANCELLED: a measure that fails gives its `error` (AP_ROM_MISSING when a game needs
   * a ROM to generate that the vault does not have, AP_NOT_INSTALLED, MEASURE_TIMEOUT, the error
   * Archipelago printed…).
   */
  measureDoc(input: MeasureInput): Promise<PlayerMeasure>
  /**
   * Measures every player document of the session, through the task's stages `prepare`, `generate`
   * (with `done` / `total`), `read` and `done`, and keeps the result as the session's last checks. A
   * failure only touches its player's row; a player lacking a ROM keeps the estimate of its game.
   */
  measureSession(sessionId: string, task: TaskHandle): Promise<SessionChecks>
  /** The session's last checks; null before any. NOT_FOUND for an unknown session. */
  lastSession(sessionId: string): Promise<SessionChecks | null>
  /**
   * Reads the counts of a real generation of the session from its zip (nothing is measured) and keeps
   * them as the session's last checks; its datapackage feeds the estimates.
   */
  fromGeneration(sessionId: string, zipPath: string): Promise<void>
}

export interface MeasurerDeps {
  locator: Pick<Locator, 'detect' | 'exe'>
  settings: Pick<ApSettings, 'makeSessionSettings'>
  sessions: Pick<SessionStore, 'loadPlayers' | 'get'>
  /** Game → version of the world Archipelago loads for it: a kept measure holds for that version. */
  worlds: { installedGames(): Promise<ValidationContext['installedGames']> }
  /**
   * The ROMs Archipelago asks for while it generates these games, resolved by the vault as the
   * session validation does (`resolveRomNeeds`).
   */
  romNeeds(games: readonly string[]): Promise<RomNeed[]>
  estimates: Pick<CheckEstimates, 'maxFor' | 'addFromMultidata'>
  /**
   * Settles once the programs a previous run left were stopped: the folders it left are removed only
   * then, since a running program holds its folder. Default: at once.
   */
  orphansStopped?: Promise<unknown>
  /** Default: spawnAp (a fake in the tests). */
  spawn?: typeof spawnAp
  /** The clock of `measuredAt`. Default: `Date.now`. */
  now?: () => number
}

/** One test generation: a document, a seed, and what its folder gets. */
interface TestRun {
  text: string
  seed: number
  entries: SettingsEntry[]
  install: ApInstall
  sessionId: string | null
  task: TaskHandle
}

/** A row of a session measure before its counts. */
type RowHead = Pick<PlayerChecks, 'fileId' | 'docIndex' | 'name' | 'game'>

interface Job {
  head: RowHead
  /** The document alone, as the writer renders it; null when its file cannot be read (`failed`). */
  yamlText: string | null
  /** The game measureDoc looks at for dice. */
  game: string
  failed: AppErrorData | null
}

export function createMeasurer(ctx: CoreContext, deps: MeasurerDeps): Measurer {
  const { dataRoot } = ctx.platform.paths
  const tmpRoot = path.join(dataRoot, 'tmp')
  const keptFile = path.join(dataRoot, 'checks', 'measures.json')
  const sessionsDir = path.join(dataRoot, 'checks', 'sessions')
  const now = deps.now ?? Date.now
  const queue = createQueue()
  const isoNow = (): string => new Date(now()).toISOString()

  // --- the folders of the test generations ---

  /** Removes the measure folders a previous run left (it crashed or quit mid-measure); nothing else. */
  async function sweep(): Promise<void> {
    await Promise.resolve(deps.orphansStopped).catch(() => undefined)
    let names: string[]
    try {
      names = await readdir(tmpRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.log.warn('measure: cannot list tmp/', error)
      return
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(DIR_PREFIX))
        .map((name) =>
          rm(path.join(tmpRoot, name), { recursive: true, force: true, maxRetries: 3 }).catch(
            (error: unknown) =>
              ctx.log.warn('measure: cannot remove a leftover folder', { name, error: String(error) }),
          ),
        ),
    )
  }
  /** Started with the app; a new measure folder waits for it, so that the sweep never takes it. */
  const swept = sweep()

  // --- the kept measures ---

  let kept: Map<string, Kept> | null = null
  function keptMeasures(): Map<string, Kept> {
    if (kept === null) {
      const saved = keptSchema.safeParse(readJsonSync(keptFile))
      kept = new Map(saved.success ? Object.entries(saved.data.measures) : [])
    }
    return kept
  }

  function keep(key: string, checks: number): void {
    const measures = keptMeasures()
    // Moved to the end: the oldest come first, and go first.
    measures.delete(key)
    measures.set(key, { checks, measuredAt: isoNow() })
    for (const oldest of measures.keys()) {
      if (measures.size <= MAX_KEPT) break
      measures.delete(oldest)
    }
  }

  let writing: Promise<void> = Promise.resolve()
  /** Writes the kept measures as they are now; the writes run one after the other. Never rejects. */
  function saveKept(): Promise<void> {
    const content = JSON.stringify({ version: 1, measures: Object.fromEntries(keptMeasures()) })
    writing = writing
      .then(() => writeFileAtomic(keptFile, content))
      .catch((error: unknown) => ctx.log.warn('measure: cannot save the kept measures', error))
    return writing
  }

  /** The file of a session's last checks; NOT_FOUND for what is not a session id (no path escapes). */
  function sessionFile(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new AppError('NOT_FOUND', undefined, { detail: `session ${id}` })
    return path.join(sessionsDir, `${id}.json`)
  }

  // --- one test generation ---

  /** Runs Archipelago in `dir` to its exit, two minutes at most; the task's cancel stops it too. */
  async function runWithin(
    run: TestRun,
    dir: string,
    ws: { players: string; output: string },
  ): Promise<ProcessRun> {
    const stop = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop.abort()
    }, TIMEOUT_MS)
    const cancel = (): void => stop.abort()
    run.task.signal.addEventListener('abort', cancel, { once: true })
    if (run.task.signal.aborted) stop.abort()
    let result: ProcessRun
    try {
      result = await runProcess(ctx, {
        exe: deps.locator.exe(run.install, AP_EXES.generate),
        args: buildMeasureArgs(ws, run.seed),
        cwd: dir,
        ...(run.sessionId === null ? {} : { sessionId: run.sessionId }),
        // Its own folder and host.yaml: never a reason to refuse an edit of the global settings.
        scoped: true,
        // The stages and lines of a test generation are not its caller's: only the signal goes through.
        task: { id: run.task.id, signal: stop.signal, progress: () => undefined, log: () => undefined },
        mask: (line) => redact(line),
        stallMs: TIMEOUT_MS,
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      })
    } finally {
      clearTimeout(timer)
      run.task.signal.removeEventListener('abort', cancel)
    }
    throwIfCancelled(run.task.signal)
    if (timedOut) throw new AppError('MEASURE_TIMEOUT')
    return result
  }

  /** One test generation in a folder of its own, removed afterwards: the checks of its one slot. */
  async function generateOnce(run: TestRun): Promise<number> {
    await swept
    throwIfCancelled(run.task.signal)
    const dir = path.join(tmpRoot, `${DIR_PREFIX}${randomUUID()}`)
    const ws = { players: path.join(dir, 'players'), output: path.join(dir, 'output') }
    try {
      // Owner-only, as a session folder.
      await mkdir(ws.players, { recursive: true, mode: 0o700 })
      await mkdir(ws.output, { mode: 0o700 })
      await writeFile(path.join(ws.players, PLAYER_FILE), run.text, 'utf8')
      await writeSessionHostYaml(deps.settings, dir, run.entries, ctx.platform.os)
      const result = await runWithin(run, dir, ws)
      if (result.exit.code !== 0 || result.zipPath === null) {
        const { code, params, detail } = extractGenerationError(result.stderr, result.stdout)
        throw new AppError(code, params, detail === undefined ? {} : { detail })
      }
      const summary = await readMultidataFromZip(path.resolve(dir, result.zipPath))
      await deps.estimates.addFromMultidata(summary.datapackage)
      // A document with `quantity: N` makes N players with the same options: the first one counts.
      const [slot] = summary.slots
      if (slot === undefined) {
        throw new AppError(
          'MULTIDATA_UNREADABLE',
          { reason: 'shape' },
          { detail: 'no slot in a test generation' },
        )
      }
      return slot.checks
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) =>
        ctx.log.warn('measure: cannot remove its folder', { dir, error: String(error) }),
      )
    }
  }

  // --- measures ---

  async function measure(input: MeasureInput): Promise<PlayerMeasure> {
    const { sessionId, task } = input
    const text = normalized(input.yamlText)
    const doc = loadYaml11(text).docs[0]
    const games = gamesIn([doc]).sort()
    const seeds = isWeighted(doc, input.game) ? WEIGHTED_SEEDS : [SEED]
    const install = await deps.locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    const installed = await deps.worlds.installedGames()
    // A count holds for these worlds at these versions (Archipelago's own for its core worlds, its file
    // for a custom world without one).
    const worlds = await Promise.all(
      games.map(async (game) => [
        game,
        (await loadedWorldVersion(installed, game, install.version)) ?? install.version,
      ]),
    )
    const yamlHash = createHash('sha256').update(text).digest('hex')
    const keyOf = (seed: number): string => JSON.stringify([worlds, yamlHash, seed])

    const counts = new Map<number, number>()
    for (const seed of seeds) {
      const hit = keptMeasures().get(keyOf(seed))
      if (hit) counts.set(seed, hit.checks)
    }
    const missing = seeds.filter((seed) => !counts.has(seed))
    if (missing.length > 0) {
      const needs = await deps.romNeeds(games)
      // Archipelago would stop without it; a ROM only ever comes from the vault.
      const absent = needs.find((need) => need.status !== 'ok')
      if (absent) throw new AppError('AP_ROM_MISSING', { game: absent.game })
      const rules = sessionId === null ? defaultRules() : (await deps.sessions.get(sessionId)).rules
      const entries = buildSessionSettingsEntries(rules, NO_SECRETS, romPathsOf(needs))
      const results = await Promise.allSettled(
        missing.map((seed) =>
          queue(input.priority ?? 'foreground', () =>
            generateOnce({ text, seed, entries, install, sessionId, task }),
          ),
        ),
      )
      let measured = false
      results.forEach((result, i) => {
        const seed = missing[i]
        if (result.status !== 'fulfilled' || seed === undefined) return
        counts.set(seed, result.value)
        keep(keyOf(seed), result.value)
        measured = true
      })
      if (measured) await saveKept()
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) throw failed.reason
    }
    return combine(seeds.map((seed) => counts.get(seed) ?? 0))
  }

  async function measureDoc(input: MeasureInput): Promise<PlayerMeasure> {
    throwIfCancelled(input.task.signal)
    try {
      return await measure(input)
    } catch (error) {
      if (input.task.signal.aborted) throw new AppError('TASK_CANCELLED')
      const data = toAppErrorData(error)
      if (data.code === 'AP_UNKNOWN') ctx.log.error('measure failed', error)
      return { checks: null, range: null, error: data }
    }
  }

  /** The documents of a player file, each with its own text; a file the writer cannot read fails them. */
  function jobsOf(file: PlayerFile, text: string): Job[] {
    const { docs, issues } = parsePlayerYaml(text)
    if (issues.length > 0) {
      const failed: AppErrorData = { code: 'AP_YAML_INVALID', detail: issues[0]?.code ?? 'yaml-syntax' }
      return file.docs.map((doc) => ({
        head: { fileId: file.id, docIndex: doc.index, name: doc.name ?? '', game: null },
        yamlText: null,
        game: '',
        failed,
      }))
    }
    return docs.map((doc, docIndex) => {
      const known = file.docs[docIndex]
      return {
        // `game` is empty when the document rolls it (or has none).
        head: {
          fileId: file.id,
          docIndex,
          name: known?.name ?? doc.name,
          game: doc.game === '' ? null : doc.game,
        },
        yamlText: renderPlayerYaml(doc),
        game: doc.game === '' ? (known?.games[0]?.game ?? '') : doc.game,
        failed: null,
      }
    })
  }

  /** The row of a measured document: one that lacks the ROM its game needs keeps the estimate. */
  function rowOf(head: RowHead, measured: PlayerMeasure): PlayerChecks {
    if (measured.error?.code === 'AP_ROM_MISSING') {
      const checks = head.game === null ? null : deps.estimates.maxFor(head.game)
      return { ...head, checks, range: null, source: 'estimate', error: measured.error }
    }
    return { ...head, ...measured, source: 'measure' }
  }

  return {
    measureDoc,

    async measureSession(sessionId, task) {
      task.progress('prepare', 0)
      const { files } = await deps.sessions.loadPlayers(sessionId)
      const jobs = files.flatMap(({ file, text }) => jobsOf(file, text))
      const total = jobs.filter((job) => job.yamlText !== null).length
      let done = 0
      task.progress('generate', 0, { done, total })
      const settled = await Promise.allSettled(
        jobs.map(async (job): Promise<PlayerChecks> => {
          if (job.yamlText === null) {
            return { ...job.head, checks: null, range: null, source: 'measure', error: job.failed }
          }
          const measured = await measureDoc({ sessionId, game: job.game, yamlText: job.yamlText, task })
          done++
          task.progress('generate', Math.round((MEASURED_PERCENT * done) / total), { done, total })
          return rowOf(job.head, measured)
        }),
      )
      // Every measure is over (its folder gone) before the task ends, cancelled or not.
      throwIfCancelled(task.signal)
      const players = settled.map((result) => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      task.progress('read', MEASURED_PERCENT)
      const checks: SessionChecks = { measuredAt: isoNow(), players }
      await writeFileAtomic(sessionFile(sessionId), JSON.stringify(checks))
      task.progress('done', 100)
      return checks
    },

    async lastSession(sessionId) {
      // NOT_FOUND for a session that does not exist (any more).
      await deps.sessions.get(sessionId)
      const saved = sessionChecksSchema.safeParse(readJsonSync(sessionFile(sessionId)))
      return saved.success ? saved.data : null
    },

    async fromGeneration(sessionId, zipPath) {
      const file = sessionFile(sessionId)
      const summary = await readMultidataFromZip(zipPath)
      await deps.estimates.addFromMultidata(summary.datapackage)
      const { files } = await deps.sessions.loadPlayers(sessionId)
      const slots = new Map(summary.slots.map((slot) => [slot.slot, slot]))
      const expected = firstSlots(files)
      const players = expected.docs.flatMap(({ file: player, doc, slot: number }): PlayerChecks[] => {
        const slot = slots.get(number)
        if (slot === undefined) return []
        return [
          {
            fileId: player.id,
            docIndex: doc.index,
            name: slot.name || (doc.name ?? ''),
            game: slot.game || null,
            checks: slot.checks,
            range: null,
            source: 'generation',
            error: null,
          },
        ]
      })
      // The seed is not the session as it is now (a file added or changed meanwhile): rather no
      // count than another player's. The last counts stay as they were.
      if (summary.slots.length !== expected.players || players.length !== expected.docs.length) {
        ctx.log.warn('measure: the seed does not match the session, its counts are not kept', {
          sessionId,
          slots: summary.slots.length,
          players: expected.players,
        })
        return
      }
      const checks: SessionChecks = { measuredAt: isoNow(), players }
      await writeFileAtomic(file, JSON.stringify(checks))
    },
  }
}
