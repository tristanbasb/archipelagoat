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
  programName,
  readChildren,
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
const verified = new Map<number, { ctx: CoreContext; exe: string; procRoot: string }>()

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
      verified.set(entry.pid, { ctx, exe: entry.exe, procRoot })
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

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    process.kill(pid, 'SIGKILL')
    return
  }
  try {
    process.kill(-pid, 'SIGKILL') // a detached server leads its own group
  } catch {
    process.kill(pid, 'SIGKILL')
  }
}

/**
 * Kills an orphan that findOrphans reported, after checking again that its pid still runs the same
 * program. True when the orphan no longer runs (killed, or already gone); false for a pid findOrphans
 * did not report, or that cannot be checked or killed.
 */
export async function killOrphan(pid: number): Promise<boolean> {
  const known = verified.get(pid)
  if (known === undefined) return false
  const { ctx, exe, procRoot } = known
  const state = await probe(ctx, { pid, exe }, procRoot)
  if (state === 'unknown') return false
  verified.delete(pid)
  if (state === 'match') {
    try {
      killTree(pid)
    } catch (error) {
      ctx.log.warn('cannot kill an orphan ap process', { pid, exe, error: String(error) })
      return false
    }
    ctx.log.info('killed an orphan ap process', { pid, exe })
  }
  updateChildren(childrenFile(ctx.platform.paths.dataRoot), ctx.log, (entries) =>
    entries.filter((e) => e.pid !== pid),
  )
  return true
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
