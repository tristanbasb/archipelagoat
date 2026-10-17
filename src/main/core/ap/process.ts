// The one way to run an Archipelago program (or the Node fakes that stand in for them in tests):
// explicit cwd and stdin policy, a cleaned environment, UTF-8 output split into lines, and a registry
// of the children the app stops on quit. The registry is also written to dataRoot/run/children.json,
// so that the next start finds what a crash left running (processes.ts).
import { spawn, type SpawnOptions } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CoreContext } from '@main/core/context'
import { readJsonSync, writeJsonAtomicSync } from '@main/core/json-file'
import type { Logger } from '@main/core/logger'
import { MASK } from '@main/core/system/redact'
import type { ExeRef } from '@shared/types'

export type ApWindow = 'hidden' | 'visible'
export type ApStream = 'stdout' | 'stderr'

export interface SpawnApOptions {
  exe: ExeRef
  args: string[]
  /** Always explicit: AP loads the settings file of its cwd first (spec §3.6). */
  cwd: string
  /** `ignore` for Generate: on any failure it waits for a line on stdin (brief §1.6). */
  stdin: 'ignore' | 'pipe'
  env?: Record<string, string>
  /** Default: `defaultWindowFor(<program>)`. */
  window?: ApWindow
  /**
   * Outlives the app. Alone it means fire and forget (a client): its output is not read, it is not
   * registered, and the app does not wait for it. With `selfManaged` (the server under Linux) it only
   * puts the process in its own process group, which `kill` then targets as a whole.
   */
  detached?: boolean
  /** Stopped by its owner (the server manager, with /exit), never by `disposeChildren`. */
  selfManaged?: boolean
  sessionId?: string
  onLine?: (stream: ApStream, line: string) => void
}

export interface ApExit {
  code: number | null
  signal: string | null
}

export interface ApProcess {
  /** 0 when the program could not start (`exited` then rejects with the spawn error). */
  pid: number
  /** Writes `line` and a line end to stdin; throws when stdin is not piped, ignored after the exit. */
  write(line: string): void
  /** Settles once the process is gone and its output has been read. */
  exited: Promise<ApExit>
  /** Forced (TerminateProcess, SIGKILL): ask a server to /exit first. */
  kill(): void
  /** The last `n` lines of stdout and stderr, in the order they came. */
  lastLines(n: number): string[]
}

/** An entry of dataRoot/run/children.json. */
export interface ChildEntry {
  pid: number
  /** The program, e.g. `ArchipelagoServer`. */
  exe: string
  sessionId: string | null
  startedAt: string
}

const KEPT_LINES = 500
/** How long `exited` waits for the output after the exit (a grandchild may hold the pipes). */
const OUTPUT_DRAIN_MS = 1000

/** Console programs: their window would only be an empty console. Clients are GUI apps. */
const CONSOLE_PROGRAMS = new Set(['ArchipelagoGenerate', 'ArchipelagoServer', 'ArchipelagoLauncherDebug'])

/**
 * The program of a path or argument: `ArchipelagoServer` for `C:\AP\ArchipelagoServer.exe`,
 * `--executable=ArchipelagoServer` or `tests/fake-ap/ArchipelagoServer.mjs`.
 */
export function programName(path: string): string {
  const parts = path.replace(/^--executable=/, '').split(/[\\/]/)
  return (parts.at(-1) ?? '').replace(/\.(?:exe|[cm]?js)$/i, '')
}

/** The program an ExeRef runs: an AppImage's `--executable=`, a script run by Node, or the command. */
export function exeNameOf(exe: ExeRef): string {
  const program =
    exe.argsPrefix.find((arg) => arg.startsWith('--executable=')) ??
    exe.argsPrefix.find((arg) => /\.[cm]?js$/i.test(arg)) ??
    exe.command
  return programName(program)
}

export function defaultWindowFor(exeName: string): ApWindow {
  return CONSOLE_PROGRAMS.has(programName(exeName)) ? 'hidden' : 'visible'
}

/** Sets `key`, dropping any other spelling of it first (Windows names ignore case). */
function setEnv(env: NodeJS.ProcessEnv, key: string, value: string): void {
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === key.toUpperCase()) delete env[existing]
  }
  env[key] = value
}

