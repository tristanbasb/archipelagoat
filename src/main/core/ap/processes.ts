// The Archipelago programs running on the machine (ours or not), and the orphans a previous run left
// behind: a crash or a forced quit skips the before-quit hooks, so the next start reads
// dataRoot/run/children.json again and checks each pid before anything is reported or killed.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreContext } from '@main/core/context'
import type { ExecFn } from '@main/core/exec'
import type { OS } from '@shared/types'
import {
  childrenFile,
  disposeChildren,
  listChildren,
  measureChildPids,
  programName,
  readChildren,
  sessionChildPids,
  updateChildren,
  type ChildEntry,
} from './process'

export interface ProcessInfo {
  pid: number
  name: string
}

export interface Orphan {
  pid: number
  exe: string
  sessionId: string | null
}

export interface FindOrphansOptions {
  /** Where `<pid>/cmdline` is read under Linux (tests). Default `/proc`. */
  procRoot?: string
}

const LIST_TIMEOUT_MS = 15_000
/** How long the before-quit hook waits for the killed children. */
const DISPOSE_TIMEOUT_MS = 5000
/** The orphan the server manager offers to stop (Task 16); any other orphan is killed at startup. */
const SERVER = 'ArchipelagoServer'

/**
 * Rows of `tasklist /FO CSV /NH`: `"<image>","<pid>","<session>","<#>","<memory>"`. Other lines (the
 * `INFO:` line of an empty answer, which Windows translates) are skipped.
 */
export function parseTasklistCsv(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? '').replaceAll('""', '"'))
    const [name, pid] = fields
    if (name !== undefined && pid !== undefined && /^\d+$/.test(pid)) rows.push({ pid: Number(pid), name })
  }
  return rows
}

/** Lines of `ps -eo pid=,comm=` (`comm` is cut to 15 characters by Linux). */
export function parsePsOutput(text: string): ProcessInfo[] {
  const rows: ProcessInfo[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) rows.push({ pid: Number(m[1]), name: m[2] })
  }
  return rows
}

// Case-sensitive on purpose: `ArchipelaGOAT` (this app) is not an Archipelago program.
const isArchipelago = (name: string): boolean => name.startsWith('Archipelago')

/**
 * `exec`, whose process listings (`tasklist`, `ps`) leave out every Archipelago program: for the test
 * environment, where Archipelago is faked or absent (GOAT_FAKE_AP_DIR), so that a real Archipelago the
 * machine runs neither locks the settings nor blocks an install of a test. The fakes run as `node`.
 */
export function withoutApProcesses(exec: ExecFn): ExecFn {
  return async (command, args, opts) => {
    const result = await exec(command, args, opts)
    if (command !== 'tasklist' && command !== 'ps') return result
    const keep = (line: string): boolean => {
      const [row] = command === 'tasklist' ? parseTasklistCsv(line) : parsePsOutput(line)
      return row === undefined || !isArchipelago(row.name)
    }
    return { ...result, stdout: result.stdout.split('\n').filter(keep).join('\n') }
  }
}

/** Every running program whose name starts with `Archipelago`. Throws when the listing fails. */
export async function listApProcesses(exec: ExecFn, os: OS): Promise<ProcessInfo[]> {
  const [command, args, parse] =
    os === 'win32'
      ? (['tasklist', ['/FO', 'CSV', '/NH'], parseTasklistCsv] as const)
      : (['ps', ['-eo', 'pid=,comm='], parsePsOutput] as const)
  const result = await exec(command, [...args], { timeoutMs: LIST_TIMEOUT_MS })
  if (result.code !== 0) {
    throw new Error(`${command} exited with code ${result.code}: ${result.stderr.trim()}`)
  }
  return parse(result.stdout).filter((p) => isArchipelago(p.name))
}

/** `match`: the pid still runs the recorded program. `gone`: it ended, or the pid was reused. */
type ProbeResult = 'match' | 'gone' | 'unknown'

/** Linux: the program is the executable, the script Node runs, or an AppImage's `--executable=`. */
function cmdlineRuns(argv: string[], exe: string): boolean {
  const [command = '', script = ''] = argv
  return (
    programName(command) === exe ||
    (/\.[cm]?js$/i.test(script) && programName(script) === exe) ||
    argv.includes(`--executable=${exe}`)
  )
}

