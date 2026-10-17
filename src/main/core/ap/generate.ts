// The generation of a session (spec §3.8, research brief §1.6). Nothing starts unless the session
// validates; then its host.yaml is written (rules, passwords, the ROM paths the vault resolved) and
// ArchipelagoGenerate runs in the session folder with stdin closed, since on any failure it waits for
// Enter. Its lines drive the progress (GENERATE_STAGE_IDS) and go to the session's logs, masked. A
// success is an exit 0 with a final archive: the AP_<seed>.zip is read into slots, each slot's files
// extracted under output/slots/, and the session leaves the hosting of its previous seed. A failure
// is the last exception Archipelago printed, as an error code. A generation and a local server of the
// same session never run together: each refuses while the other runs.
import { access, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import type { CoreContext } from '@main/core/context'
import { buildSessionSettingsEntries } from '@main/core/sessions/rules'
import type { SessionStore } from '@main/core/sessions/store'
import type { SessionValidator } from '@main/core/sessions/validate-session'
import { workspacePaths, writeSessionHostYaml } from '@main/core/sessions/workspace'
import { extractZipSafe, listZip, readZipText, type ZipLimits } from '@main/core/system/archive'
import { safeJoin } from '@main/core/system/fsx'
import { redact } from '@main/core/system/redact'
import { startTracked, type TaskHandle } from '@main/core/tasks'
import { disabledWorldsDir, findCorruptWorld } from '@main/core/worlds/inventory'
import type { GenerateStageId } from '@shared/codes'
import { AP_EXES } from '@shared/data/ap-constants'
import { matchApError } from '@shared/data/error-catalog'
import { FILL_STEP_RE, FINAL_ARCHIVE_RE, GENERATE_STAGES } from '@shared/data/log-patterns'
import { routeForFile } from '@shared/data/patch-routes'
import { AppError, type AppErrorData } from '@shared/errors'
import type {
  ApInstall,
  ExeRef,
  Generation,
  RomNeed,
  Rules,
  SessionValidation,
  Slot,
  TaskRef,
} from '@shared/types'
import { throwIfCancelled } from './install-steps'
import type { Locator } from './locator'
import { childrenFile, listChildren, readChildren, spawnAp, type ApExit, type ApStream } from './process'
import type { ApSettings } from './settings'

/** Where a generation stands: a stage code and its percentage, which never goes back. */
export interface GenProgress {
  stage: GenerateStageId
  percent: number
}

export interface GenerateDeps {
  sessions: Pick<SessionStore, 'get' | 'getSecrets' | 'setGeneration' | 'setHosting'> &
    Pick<SessionValidator, 'validateSession'>
  settings: Pick<ApSettings, 'makeSessionSettings'>
  locator: Pick<Locator, 'detect' | 'exe'>
  /**
   * True while a local server of the session runs. Default: `serverRunsFor`, which only sees the
   * servers of this run; the service passes `servers.isBusy`, which also sees an orphan server.
   */
  isServing?: (sessionId: string) => boolean
  /** The silence after which the task reports a stall. Default: 10 minutes. */
  stallMs?: number
  /**
   * The file name of a corrupt world of the install, on which Archipelago would stop; null when
   * there is none. Default: a scan of its world folders (findCorruptWorld).
   */
  corruptWorld?: (install: ApInstall) => Promise<string | null>
}

export interface GenerateOptions {
  /**
   * Replaces the game the session hosts (its archipelago.gg room, or its local game and save), which
   * the new seed leaves behind: given once the user confirmed it.
   */
  replace?: boolean
}

export interface Generator {
  /** Runs the generation of the session as a `generate` task; one at a time per session. */
  generate(sessionId: string, opts?: GenerateOptions): TaskRef
  /** True from the moment a generation of the session is asked for until it is over. */
  isGenerating(sessionId: string): boolean
}

const STALL_MS = 10 * 60 * 1000
/** The lines of each stream kept for the error: the last exception is at the end. */
const KEPT_LINES = 2000
/** A line streamed to the task, cut: a FillError line is megabytes long (the log keeps it whole). */
const MAX_LIVE_LINE = 4000
const MAX_DETAIL = 4000
/** Without an exception, the end of the output says what happened last. */
const OUTPUT_TAIL = 20
/** A generation's own archive: bigger than an archive from the outside may be. */
const ZIP_LIMITS: Partial<ZipLimits> = { maxUncompressed: 2 * 1024 * 1024 * 1024 }
/** Only its header is read; a spoiler bigger than this gives its slots through the file names. */
const SPOILER_MAX_BYTES = 64 * 1024 * 1024
const SLOTS_DIR = 'slots'

// --- arguments -----------------------------------------------------------------------------------

/**
 * The arguments of ArchipelagoGenerate (spec §3.8): absolute folders, since Generate resolves a
 * relative one against its cwd, then the spoiler level, `--race` and the plando modules.
 */
export function buildGenerateArgs(ws: { players: string; output: string }, rules: Rules): string[] {
  const args = [
    '--player_files_path',
    path.resolve(ws.players),
    '--outputpath',
    path.resolve(ws.output),
    '--spoiler',
    String(rules.spoiler),
  ]
  if (rules.race) args.push('--race')
  if (rules.plando.length > 0) args.push('--plando', rules.plando.join(', '))
  return args
}

// --- progress ------------------------------------------------------------------------------------

const fillIndex = GENERATE_STAGES.findIndex((stage) => stage.id === 'fill')
const FILL_START = GENERATE_STAGES[fillIndex]?.percent ?? 0
/** The fill never reaches the stage after it: only that stage's line does. */
const FILL_END = (GENERATE_STAGES[fillIndex + 1]?.percent ?? 100) - 1

/** `Current fill step (<name>) at <done>/<total> items placed.`, or null. */
function fillStep(line: string): { done: number; total: number } | null {
  const groups = FILL_STEP_RE.exec(line)?.groups
  const done = Number(groups?.done)
  const total = Number(groups?.total)
  if (!groups || !(total > 0)) return null
  return { done: Math.min(done, total), total }
}

/**
 * The progress after `line`: the stage it starts when that stage is further, and during `fill`, the
 * part of the fill a fill step says is done. Anything else returns `state` itself.
 */
export function reduceProgress(state: GenProgress, line: string): GenProgress {
  const stage = GENERATE_STAGES.find((s) => s.re.test(line))
  if (stage) return stage.percent > state.percent ? { stage: stage.id, percent: stage.percent } : state
  if (state.stage !== 'fill') return state
  const step = fillStep(line)
  if (!step) return state
  const percent = FILL_START + Math.floor(((FILL_END - FILL_START) * step.done) / step.total)
  return percent > state.percent ? { stage: 'fill', percent } : state
}

// --- errors --------------------------------------------------------------------------------------

const TRACEBACK = 'Traceback (most recent call last):'
/** The lines Python prints between the exceptions of a chain. */
const CHAIN_LINES = new Set([
  'During handling of the above exception, another exception occurred:',
  'The above exception was the direct cause of the following exception:',
])
/** Generate's atexit `input()` fails on the closed stdin after the real error: noise. */
const ATEXIT_ERROR = /^Exception ignored in atexit callback/
const PROMPT = 'Press enter to close.'

const isBlank = (line: string): boolean => line.trim() === ''
const isTraceback = (line: string): boolean => line.startsWith(TRACEBACK)

/** The lines without the atexit error and what follows it, and without trailing blanks or prompts. */
function withoutExitNoise(lines: readonly string[]): string[] {
  const atexit = lines.findLastIndex((line) => ATEXIT_ERROR.test(line))
  const kept = atexit === -1 ? [...lines] : lines.slice(0, atexit)
  while (kept.length > 0 && (isBlank(kept.at(-1) ?? '') || kept.at(-1)?.trim() === PROMPT)) kept.pop()
  return kept
}

/** The last exception as Python prints it, with the exceptions chained before it; null without one. */
function lastException(lines: readonly string[]): string[] | null {
  let start = lines.findLastIndex(isTraceback)
  if (start === -1) return null
  for (;;) {
    let before = start - 1
    while (before >= 0 && isBlank(lines[before] ?? '')) before--
    if (before < 0 || !CHAIN_LINES.has(lines[before]?.trim() ?? '')) break
    const previous = lines.slice(0, before).findLastIndex(isTraceback)
    if (previous === -1) break
    start = previous
  }
  return lines.slice(start)
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/**
 * The error of a failed generation: the last exception of stderr (or, when stderr says nothing, of
 * the end of stdout) through the error catalog, whose order decides; GENERATION_FAILED when nothing
 * matches. `detail` is that exception, cut to 4000 characters (a FillError lists every placement).
 */
export function extractGenerationError(stderr: readonly string[], stdout: readonly string[]): AppErrorData {
  const errors = withoutExitNoise(stderr)
  let block = lastException(errors) ?? (errors.some((line) => !isBlank(line)) ? errors : null)
  if (block === null) {
    const output = withoutExitNoise(stdout)
    block = lastException(output) ?? output.slice(-OUTPUT_TAIL)
  }
  const text = block.join('\n').trim()
  if (text === '') return { code: 'GENERATION_FAILED' }
  const detail = truncate(text, MAX_DETAIL)
  const match = matchApError(text)
  if (!match) return { code: 'GENERATION_FAILED', detail }
  return Object.keys(match.params).length > 0
    ? { code: match.code, params: match.params, detail }
    : { code: match.code, detail }
}

// --- the archive ---------------------------------------------------------------------------------

interface ZipContents {
  seedName: string
  spoilerName: string | null
  slots: Slot[]
  /** Slot → its files in the zip and the file-safe name they carry. */
  files: Map<number, { safeName: string; entries: string[] }>
}

/** What a spoiler header says about a slot. */
interface SpoilerSlot {
  name?: string
  game?: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `Mr.X.apz5` → `Mr.X`. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * The player of a mod named `AP-<seed>-P<n>-<rest>`: `<rest>` without the `_<version>` and the
 * extension Factorio and KH1 add (worlds/factorio/Mod.py:114-115), nor the `-<ddMonYYYY-HHMMSS>` of
 * KH2 (worlds/kh2/OpenKH.py:84-85). `Goat8-17Oct2026-174651_0.6.8.zip` → `Goat8`.
 */
function modOwner(rest: string): string {
  return stemOf(rest)
    .replace(/_\d+(?:\.\d+)+$/, '')
    .replace(/-\d{2}[A-Za-z]{3}\d{4}-\d{6}$/, '')
}

/**
 * The slots of a spoiler header (BaseClasses.py:1869-1892): `Player <n>: <name>` then `Game: <game>`
 * for each player of a multiworld; a single player has only its `Game:` line.
 */
function parseSpoilerHeader(text: string): Map<number, SpoilerSlot> {
  const slots = new Map<number, SpoilerSlot>()
  let players: number | null = null
  let current: number | null = null
  let games = 0
  for (const line of text.split(/\r?\n/)) {
    const count = /^Players:\s+(\d+)\s*$/.exec(line)
    if (count && players === null) {
      players = Number(count[1])
      continue
    }
    const player = /^Player (\d+): (.*)$/.exec(line)
    if (player) {
      current = Number(player[1])
      slots.set(current, { ...slots.get(current), name: player[2] ?? '' })
      continue
    }
    const game = /^Game:\s+(.*?)\s*$/.exec(line)
    const slot = current ?? (players === 1 ? 1 : null)
    if (!game || slot === null || slots.get(slot)?.game !== undefined) continue
    slots.set(slot, { ...slots.get(slot), game: game[1] ?? '' })
    // The header is over: the rest of a spoiler can be megabytes of placements.
    if (++games === players) break
  }
  return slots
}

async function readSpoilerSlots(zipPath: string, spoilerName: string): Promise<Map<number, SpoilerSlot>> {
  try {
    const text = await readZipText(zipPath, spoilerName, SPOILER_MAX_BYTES)
    return text === null ? new Map() : parseSpoilerHeader(text)
  } catch {
    // Too big to read whole: the file names still give the slots.
    return new Map()
  }
}

/** The file a client opens (one with a patch route) before any other file of the slot. */
const patchOf = (entries: readonly string[]): string | null =>
  entries.find((entry) => routeForFile(entry) !== null) ?? entries[0] ?? null

async function inspectGenerationZip(zipPath: string): Promise<ZipContents> {
  const names = (await listZip(zipPath, ZIP_LIMITS))
    .filter((entry) => !entry.isDir && !entry.name.includes('/'))
    .map((entry) => entry.name)
    .sort()
  const multidata = names.find((name) => /^AP_.+\.archipelago$/.test(name))
  if (multidata === undefined) {
    throw new AppError('GENERATION_FAILED', undefined, { detail: `no .archipelago in ${zipPath}` })
  }
  const base = multidata.slice(0, -'.archipelago'.length)
  const seedName = base.slice('AP_'.length)
  const spoiler = `${base}_Spoiler.txt`
  const spoilerName = names.includes(spoiler) ? spoiler : null
  // AP_<seed>_P<n>_<file-safe name, spaces as _>.<ext> (BaseClasses.py:407-409), or the mod a world
  // names itself AP-<seed>-P<n>-<file-safe name>… (Factorio, Kingdom Hearts 1 and 2).
  const slotFile = new RegExp(`^${escapeRegExp(base)}_P(\\d+)_(.+)$`)
  const modFile = new RegExp(`^AP-${escapeRegExp(seedName)}-P(\\d+)-(.+)$`)
  const files = new Map<number, { safeName: string; entries: string[] }>()
  for (const name of names) {
    const own = slotFile.exec(name)
    const mod = own ? null : modFile.exec(name)
    const found = own ?? mod
    if (!found) continue
    const slot = Number(found[1])
    const known = files.get(slot)
    if (known) known.entries.push(name)
    else
      files.set(slot, { safeName: own ? stemOf(found[2] ?? '') : modOwner(found[2] ?? ''), entries: [name] })
  }
  const header =
    spoilerName === null ? new Map<number, SpoilerSlot>() : await readSpoilerSlots(zipPath, spoilerName)
  const numbers = [...new Set([...header.keys(), ...files.keys()])].sort((a, b) => a - b)
  const slots = numbers.map((slot) => ({
    slot,
    name: header.get(slot)?.name ?? files.get(slot)?.safeName ?? '',
    game: header.get(slot)?.game ?? '',
    patchFile: patchOf(files.get(slot)?.entries ?? []),
  }))
  return { seedName, spoilerName, slots, files }
}

/**
 * What a generation's zip holds, read without extracting it: the seed, the spoiler's name, and the
 * slots from the spoiler header and the `AP_<seed>_P<n>_<name>.<ext>` files. `patchFile` is the
 * name of the slot's file in the zip; a name or game nothing gives is ''.
 */
export async function readGenerationZip(
  zipPath: string,
): Promise<{ seedName: string; slots: Slot[]; spoilerName: string | null }> {
  const { seedName, slots, spoilerName } = await inspectGenerationZip(zipPath)
  return { seedName, slots, spoilerName }
}

/**
 * Extracts each slot's files to `<slotsDir>/P<n>_<name>/`, the folder of the previous generation
 * gone first, and returns the slots with the absolute path of their patch file.
 */
async function extractSlots(zipPath: string, contents: ZipContents, slotsDir: string): Promise<Slot[]> {
  await rm(slotsDir, { recursive: true, force: true, maxRetries: 3 })
  const slots: Slot[] = []
  for (const slot of contents.slots) {
    const files = contents.files.get(slot.slot)
    if (!files || slot.patchFile === null) {
      slots.push(slot)
      continue
    }
    // Windows drops the trailing dots and spaces of a folder name.
    const folder = path.join(slotsDir, `P${slot.slot}_${files.safeName}`.replace(/[. ]+$/, ''))
    const wanted = new Set(files.entries)
    await extractZipSafe(zipPath, folder, { limits: ZIP_LIMITS, filter: (name) => wanted.has(name) })
    slots.push({ ...slot, patchFile: safeJoin(folder, slot.patchFile) })
  }
  return slots
}

// --- the run -------------------------------------------------------------------------------------

/** True when a server child of this run is registered for the session (children.json). */
function serverRunsFor(dataRoot: string, sessionId: string): boolean {
  const own = new Set(listChildren().map((child) => child.pid))
  return readChildren(childrenFile(dataRoot)).some(
    (entry) => entry.sessionId === sessionId && entry.exe === AP_EXES.server && own.has(entry.pid),
  )
}

/** What blocks the generation: error issues, ROMs not ready, or no player at all. */
function blockingCount(validation: SessionValidation): number {
  const docs = validation.files.flatMap((file) => file.docs)
  const issues = [...docs.flatMap((doc) => doc.issues), ...validation.sessionIssues]
  return (
    issues.filter((issue) => issue.severity === 'error').length +
    validation.romNeeds.filter((need) => need.status !== 'ok').length +
    (docs.length === 0 ? 1 : 0)
  )
}

/** `{ 'lttp_options.rom_file': <abs path> }` for each ROM the vault resolved. */
function romPathsOf(needs: readonly RomNeed[]): Record<string, string> {
  return Object.fromEntries(
    needs.flatMap((need) =>
      need.status === 'ok' && need.path !== null ? [[need.settingsKey, need.path]] : [],
    ),
  )
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Local time, `YYYYMMDD-HHmmss`, as the backups. */
function timestamp(d: Date): string {
  const date = `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

interface LineLog {
  path: string
  write(line: string): void
  close(): Promise<void>
}

/** A new `generate-<YYYYMMDD-HHmmss>[-n].txt` in `dir`, owner-only. */
async function openLog(dir: string, at: Date): Promise<LineLog> {
  const stem = `generate-${timestamp(at)}`
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? `${stem}.txt` : `${stem}-${n}.txt`)
    let handle: FileHandle
    try {
      handle = await open(file, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    const stream = handle.createWriteStream({ encoding: 'utf8' })
    // A full disk loses the log, not the generation.
    stream.on('error', () => undefined)
    return {
      path: file,
      write: (line) => void stream.write(`${line}\n`),
      close: async () => {
        stream.end()
        await finished(stream).catch(() => undefined)
      },
    }
  }
}

interface ProcessRun {
  exit: ApExit
  /** From `Creating final archive at <path>`; null when the line never came. */
  zipPath: string | null
  stdout: string[]
  stderr: string[]
  durationS: number
}

interface ProcessOptions {
  exe: ExeRef
  args: string[]
  cwd: string
  sessionId: string
  task: TaskHandle
  mask: (line: string) => string
  log: LineLog
  stallMs: number
}

function spawnFailure(error: unknown): AppError {
  const detail = String(error)
  // The program is gone (an install removed in the meantime).
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return new AppError('AP_NOT_INSTALLED', undefined, { detail, cause: error })
  }
  return new AppError('GENERATION_FAILED', undefined, { detail, cause: error })
}

/** Runs ArchipelagoGenerate to its exit; a cancelled task kills it. */
async function runProcess(ctx: CoreContext, o: ProcessOptions): Promise<ProcessRun> {
  const { task } = o
  const kept: Record<ApStream, string[]> = { stdout: [], stderr: [] }
  let progress: GenProgress = { stage: 'init', percent: 0 }
  let fill: { done: number; total: number } | null = null
  let stalled = false
  let zipPath: string | null = null
  let timer: NodeJS.Timeout | undefined

  const report = (): void => {
    const detail = { ...fill, ...(stalled ? { stalled: 1 } : {}) }
    if (Object.keys(detail).length > 0) task.progress(progress.stage, progress.percent, detail)
    else task.progress(progress.stage, progress.percent)
  }
  const watch = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      ctx.log.warn('generate: no new line from Archipelago', { sessionId: o.sessionId, ms: o.stallMs })
      report()
    }, o.stallMs)
  }
  const onLine = (stream: ApStream, raw: string): void => {
    const line = o.mask(raw)
    o.log.write(line)
    task.log(stream, truncate(line, MAX_LIVE_LINE))
    if (kept[stream].push(line) > KEPT_LINES) kept[stream].shift()
    zipPath ??= FINAL_ARCHIVE_RE.exec(raw)?.groups?.path ?? null
    const next = reduceProgress(progress, raw)
    const step = next.stage === 'fill' ? fillStep(raw) : null
    const changed = next !== progress || step !== null || stalled
    if (next.stage !== progress.stage) fill = null
    if (step) fill = step
    progress = next
    stalled = false
    if (changed) report()
    watch()
  }

  report()
  const started = performance.now()
  const proc = spawnAp(ctx, {
    exe: o.exe,
    args: o.args,
    cwd: o.cwd,
    // Generate waits for Enter after any failure (brief §1.6).
    stdin: 'ignore',
    sessionId: o.sessionId,
    onLine,
  })
  watch()
  const kill = (): void => proc.kill()
  task.signal.addEventListener('abort', kill, { once: true })
  if (task.signal.aborted) proc.kill()
  try {
    const exit = await proc.exited
    const durationS = Math.round(performance.now() - started) / 1000
    return { exit, zipPath, stdout: kept.stdout, stderr: kept.stderr, durationS }
  } catch (error) {
    throw spawnFailure(error)
  } finally {
    clearTimeout(timer)
    task.signal.removeEventListener('abort', kill)
  }
}

/** Removes what appeared in `dir` since `before` was listed: the partial output of a stopped run. */
async function removeNewEntries(dir: string, before: ReadonlySet<string>): Promise<void> {
  const now = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    now
      .filter((name) => !before.has(name))
      .map((name) => rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 })),
  )
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

/** The session hosts a game: a room or a local game (a stopped one too), or the save of its seed. */
async function hostsAGame(
  session: { hosting: unknown; generation: Generation | null },
  output: string,
): Promise<boolean> {
  if (session.hosting !== null) return true
  const seed = session.generation?.seedName
  return seed !== undefined && (await exists(path.join(output, `${seed}.apsave`)))
}

/**
 * Generates session `sessionId` (spec §3.8) and stores the result as its generation. Throws
 * GENERATION_PREFLIGHT `{ reason: 'hosting' }` while a local server of the session runs, then
 * `{ reason: 'game-in-progress' }` for a session that hosts a game (an archipelago.gg room, a local
 * game or its save) unless `opts.replace`, AP_NOT_INSTALLED, GENERATION_PREFLIGHT `{ errors }` when
 * the validation blocks, and WORLD_CORRUPT_BLOCKING `{ file }` for a world Archipelago would stop on:
 * nothing runs then. A failed run throws the error Archipelago printed (with the log's `logPath`), a
 * cancelled one TASK_CANCELLED once its partial output is gone. A replaced game stays where it is
 * (the room on the site, the save on disk); the session no longer points to it.
 */
export async function runGeneration(
  ctx: CoreContext,
  deps: GenerateDeps,
  sessionId: string,
  task: TaskHandle,
  opts: GenerateOptions = {},
): Promise<Generation> {
  const { signal } = task
  throwIfCancelled(signal)
  const session = await deps.sessions.get(sessionId)
  const isServing = deps.isServing ?? ((id: string) => serverRunsFor(ctx.platform.paths.dataRoot, id))
  if (isServing(sessionId)) throw new AppError('GENERATION_PREFLIGHT', { reason: 'hosting' })
  const ws = workspacePaths(ctx.platform.paths.dataRoot, sessionId)
  if (opts.replace !== true && (await hostsAGame(session, ws.output))) {
    throw new AppError('GENERATION_PREFLIGHT', { reason: 'game-in-progress' })
  }
  const install = await deps.locator.detect()
  if (!install) throw new AppError('AP_NOT_INSTALLED')
  const validation = await deps.sessions.validateSession(sessionId)
  if (validation.blocking) throw new AppError('GENERATION_PREFLIGHT', { errors: blockingCount(validation) })
  const corruptWorld =
    deps.corruptWorld ??
    ((at: ApInstall) =>
      findCorruptWorld(at.paths, disabledWorldsDir(ctx.platform.paths.dataRoot), at.version))
  const corrupt = await corruptWorld(install)
  // Archipelago would stop while it loads its worlds, whichever games the players picked.
  if (corrupt !== null) throw new AppError('WORLD_CORRUPT_BLOCKING', { file: corrupt })
  throwIfCancelled(signal)

  const secrets = await deps.sessions.getSecrets(sessionId)
  const entries = buildSessionSettingsEntries(session.rules, secrets, romPathsOf(validation.romNeeds))
  await writeSessionHostYaml(deps.settings, ws.dir, entries, ctx.platform.os)
  await mkdir(ws.output, { recursive: true })
  await mkdir(ws.logs, { recursive: true })
  const before = new Set(await readdir(ws.output))
  const known = [secrets.password, secrets.serverPassword].filter((s): s is string => !!s)
  const log = await openLog(ws.logs, new Date())
  let run: ProcessRun
  try {
    throwIfCancelled(signal)
    run = await runProcess(ctx, {
      exe: deps.locator.exe(install, AP_EXES.generate),
      args: buildGenerateArgs(ws, session.rules),
      cwd: ws.dir,
      sessionId,
      task,
      mask: (line) => redact(line, known),
      log,
      stallMs: deps.stallMs ?? STALL_MS,
    })
  } finally {
    await log.close()
  }

  if (signal.aborted) {
    await removeNewEntries(ws.output, before)
    throw new AppError('TASK_CANCELLED')
  }
  if (run.exit.code !== 0 || run.zipPath === null) {
    const { code, params, detail } = extractGenerationError(run.stderr, run.stdout)
    throw new AppError(code, params, { ...(detail === undefined ? {} : { detail }), logPath: log.path })
  }

  // A server serving the previous seed keeps its patches and its generation. (It cannot start through
  // the app while the session generates; this covers any other way.)
  if (isServing(sessionId)) {
    throw new AppError('GENERATION_PREFLIGHT', { reason: 'hosting' }, { logPath: log.path })
  }
  const zipPath = path.resolve(ws.dir, run.zipPath)
  let generation: Generation
  try {
    const contents = await inspectGenerationZip(zipPath)
    generation = {
      seedName: contents.seedName,
      zipPath,
      spoilerName: contents.spoilerName,
      slots: await extractSlots(zipPath, contents, path.join(ws.output, SLOTS_DIR)),
      durationS: run.durationS,
      logPath: log.path,
    }
  } catch (error) {
    const detail = error instanceof AppError ? (error.detail ?? error.message) : String(error)
    throw new AppError('GENERATION_FAILED', undefined, { detail, logPath: log.path, cause: error })
  }
  const stored = await deps.sessions.setGeneration(sessionId, generation)
  // The hosting was the old seed's.
  if (stored.hosting !== null) await deps.sessions.setHosting(sessionId, null)
  return generation
}

export function createGenerator(ctx: CoreContext, deps: GenerateDeps): Generator {
  const queues = new Map<string, Promise<unknown>>()
  /** The generations asked for and not over yet, by session. */
  const active = new Map<string, number>()

  /** Counts a generation of session `id` until the returned function is called. */
  function hold(id: string): () => void {
    active.set(id, (active.get(id) ?? 0) + 1)
    return () => {
      const left = (active.get(id) ?? 1) - 1
      if (left > 0) active.set(id, left)
      else active.delete(id)
    }
  }

  /** Runs `fn` once the previous generation of the session has settled (its cleanup included). */
  function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => undefined)
    queues.set(id, tail)
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id)
    })
    return run
  }

  return {
    generate(sessionId, opts = {}) {
      return startTracked(
        ctx.tasks,
        ctx.bus,
        'generate',
        (task) => exclusive(sessionId, () => runGeneration(ctx, deps, sessionId, task, opts)),
        hold(sessionId),
      )
    },

    isGenerating: (id) => active.has(id),
  }
}