/**
 * The environment of an AP program: without the variables that would make its frozen Python load
 * another Python's files (and, when this app is an AppImage, its libraries), with unbuffered UTF-8
 * output. `base` is not modified.
 */
export function buildApEnv(base: NodeJS.ProcessEnv, isAppImage: boolean): NodeJS.ProcessEnv {
  const removed = new Set(['PYTHONHOME', 'PYTHONPATH', ...(isAppImage ? ['LD_LIBRARY_PATH'] : [])])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !removed.has(key.toUpperCase())) env[key] = value
  }
  setEnv(env, 'PYTHONUNBUFFERED', '1')
  setEnv(env, 'PYTHONIOENCODING', 'utf-8')
  return env
}

const isFireAndForget = (opts: SpawnApOptions): boolean => opts.detached === true && opts.selfManaged !== true

/** The options spawnAp gives to `spawn`. `baseEnv` defaults to this process's environment. */
export function apSpawnOptions(opts: SpawnApOptions, baseEnv: NodeJS.ProcessEnv = process.env): SpawnOptions {
  const env = buildApEnv(baseEnv, baseEnv.APPIMAGE !== undefined)
  for (const extra of [opts.exe.env, opts.env]) {
    for (const [key, value] of Object.entries(extra ?? {})) setEnv(env, key, value)
  }
  // A program that outlives the app must not write to pipes that close when the app quits.
  const output = isFireAndForget(opts) ? 'ignore' : 'pipe'
  return {
    cwd: opts.cwd,
    env,
    stdio: [opts.stdin, output, output],
    windowsHide: (opts.window ?? defaultWindowFor(exeNameOf(opts.exe))) === 'hidden',
    detached: opts.detached === true,
    shell: false,
  }
}

/** Splits a byte stream into lines: `\n` or `\r\n`, partial lines kept, UTF-8 cut between chunks. */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private partial = ''

  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines: string[] = []
    let start = 0
    // Only the new text is searched: a megabyte-long line (a FillError) arrives in many chunks.
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
      lines.push(withoutCr(this.partial + text.slice(start, end)))
      this.partial = ''
      start = end + 1
    }
    this.partial += text.slice(start)
    return lines
  }

  /** The last line when it has no line end (a prompt such as `Press enter to close.`). */
  flush(): string[] {
    const rest = this.partial + this.decoder.end()
    this.partial = ''
    return rest === '' ? [] : [withoutCr(rest)]
  }
}

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

// --- registry of the children -----------------------------------------------------------------

export const childrenFile = (dataRoot: string): string => join(dataRoot, 'run', 'children.json')

function isChildEntry(x: unknown): x is ChildEntry {
  if (typeof x !== 'object' || x === null) return false
  const { pid, exe, sessionId, startedAt } = x as Record<string, unknown>
  return (
    Number.isInteger(pid) &&
    typeof exe === 'string' &&
    (sessionId === null || typeof sessionId === 'string') &&
    typeof startedAt === 'string'
  )
}

/** The valid entries of the file; none when it is missing or unreadable. */
export function readChildren(file: string): ChildEntry[] {
  const data = readJsonSync(file)
  return Array.isArray(data) ? data.filter(isChildEntry) : []
}

/** Rewrites the file through `change`. Synchronous, so two changes never interleave. Never throws. */
export function updateChildren(
  file: string,
  log: Logger,
  change: (entries: ChildEntry[]) => ChildEntry[],
): void {
  try {
    writeJsonAtomicSync(file, change(readChildren(file)))
  } catch (error) {
    log.warn('cannot update the children registry', { file, error: String(error) })
  }
}

interface Child {
  entry: ChildEntry
  selfManaged: boolean
  proc: ApProcess
}

/** The registered children of this run, by pid. */
const children = new Map<number, Child>()

export function listChildren(): { pid: number; command: string }[] {
  return [...children.values()].map((child) => ({ pid: child.entry.pid, command: child.entry.exe }))
}