async function probe(
  ctx: CoreContext,
  entry: Pick<ChildEntry, 'pid' | 'exe'>,
  procRoot: string,
): Promise<ProbeResult> {
  if (!isArchipelago(entry.exe)) return 'gone'
  if (ctx.platform.os === 'win32') {
    try {
      const args = ['/FI', `PID eq ${entry.pid}`, '/FO', 'CSV', '/NH']
      const result = await ctx.exec('tasklist', args, { timeoutMs: LIST_TIMEOUT_MS })
      if (result.code !== 0) return 'unknown'
      const row = parseTasklistCsv(result.stdout).find((p) => p.pid === entry.pid)
      return row !== undefined && programName(row.name) === entry.exe ? 'match' : 'gone'
    } catch {
      return 'unknown'
    }
  }
  try {
    const cmdline = await readFile(join(procRoot, String(entry.pid), 'cmdline'), 'utf8')
    return cmdlineRuns(cmdline.split('\0').filter(Boolean), entry.exe) ? 'match' : 'gone'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unknown'
  }
}

/** Orphans that findOrphans checked, with what killOrphan needs to check them again. */
const verified = new Map<
  number,
  { ctx: CoreContext; exe: string; procRoot: string; sessionId: string | null; scoped: boolean }
>()

const isOwnChild = (pid: number): boolean => listChildren().some((child) => child.pid === pid)

/**
 * The entries of children.json that still run their Archipelago program, children of this run
 * excepted. Dead or reused pids are purged from the file; a pid that cannot be checked stays there
 * without being reported.
 */
export async function findOrphans(ctx: CoreContext, opts: FindOrphansOptions = {}): Promise<Orphan[]> {
  const procRoot = opts.procRoot ?? '/proc'
  const file = childrenFile(ctx.platform.paths.dataRoot)
  const candidates = readChildren(file).filter((entry) => !isOwnChild(entry.pid))
  const results = await Promise.all(candidates.map((entry) => probe(ctx, entry, procRoot)))

  const orphans: Orphan[] = []
  const purged = new Set<number>()
  candidates.forEach((entry, i) => {
    if (results[i] === 'match') {
      orphans.push({ pid: entry.pid, exe: entry.exe, sessionId: entry.sessionId })
      verified.set(entry.pid, {
        ctx,
        exe: entry.exe,
        procRoot,
        sessionId: entry.sessionId,
        scoped: entry.scoped === true,
      })
    } else if (results[i] === 'gone') {
      purged.add(entry.pid)
      verified.delete(entry.pid)
    }
  })
  // Whatever was written meanwhile (a child spawned during the checks) is kept.
  if (purged.size > 0) {
    updateChildren(file, ctx.log, (entries) => entries.filter((e) => !purged.has(e.pid) || isOwnChild(e.pid)))
  }
  return orphans
}

/**
 * The pids of the app's own programs that run in a folder of their own: the children of this run that
 * belong to a session or a measure, and the orphans of a previous run that findOrphans found running
 * for one (a server under Linux). They load and save only that folder's host.yaml, never the file
 * Archipelago's other programs load (spec §3.6).
 */
export function sessionScopedPids(): Set<number> {
  const pids = new Set(sessionChildPids())
  for (const [pid, orphan] of verified) if (orphan.sessionId !== null || orphan.scoped) pids.add(pid)
  return pids
}

/**
 * The pids of the app's own test generations (a measure's, `scoped`): the children of this run, and
 * the orphans of a previous run that findOrphans found running for one. No program the user opened:
 * they never need a restart to see a world (Ruling 35).
 */
export function measurePids(): Set<number> {
  const pids = new Set(measureChildPids())
  for (const [pid, orphan] of verified) if (orphan.scoped) pids.add(pid)
  return pids
}

/**
 * The programs `list` finds running, the app's own test generations (`own`) left out: those of the
 * moment it starts and of the moment it ends, since a measure may end or start while it lists.
 */
export async function userApPrograms(
  list: () => Promise<ProcessInfo[]>,
  own: () => ReadonlySet<number> = measurePids,
): Promise<ProcessInfo[]> {
  const before = own()
  const running = await list()
  const after = own()
  return running.filter((program) => !before.has(program.pid) && !after.has(program.pid))
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    process.kill(pid, signal)
    return
  }
  try {
    process.kill(-pid, signal) // a detached server leads its own group
  } catch {
    process.kill(pid, signal)
  }
}

