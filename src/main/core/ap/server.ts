// The local multiworld server of a session (spec §3.11, research brief §1.7). ArchipelagoServer runs in
// the session folder, whose host.yaml, rewritten before each start, gives it the rules and the
// passwords: they never appear on its command line, which any user of the machine can read. It is
// ready once websockets prints `server listening on`, or once its port answers; it is stopped with
// `/exit`, which saves the game, and killed only when that gets no answer within 15 s (a kill loses
// up to a minute of play). What it prints reaches the renderer masked (server:log), its joins, items
// and goals as events (server:event), both kept in rings of 500 for a screen that opens later
// (server:history). Servers that a crash of the app left running are found again at startup.
import { access } from 'node:fs/promises'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import path from 'node:path'
import type { CoreContext } from '@main/core/context'
import { buildSessionSettingsEntries } from '@main/core/sessions/rules'
import type { SessionStore } from '@main/core/sessions/store'
import { writeSessionHostYaml } from '@main/core/sessions/workspace'
import { fetchPublicIp, findFreePort, listAddresses, MAX_PORT, probePort } from '@main/core/system/net'
import { redact } from '@main/core/system/redact'
import { AP_EXES, DEFAULT_PORT } from '@shared/data/ap-constants'
import { matchApError } from '@shared/data/error-catalog'
import { SERVER_EVENT_PATTERNS, SERVER_HOSTING_RE, SERVER_READY_RE } from '@shared/data/log-patterns'
import { AppError, type AppErrorData } from '@shared/errors'
import type { Generation, RomNeed, Rules, ServerEvent, ServerHistory, ServerState } from '@shared/types'
import type { Locator } from './locator'
import { spawnAp, type ApExit, type ApProcess, type SpawnApOptions } from './process'
import { findOrphans, killOrphan, type Orphan } from './processes'
import type { ApSettings } from './settings'

/** The events and the lines the history keeps. */
const HISTORY_SIZE = 500
/** A start fails when the server shows no sign of life for that long before it is ready. */
const READY_TIMEOUT_MS = 30_000
/** How long `/exit` has to stop the server before it is killed (spec §3.11). */
const STOP_TIMEOUT_MS = 15_000
const PROBE_INTERVAL_MS = 500
/** The last lines an error is looked for in, and shown in its detail. */
const ERROR_LINES = 20
const SERVER = AP_EXES.server

export interface ServerManagerDeps {
  sessions: Pick<SessionStore, 'get' | 'getSecrets' | 'setHosting'> & {
    resolveRomNeeds(games: readonly string[]): Promise<RomNeed[]>
  }
  settings: Pick<ApSettings, 'makeSessionSettings'>
  locator: Pick<Locator, 'detect' | 'exe'>
  /**
   * The servers a previous run left behind. Default: findOrphans / killOrphan, which check the pid
   * still runs ArchipelagoServer; the tests inject theirs (their fakes run as node).
   */
  orphans?: { find(): Promise<Orphan[]>; kill(pid: number): Promise<boolean> }
  /** Default: spawnAp. */
  spawn?: (ctx: CoreContext, opts: SpawnApOptions) => ApProcess
  /** Default: the network interfaces of the machine. */
  networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  /** Default: fetchPublicIp(ctx.http). */
  publicIp?: () => Promise<string | null>
  /** The ports a server may take. Default: 38281 to 38381. */
  ports?: { start: number; max: number }
  /** Defaults: ready 30 s, stop 15 s, probe every 500 ms. */
  timeouts?: { readyMs?: number; stopMs?: number; probeMs?: number }
  now?: () => Date
}