/** Kills the children still running, except the selfManaged ones, and waits up to `timeoutMs` for them. */
export async function disposeChildren(timeoutMs: number): Promise<void> {
  const targets = [...children.values()].filter((child) => !child.selfManaged)
  for (const child of targets) child.proc.kill()
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled(targets.map((child) => child.proc.exited)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
}

// --- spawning ---------------------------------------------------------------------------------

const SECRET_FLAG = /^--(?:server_)?password$/i
const SECRET_FLAG_VALUE = /^(--(?:server_)?password=).*$/is

/** The arguments as they may be logged: the value of a password flag masked. */
function loggableArgs(args: string[]): string[] {
  return args.map((arg, i) =>
    i > 0 && SECRET_FLAG.test(args[i - 1] ?? '') ? MASK : arg.replace(SECRET_FLAG_VALUE, `$1${MASK}`),
  )
}

export function spawnAp(ctx: CoreContext, opts: SpawnApOptions): ApProcess {
  const exe = exeNameOf(opts.exe)
  const child = spawn(opts.exe.command, [...opts.exe.argsPrefix, ...opts.args], apSpawnOptions(opts))
  const pid = child.pid ?? 0
  const kept: string[] = []
  // Set on exit: from then on the pid may belong to another process.
  let gone = pid === 0

  const emit = (stream: ApStream, line: string): void => {
    if (kept.push(line) > KEPT_LINES) kept.shift()
    if (!opts.onLine) return
    try {
      opts.onLine(stream, line)
    } catch (error) {
      ctx.log.error('ap process line handler failed', error)
    }
  }
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() }
  for (const stream of ['stdout', 'stderr'] as const) {
    child[stream]?.on('data', (chunk: Buffer) => {
      for (const line of splitters[stream].push(chunk)) emit(stream, line)
    })
  }
  // A write after the program closed its stdin fails with EPIPE: the exit says what happened.
  child.stdin?.on('error', (error) =>
    ctx.log.debug('ap process stdin closed', { exe, pid, error: String(error) }),
  )

  const file = childrenFile(ctx.platform.paths.dataRoot)
  const unregister = (): void => {
    if (children.get(pid)?.proc !== proc) return
    children.delete(pid)
    updateChildren(file, ctx.log, (entries) => entries.filter((e) => e.pid !== pid))
  }

  const exited = new Promise<ApExit>((resolve, reject) => {
    let drain: NodeJS.Timeout | undefined
    child.on('error', (error) => {
      if (pid === 0) reject(error)
      else ctx.log.warn('ap process error', { exe, pid, error: String(error) })
    })
    child.once('exit', () => {
      gone = true
      unregister()
      drain = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }, OUTPUT_DRAIN_MS)
      drain.unref()
    })
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(drain)
      if (pid === 0) return
      for (const stream of ['stdout', 'stderr'] as const) {
        for (const line of splitters[stream].flush()) emit(stream, line)
      }
      ctx.log.info('ap process exited', { exe, pid, code, signal })
      resolve({ code, signal })
    })
  })
  // A caller that never awaits `exited` must not cause an unhandled rejection.
  exited.catch(() => undefined)

  const proc: ApProcess = {
    pid,
    exited,
    write(line) {
      if (!child.stdin) throw new Error(`${exe}: stdin is not piped`)
      if (gone || !child.stdin.writable) return
      child.stdin.write(`${line}\n`, 'utf8')
    },
    kill() {
      if (gone) return
      try {
        // A detached process leads its own group under Linux: the group goes with it.
        if (opts.detached === true && process.platform !== 'win32') process.kill(-pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (error) {
        ctx.log.debug('ap process kill failed', { exe, pid, error: String(error) })
      }
    },
    lastLines: (n) => (n > 0 ? kept.slice(-n) : []),
  }

  if (pid === 0) return proc
  ctx.log.info('ap process started', {
    exe,
    pid,
    cwd: opts.cwd,
    args: loggableArgs(opts.args),
    sessionId: opts.sessionId ?? null,
  })
  if (isFireAndForget(opts)) {
    child.unref()
    return proc
  }
  const entry: ChildEntry = {
    pid,
    exe,
    sessionId: opts.sessionId ?? null,
    startedAt: new Date().toISOString(),
  }
  children.set(pid, { entry, selfManaged: opts.selfManaged === true, proc })
  updateChildren(file, ctx.log, (entries) => [...entries.filter((e) => e.pid !== pid), entry])
  return proc
}