/** True once the orphan is gone, checked every `pollMs` for up to `ms`. */
async function goneWithin(
  ctx: CoreContext,
  entry: Pick<ChildEntry, 'pid' | 'exe'>,
  procRoot: string,
  ms: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if ((await probe(ctx, entry, procRoot)) === 'gone') return true
  }
  return false
}

/**
 * How an orphan ended: by itself (or it was already gone), killed, or not at all (a pid findOrphans
 * did not report, or that cannot be checked or signalled).
 */
export type OrphanStop = 'stopped' | 'forced' | 'failed'

const STOP_GRACE_MS = 15_000
const STOP_POLL_MS = 250

async function endOrphan(pid: number, graceMs: number | null, pollMs: number): Promise<OrphanStop> {
  const known = verified.get(pid)
  if (known === undefined) return 'failed'
  const { ctx, exe, procRoot } = known
  const entry = { pid, exe }
  const state = await probe(ctx, entry, procRoot)
  if (state === 'unknown') return 'failed'
  verified.delete(pid)
  let result: OrphanStop = 'stopped'
  if (state === 'match') {
    try {
      // MultiServer saves on SIGTERM under Linux (atexit, brief §1.7); Windows has no such signal.
      const graceful = graceMs !== null && process.platform !== 'win32'
      if (graceful) signalTree(pid, 'SIGTERM')
      if (!graceful || !(await goneWithin(ctx, entry, procRoot, graceMs, pollMs))) {
        signalTree(pid, 'SIGKILL')
        result = 'forced'
      }
    } catch (error) {
      ctx.log.warn('cannot stop an orphan ap process', { pid, exe, error: String(error) })
      return 'failed'
    }
    ctx.log.info(result === 'forced' ? 'killed an orphan ap process' : 'stopped an orphan ap process', {
      pid,
      exe,
    })
  }
  updateChildren(childrenFile(ctx.platform.paths.dataRoot), ctx.log, (entries) =>
    entries.filter((e) => e.pid !== pid),
  )
  return result
}

/**
 * Kills an orphan that findOrphans reported, after checking again that its pid still runs the same
 * program. True when the orphan no longer runs (killed, or already gone); false for a pid findOrphans
 * did not report, or that cannot be checked or killed.
 */
export async function killOrphan(pid: number): Promise<boolean> {
  return (await endOrphan(pid, null, STOP_POLL_MS)) !== 'failed'
}

/**
 * Stops an orphan server that findOrphans reported the way its own stop would (spec §3.11): under
 * Linux its process group gets SIGTERM, on which MultiServer saves the game, and SIGKILL only after
 * `graceMs` (15 s) without an exit; on Windows it is killed at once ('forced').
 */
export function stopOrphan(
  pid: number,
  opts: { graceMs?: number; pollMs?: number } = {},
): Promise<OrphanStop> {
  return endOrphan(pid, opts.graceMs ?? STOP_GRACE_MS, opts.pollMs ?? STOP_POLL_MS)
}

/** Kills the orphans other than servers: an interrupted generation, a template run… */
async function killStrayOrphans(ctx: CoreContext): Promise<void> {
  for (const orphan of await findOrphans(ctx)) {
    if (orphan.exe === SERVER) continue
    ctx.log.warn('killing an orphan ap process', orphan)
    await killOrphan(orphan.pid)
  }
}

export interface ProcessesService {
  /** The Archipelago programs running on the machine. */
  list(): Promise<ProcessInfo[]>
  /** Settles (never rejects) once the orphans of the previous run were handled. */
  readonly ready: Promise<void>
}

/** The `processes` service: children killed on quit (late phase), stray orphans killed at startup. */
export function createProcesses(ctx: CoreContext): ProcessesService {
  ctx.lifecycle.onBeforeQuit(() => disposeChildren(DISPOSE_TIMEOUT_MS), { phase: 'late' })
  const ready = killStrayOrphans(ctx).catch((error: unknown) => ctx.log.error('orphan cleanup failed', error))
  return {
    list: () => listApProcesses(ctx.exec, ctx.platform.os),
    ready,
  }
}