export interface ServerManager {
  /**
   * Rewrites the session's host.yaml, then starts its server on a free port and resolves once it is
   * ready (the running server's state when there is one). INVALID_INPUT without a generation,
   * AP_NOT_INSTALLED, NOT_FOUND for a missing zip, PORT_IN_USE, SERVER_START_FAILED (or the Archipelago
   * error its output names), AP_RUNNING while it stops or while an orphan of it runs.
   */
  start(sessionId: string): Promise<ServerState>
  /**
   * `/exit`, then a kill after 15 s (`error` PROCESS_TIMEOUT); `force` kills at once. Kills the orphan
   * of a previous run (AP_RUNNING when it cannot). Nothing to do for a server that does not run.
   */
  stop(sessionId: string, opts?: { force?: boolean }): Promise<void>
  /** Writes one console line to a ready server. NOT_FOUND when none is, INVALID_INPUT for a line break. */
  command(sessionId: string, cmd: string): void
  /** The state of the session's server in this run of the app; null when it never had one. */
  get(sessionId: string): ServerState | null
  /** The last 500 events and lines of its current (or last) server. */
  history(sessionId: string): ServerHistory
  /** Stops every running server, all at once. No server starts afterwards. */
  disposeAll(): Promise<void>
  /** The sessions whose server runs (starting, ready or stopping). */
  running(): string[]
  /** True while the session's server starts, runs or stops, or an orphan of it runs. */
  isBusy(sessionId: string): boolean
  /** Marks crashed every local session whose server a previous run left running. Never rejects. */
  reconcile(): Promise<void>
}

/**
 * The command line of a server: the multidata, the port, the save file and every mode option with
 * its value, so that nothing depends on defaults. The passwords are left to the session's host.yaml.
 */
export function buildServerArgs(zipPath: string, port: number, savefile: string, rules: Rules): string[] {
  return [
    zipPath,
    '--port',
    String(port),
    '--savefile',
    savefile,
    '--release_mode',
    rules.releaseMode,
    '--collect_mode',
    rules.collectMode,
    '--remaining_mode',
    rules.remainingMode,
    '--countdown_mode',
    rules.countdownMode,
    '--hint_cost',
    String(rules.hintCost),
    '--location_check_points',
    String(rules.locationCheckPoints),
    '--auto_shutdown',
    String(rules.autoShutdown),
  ]
}

/** The event a server line stands for (SERVER_EVENT_PATTERNS), dated `at`; null for any other line. */
export function parseServerLine(line: string, at: Date = new Date()): ServerEvent | null {
  for (const { kind, re } of SERVER_EVENT_PATTERNS) {
    const groups = re.exec(line)?.groups
    if (!groups) continue
    const event: ServerEvent = { ts: at.toISOString(), kind, text: line }
    for (const field of ['player', 'receiver', 'item', 'location'] as const) {
      const value = groups[field]
      if (value !== undefined) event[field] = value
    }
    return event
  }
  return null
}

/**
 * One argument of a console command as MultiServer's `shlex.split` reads it back: double-quoted (with
 * `"` and `\` escaped) when it holds a space, a quote or a backslash, or is empty.
 */
export function quoteConsoleArg(s: string): string {
  if (s !== '' && !/[\s"'\\]/.test(s)) return s
  return `"${s.replace(/["\\]/g, '\\$&')}"`
}

interface Run {
  readonly id: string
  state: ServerState
  readonly history: ServerHistory
  /** The session's passwords, masked in every line. */
  readonly secrets: string[]
  /** null once the process is gone (and for an orphan, which is not ours). */
  proc: ApProcess | null
  /** Settles once the exit of the process was handled. */
  done: Promise<void>
  ready: PromiseWithResolvers<void>
  orphanPid: number | null
  /** Lines printed before the server was ready. */
  linesSeen: number
  hostingSeen: boolean
  stopRequested: boolean
  killed: boolean
  stopping: Promise<void> | null
  readyTimer: NodeJS.Timeout | undefined
  probeTimer: NodeJS.Timeout | undefined
}

const isLive = (status: ServerState['status']): boolean =>
  status === 'starting' || status === 'ready' || status === 'stopping'

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  )

function push<T>(ring: T[], item: T): void {
  if (ring.push(item) > HISTORY_SIZE) ring.shift()
}

/** True when `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const toAppError = (data: AppErrorData): AppError =>
  new AppError(data.code, data.params, data.detail === undefined ? {} : { detail: data.detail })

export function createServerManager(ctx: CoreContext, deps: ServerManagerDeps): ServerManager {
  const spawn = deps.spawn ?? spawnAp
  const orphans = deps.orphans ?? { find: () => findOrphans(ctx), kill: killOrphan }
  const interfaces = deps.networkInterfaces ?? networkInterfaces
  const publicIp = deps.publicIp ?? ((): Promise<string | null> => fetchPublicIp(ctx.http))
  const { start: firstPort, max: lastPort } = deps.ports ?? { start: DEFAULT_PORT, max: MAX_PORT }
  const readyMs = deps.timeouts?.readyMs ?? READY_TIMEOUT_MS
  const stopMs = deps.timeouts?.stopMs ?? STOP_TIMEOUT_MS
  const probeMs = deps.timeouts?.probeMs ?? PROBE_INTERVAL_MS
  const now = deps.now ?? ((): Date => new Date())

  /** The last server of each session in this run of the app. */
  const runs = new Map<string, Run>()
  /** Starts still preparing or waiting for their server. */
  const starts = new Map<string, Promise<ServerState>>()
  /** The last port choice: the next one waits for it (see `launch`). */
  let portChoice: Promise<unknown> = Promise.resolve()
  let reconciling: Promise<void> = Promise.resolve()
  let closing = false

  function newRun(id: string, state: ServerState, secrets: string[], orphanPid: number | null = null): Run {
    const ready = Promise.withResolvers<void>()
    // Only `start` waits for it, and a run of an orphan never gets ready.
    ready.promise.catch(() => undefined)
    return {
      id,
      state,
      history: { events: [], log: [] },
      secrets,
      proc: null,
      done: Promise.resolve(),
      ready,
      orphanPid,
      linesSeen: 0,
      hostingSeen: false,
      stopRequested: false,
      killed: false,
      stopping: null,
      readyTimer: undefined,
      probeTimer: undefined,
    }
  }

  const current = (run: Run): boolean => runs.get(run.id) === run

  /** The runs whose process runs: starting, ready or stopping. */
  const liveRuns = (): Run[] =>
    [...runs.values()].filter((run) => run.proc !== null && isLive(run.state.status))

  /**
   * The ports our servers hold, or will hold once they bind: those of the runs whose process runs,
   * whatever their state (one killed after a failed start may not have let go yet), and those of the
   * orphans of a previous run.
   */
  const reservedPorts = (): Set<number> =>
    new Set(
      [...runs.values()]
        .filter((run) => run.proc !== null || run.orphanPid !== null)
        .map((run) => run.state.port),
    )

  /** Runs `choice` once the port choices before it are done, whether they succeeded or not. */
  function choosePort<T>(choice: () => Promise<T>): Promise<T> {
    const chosen = portChoice.then(choice)
    portChoice = chosen.catch(() => undefined)
    return chosen
  }

  /** A new state for the run, sent to the renderer while it is the session's current one. */
  function setState(run: Run, patch: Partial<ServerState>): void {
    run.state = { ...run.state, ...patch }
    if (current(run)) ctx.bus.emit('server:state', run.state)
  }

  function clearTimers(run: Run): void {
    clearTimeout(run.readyTimer)
    clearTimeout(run.probeTimer)
  }

  /** The error of a server that exited by itself, from its last lines. */
  function exitError(run: Run, exit: ApExit): AppErrorData {
    const last = run.history.log.slice(-ERROR_LINES)
    const how = `exit code ${exit.code ?? 'none'}${exit.signal ? `, signal ${exit.signal}` : ''}`
    const detail = [how, ...last].join('\n')
    const known = matchApError(last.join('\n'))
    if (known?.code === 'AP_PORT_IN_USE')
      return { code: 'PORT_IN_USE', params: { port: run.state.port }, detail }
    // AP_UNKNOWN is any exception: the generic code of a server that failed says more.
    if (known && known.code !== 'AP_UNKNOWN') return { code: known.code, params: known.params, detail }
    return { code: 'SERVER_START_FAILED', detail }
  }

  /** A start that failed: the server is crashed and `start` rejects with `error`. */
  function fail(run: Run, error: AppErrorData): void {
    if (run.state.status !== 'starting') return
    clearTimers(run)
    setState(run, { status: 'crashed', error })
    run.ready.reject(toAppError(error))
  }

  function markReady(run: Run): void {
    if (run.state.status !== 'starting') return
    clearTimers(run)
    setState(run, { status: 'ready' })
    run.ready.resolve()
  }

  /** (Re)starts the countdown of a start: every line the server prints is a sign of life. */
  function armReadyTimer(run: Run): void {
    clearTimeout(run.readyTimer)
    run.readyTimer = setTimeout(() => {
      const detail = [`no sign of life within ${readyMs} ms`, ...run.history.log.slice(-ERROR_LINES)].join(
        '\n',
      )
      fail(run, { code: 'SERVER_START_FAILED', detail })
      run.proc?.kill()
    }, readyMs)
    run.readyTimer.unref()
  }

  /**
   * The fallback of the ready line: the port answers. While lines come, it is tried once the Hosting
   * line was printed (the bind follows it); when nothing came at all, stdout is held back
   * (block-buffered) and only the port can tell.
   */
  function scheduleProbe(run: Run): void {
    run.probeTimer = setTimeout(() => void probe(run), probeMs)
    run.probeTimer.unref()
  }

  async function probe(run: Run): Promise<void> {
    if (run.state.status !== 'starting') return
    if ((run.hostingSeen || run.linesSeen === 0) && (await probePort(run.state.port))) return markReady(run)
    if (run.state.status === 'starting') scheduleProbe(run)
  }

  function onLine(run: Run, line: string): void {
    if (!current(run)) return
    const shown = redact(line, run.secrets)
    push(run.history.log, shown)
    ctx.bus.emit('server:log', { sessionId: run.id, line: shown })
    const event = parseServerLine(shown, now())
    if (event) {
      push(run.history.events, event)
      ctx.bus.emit('server:event', { sessionId: run.id, event })
    }
    if (run.state.status !== 'starting') return
    run.linesSeen++
    if (SERVER_READY_RE.test(line)) return markReady(run)
    if (SERVER_HOSTING_RE.test(line)) run.hostingSeen = true
    armReadyTimer(run)
  }

  function onExit(run: Run, exit: ApExit): void {
    clearTimers(run)
    run.proc = null
    if (run.stopRequested) {
      const error: AppErrorData | null = run.killed
        ? { code: 'PROCESS_TIMEOUT', params: { command: SERVER } }
        : null
      setState(run, { status: 'stopped', error })
      // A server stopped while it was starting: its start is cancelled.
      run.ready.reject(new AppError('TASK_CANCELLED', undefined, { detail: 'stopped while starting' }))
      return
    }
    if (run.state.status === 'starting') return fail(run, exitError(run, exit))
    if (run.state.status !== 'ready') return
    // auto_shutdown, or an /exit typed in the console, ends with 0.
    setState(
      run,
      exit.code === 0
        ? { status: 'stopped', error: null }
        : { status: 'crashed', error: exitError(run, exit) },
    )
  }

  function kill(run: Run): void {
    if (!run.proc) return
    run.killed = true
    run.proc.kill()
  }

  async function shutDown(run: Run, force: boolean): Promise<void> {
    if (force) kill(run)
    else {
      run.proc?.write('/exit')
      if (!(await settlesWithin(run.done, stopMs))) kill(run)
    }
    await run.done
  }

  async function stopOrphan(run: Run): Promise<void> {
    const pid = run.orphanPid
    if (pid === null) return
    if (!(await orphans.kill(pid))) {
      throw new AppError('AP_RUNNING', undefined, { detail: `the orphan server ${pid} could not be stopped` })
    }
    run.orphanPid = null
    setState(run, { status: 'stopped', error: null })
  }

  function stop(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const run = runs.get(id)
    if (!run) return Promise.resolve()
    if (run.orphanPid !== null) {
      run.stopping ??= stopOrphan(run).finally(() => {
        run.stopping = null
      })
      return run.stopping
    }
    if (run.stopping) {
      if (opts.force === true) kill(run)
      return run.stopping
    }
    if (!run.proc || (run.state.status !== 'starting' && run.state.status !== 'ready'))
      return Promise.resolve()
    run.stopRequested = true
    clearTimers(run)
    setState(run, { status: 'stopping' })
    run.stopping = shutDown(run, opts.force === true)
    return run.stopping
  }

  /** The `rom_file` entries of the session host.yaml: the ROMs the vault resolved for its games. */
  async function romPaths(generation: Generation): Promise<Record<string, string>> {
    const games = [...new Set(generation.slots.map((slot) => slot.game))]
    try {
      const needs = await deps.sessions.resolveRomNeeds(games)
      return Object.fromEntries(
        needs.flatMap((need) => (need.status === 'ok' && need.path ? [[need.settingsKey, need.path]] : [])),
      )
    } catch (error) {
      // The server reads no ROM: the file is only kept like the generation wrote it.
      ctx.log.warn('servers: cannot resolve the ROMs of the session', { error: String(error) })
      return {}
    }
  }

  async function launch(id: string): Promise<ServerState> {
    await reconciling
    const orphanPid = runs.get(id)?.orphanPid ?? null
    if (orphanPid !== null) {
      throw new AppError('AP_RUNNING', undefined, {
        detail: `an orphan server (pid ${orphanPid}) runs for ${id}`,
      })
    }
    const session = await deps.sessions.get(id)
    const { generation, workspace, rules } = session
    if (!generation)
      throw new AppError('INVALID_INPUT', undefined, { detail: `session ${id} has no generation` })
    const install = await deps.locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    if (!(await exists(generation.zipPath)))
      throw new AppError('NOT_FOUND', undefined, { detail: generation.zipPath })

    // The current rules and passwords, in the file the server loads (it runs in the session folder).
    const secrets = await deps.sessions.getSecrets(id)
    const entries = buildSessionSettingsEntries(rules, secrets, await romPaths(generation))
    await writeSessionHostYaml(deps.settings, workspace, entries, ctx.platform.os)
    const savefile = path.join(workspace, 'output', `${generation.seedName}.apsave`)
    const resumedFromSave = await exists(savefile)

    /** Chooses a free port, then registers and spawns the run of the server, which reserves it. */
    const spawnOnFreePort = async (): Promise<Run> => {
      const port = await findFreePort(firstPort, lastPort, reservedPorts())
      if (closing) throw new AppError('TASK_CANCELLED', undefined, { detail: 'the app is quitting' })

      const run = newRun(
        id,
        {
          sessionId: id,
          status: 'starting',
          port,
          addresses: listAddresses(interfaces(), port),
          startedAt: now().toISOString(),
          resumedFromSave,
          error: null,
        },
        [secrets.password, secrets.serverPassword].filter((s): s is string => s !== null && s !== ''),
      )
      const opts: SpawnApOptions = {
        exe: deps.locator.exe(install, SERVER),
        args: buildServerArgs(generation.zipPath, port, savefile, rules),
        cwd: workspace,
        // Kept open: it is the console. MultiServer ignores its end, so closing it would stop nothing.
        stdin: 'pipe',
        selfManaged: true,
        // Its own process group under Linux, which a kill then takes as a whole.
        detached: ctx.platform.os === 'linux',
        sessionId: id,
        onLine: (_stream, line) => onLine(run, line),
      }
      runs.set(id, run)
      ctx.bus.emit('server:state', run.state)
      // A program that cannot start: spawnAp rejects `exited`, and spawn itself may throw.
      const cannotStart = (error: unknown): void => {
        run.proc = null
        fail(run, { code: 'AP_NOT_INSTALLED', detail: String(error) })
      }
      try {
        const proc = spawn(ctx, opts)
        run.proc = proc
        run.done = proc.exited.then((exit) => onExit(run, exit), cannotStart)
        armReadyTimer(run)
        scheduleProbe(run)
      } catch (error) {
        cannotStart(error)
      }
      return run
    }
    // A server binds seconds after its spawn (multidata, save, its own public IP lookup), and until
    // then the OS calls its port free. So one start at a time chooses, and its run, registered before
    // the next one chooses, reserves the port.
    const run = await choosePort(spawnOnFreePort)
    const { port } = run.state
    const address = publicIp().catch(() => null)

    await run.ready.promise
    try {
      await deps.sessions.setHosting(id, { mode: 'local', port, savefile })
    } catch (error) {
      ctx.log.warn('servers: cannot record the hosting of the session', { id, error: String(error) })
    }
    void address.then((host) => {
      if (host === null || !current(run) || run.state.status !== 'ready') return
      setState(run, { addresses: [...run.state.addresses, { kind: 'public', host, port }] })
    })
    return run.state
  }

  return {
    start(id) {
      const pending = starts.get(id)
      if (pending) return pending
      const run = runs.get(id)
      if (run?.state.status === 'ready') return Promise.resolve(run.state)
      if (run?.state.status === 'stopping') {
        return Promise.reject(
          new AppError('AP_RUNNING', undefined, { detail: `the server of ${id} is stopping` }),
        )
      }
      const started = launch(id).finally(() => starts.delete(id))
      starts.set(id, started)
      return started
    },

    stop,

    command(id, cmd) {
      const run = runs.get(id)
      if (!run?.proc || run.state.status !== 'ready') {
        throw new AppError('NOT_FOUND', undefined, { detail: `no server runs for ${id}` })
      }
      if (/[\r\n]/.test(cmd))
        throw new AppError('INVALID_INPUT', undefined, { detail: 'one line per command' })
      run.proc.write(cmd.trim())
    },

    get: (id) => runs.get(id)?.state ?? null,

    history(id) {
      const run = runs.get(id)
      return { events: [...(run?.history.events ?? [])], log: [...(run?.history.log ?? [])] }
    },

    async disposeAll() {
      closing = true
      await Promise.allSettled(liveRuns().map((run) => stop(run.id)))
    },

    running: () => liveRuns().map((run) => run.id),

    isBusy(id) {
      const run = runs.get(id)
      return starts.has(id) || (run !== undefined && (run.orphanPid !== null || isLive(run.state.status)))
    },

    reconcile() {
      reconciling = (async () => {
        let found: Orphan[]
        try {
          found = await orphans.find()
        } catch (error) {
          ctx.log.warn('servers: cannot look for orphan servers', { error: String(error) })
          return
        }
        for (const orphan of found) {
          const { pid, exe, sessionId } = orphan
          if (exe !== SERVER || sessionId === null || runs.has(sessionId)) continue
          const hosting = await deps.sessions.get(sessionId).then(
            (session) => session.hosting,
            () => null,
          )
          if (hosting?.mode !== 'local') {
            ctx.log.warn('servers: an orphan server of no locally hosted session is left alone', orphan)
            continue
          }
          ctx.log.warn('servers: an orphan server still runs', orphan)
          const state: ServerState = {
            sessionId,
            status: 'crashed',
            port: hosting.port,
            addresses: [],
            startedAt: now().toISOString(),
            resumedFromSave: false,
            error: { code: 'SERVER_START_FAILED', params: { orphanPid: pid } },
          }
          const run = newRun(sessionId, state, [], pid)
          runs.set(sessionId, run)
          ctx.bus.emit('server:state', state)
        }
      })()
      return reconciling
    },
  }
}
