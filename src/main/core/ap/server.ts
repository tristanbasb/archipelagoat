// The local multiworld server of a session (spec §3.11, research brief §1.7). ArchipelagoServer runs in
// the session folder, whose host.yaml, rewritten before each start, gives it the rules and the
// passwords: they never appear on its command line, which any user of the machine can read. It is
// ready once websockets prints `server listening on`, or once its port answers; it is stopped with
// `/exit`, which saves the game, and killed only when that gets no answer within 15 s (a kill loses
// up to a minute of play). What it prints reaches the renderer masked (server:log), its joins, items
// and goals as events (server:event), both kept in rings of 500 for a screen that opens later
// (server:history). Servers that a crash of the app left running are found again at startup. A server
// never starts while its session generates, nor over its archipelago.gg room unless asked to.
//
// The app also connects to its ready servers (server-link.ts). A console command is followed by a
// connection that opens and closes: the two lines websockets logs about it flush what the command
// printed, which the frozen server would otherwise hold back until its next log line. And an item
// tracker logs in, whose ItemSend packets give each item event its class, the log line waiting for it
// at most 1.5 s. The lines about these connections stay out of the log and the events.
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
import {
  SERVER_CONNECTION_RE,
  SERVER_EVENT_PATTERNS,
  SERVER_HOSTING_RE,
  SERVER_PLAYER_NOTICE_RE,
  SERVER_READY_RE,
} from '@shared/data/log-patterns'
import { AppError, type AppErrorData } from '@shared/errors'
import type {
  ApInstall,
  Generation,
  ItemClass,
  RomNeed,
  Rules,
  ServerEvent,
  ServerHistory,
  ServerState,
} from '@shared/types'
import { disabledWorldsDir, findCorruptWorld } from '../worlds/inventory'
import type { Locator } from './locator'
import { spawnAp, type ApExit, type ApProcess, type SpawnApOptions } from './process'
import { findOrphans, stopOrphan, type Orphan, type OrphanStop } from './processes'
import {
  connectTracker,
  LINK_TAG,
  pokeServer,
  type ItemSend,
  type SocketFactory,
  type Tracker,
} from './server-link'
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
/**
 * How long after a console command the app makes the server log a line (see `schedulePoke`): long
 * enough for the server to run the command first, its console reading stdin every 50 ms
 * (MultiServer.py:2684-2685).
 */
const POKE_DELAY_MS = 250
/** How long an item event waits for the tracker to tell its class before it goes out without. */
const CLASSIFY_WAIT_MS = 1500
/**
 * The notices the server sends a client right after its join line (MultiServer.py:1060-1067): the
 * tutorial, and a warning for clients without compression.
 */
const JOIN_NOTICES: readonly string[] = [
  'Now that you are connected, ',
  'Warning: your client does not support compressed websocket connections!',
]
/** The end of the join and leave notices of the app's tracker: `Client(0.6.8), ['Tracker', 'ArchipelaGOAT'].` */
const OWN_TRACKER_RE = new RegExp(String.raw`, \[[^\]]*'${LINK_TAG}'[^\]]*\]\.\s*$`)
const ITEM_RE = SERVER_EVENT_PATTERNS.find((pattern) => pattern.kind === 'item')?.re

export interface ServerManagerDeps {
  sessions: Pick<SessionStore, 'get' | 'getSecrets' | 'setHosting' | 'setFinished'> & {
    resolveRomNeeds(games: readonly string[]): Promise<RomNeed[]>
  }
  settings: Pick<ApSettings, 'makeSessionSettings'>
  locator: Pick<Locator, 'detect' | 'exe'>
  /**
   * The servers a previous run left behind. Default: findOrphans / stopOrphan, which check the pid
   * still runs ArchipelagoServer; the tests inject theirs (their fakes run as node).
   */
  orphans?: { find(): Promise<Orphan[]>; stop(pid: number): Promise<OrphanStop> }
  /** True while a generation of the session runs (the generator service): a start is refused then. */
  isGenerating?: (sessionId: string) => boolean
  /**
   * The file name of a corrupt world of the install, on which the server would stop; null when there
   * is none. Default: a scan of its world folders (findCorruptWorld).
   */
  corruptWorld?: (install: ApInstall) => Promise<string | null>
  /** Default: spawnAp. */
  spawn?: (ctx: CoreContext, opts: SpawnApOptions) => ApProcess
  /** The app's own connections to its servers (server-link.ts). Default: WebSocket. */
  socket?: SocketFactory
  /** Default: the network interfaces of the machine. */
  networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  /** Default: fetchPublicIp(ctx.http). */
  publicIp?: () => Promise<string | null>
  /** The ports a server may take. Default: 38281 to 38381. */
  ports?: { start: number; max: number }
  /**
   * Defaults: ready 30 s, stop 15 s, probe every 500 ms, the line after a command 250 ms later, an item
   * waits 1.5 s for its class, the tracker tries again 1, 3 then 10 s after a lost connection.
   */
  timeouts?: {
    readyMs?: number
    stopMs?: number
    probeMs?: number
    pokeMs?: number
    classifyMs?: number
    trackerRetryMs?: readonly number[]
  }
  now?: () => Date
}

export interface StartOptions {
  /** Replaces the session's archipelago.gg room as its hosting (the room stays on the site). */
  replaceWeb?: boolean
}

export interface ServerManager {
  /**
   * Rewrites the session's host.yaml, then starts its server on a free port and resolves once it is
   * ready (the running server's state when there is one). INVALID_INPUT without a generation,
   * AP_NOT_INSTALLED, NOT_FOUND for a missing zip, WORLD_CORRUPT_BLOCKING for a world the server would
   * stop on, PORT_IN_USE, SERVER_START_FAILED (or the Archipelago error its output names), AP_RUNNING
   * while it stops or while an orphan of it runs, `{ reason: 'generating' }` while the session
   * generates, `{ reason: 'web-room' }` for a session hosted on archipelago.gg without `replaceWeb`.
   */
  start(sessionId: string, opts?: StartOptions): Promise<ServerState>
  /**
   * `/exit`, then a kill after 15 s (`error` PROCESS_TIMEOUT); `force` kills at once. Kills the orphan
   * of a previous run (AP_RUNNING when it cannot). Nothing to do for a server that does not run.
   */
  stop(sessionId: string, opts?: { force?: boolean }): Promise<void>
  /**
   * Writes one console line to a ready server, whose answer is then flushed out of its stdout.
   * NOT_FOUND when none is ready, INVALID_INPUT for a line break.
   */
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
 * Where ArchipelagoServer saves the game of `zipPath`: next to it, `AP_<seed>.zip` → `AP_<seed>.apsave`
 * (MultiServer.py:697-701). MultiServer 0.6.8 parses `--savefile` but never reads it, as the real run
 * showed (docs/verification/2026-10-16-real-run.md): this is the file, whatever the command line says.
 */
export function saveFileOf(zipPath: string): string {
  const { dir, name } = path.parse(zipPath)
  return path.join(dir, `${name}.apsave`)
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

/** Where the app's own connections reach a server, and as whom its tracker logs in. */
interface LinkInfo {
  url: string
  /** null without a slot to log in as. */
  slot: string | null
  password: string | null
  version: string | null
}

/** An event on its way out, `key` set while an item waits for its class. */
interface Outgoing {
  event: ServerEvent
  key: string | null
  timer: NodeJS.Timeout | undefined
}

interface Run {
  readonly id: string
  state: ServerState
  readonly history: ServerHistory
  /** The session's passwords, masked in every line. */
  readonly secrets: string[]
  /** null for an orphan, which is not ours. */
  readonly link: LinkInfo | null
  tracker: Tracker | null
  /**
   * The `connection open` and `connection closed` lines the app's own connections still owe: an opening
   * from the attempt on, a closing once the app ends the connection or the server printed the tracker's
   * leave. Never earlier: as long as the tracker is logged in, a player's closing is a player's.
   */
  ownConnections: { open: number; closed: number }
  /** The last line was the tracker's join: the notices the server sends it next follow. */
  afterTrackerJoin: boolean
  /** The server printed the tracker's join and not yet its leave. */
  trackerJoined: boolean
  /** The events in the order of their lines. */
  outbox: Outgoing[]
  /** Item classes that came before the line of their item. */
  early: { key: string; itemClass: ItemClass; at: number }[]
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

/** A state without the tracker, or with it logged in as `slot`. */
function withTracker(state: ServerState, slot: string | null): ServerState {
  const next = { ...state }
  delete next.tracker
  return slot === null ? next : { ...next, tracker: slot }
}

/**
 * What a send is matched on: its team (as the log numbers it), sender and receiver. A batch of sends is
 * logged and broadcast in the same order (MultiServer.py:1229-1251), so the sends of one key match in
 * turn.
 */
const sendKey = (team: number | string, sender: string, receiver: string): string =>
  `${team}\u0000${sender}\u0000${receiver}`

const toAppError = (data: AppErrorData): AppError =>
  new AppError(data.code, data.params, data.detail === undefined ? {} : { detail: data.detail })

export function createServerManager(ctx: CoreContext, deps: ServerManagerDeps): ServerManager {
  const spawn = deps.spawn ?? spawnAp
  const orphans = deps.orphans ?? { find: () => findOrphans(ctx), stop: (pid) => stopOrphan(pid) }
  const corruptWorld =
    deps.corruptWorld ??
    ((install: ApInstall) =>
      findCorruptWorld(install.paths, disabledWorldsDir(ctx.platform.paths.dataRoot), install.version))
  const interfaces = deps.networkInterfaces ?? networkInterfaces
  const publicIp = deps.publicIp ?? ((): Promise<string | null> => fetchPublicIp(ctx.http))
  const { start: firstPort, max: lastPort } = deps.ports ?? { start: DEFAULT_PORT, max: MAX_PORT }
  const readyMs = deps.timeouts?.readyMs ?? READY_TIMEOUT_MS
  const stopMs = deps.timeouts?.stopMs ?? STOP_TIMEOUT_MS
  const probeMs = deps.timeouts?.probeMs ?? PROBE_INTERVAL_MS
  const pokeMs = deps.timeouts?.pokeMs ?? POKE_DELAY_MS
  const classifyMs = deps.timeouts?.classifyMs ?? CLASSIFY_WAIT_MS
  const trackerRetryMs = deps.timeouts?.trackerRetryMs
  const now = deps.now ?? ((): Date => new Date())

  /** The last server of each session in this run of the app. */
  const runs = new Map<string, Run>()
  /** Starts still preparing or waiting for their server. */
  const starts = new Map<string, Promise<ServerState>>()
  /** The last port choice: the next one waits for it (see `launch`). */
  let portChoice: Promise<unknown> = Promise.resolve()
  let reconciling: Promise<void> = Promise.resolve()
  let closing = false

  function newRun(
    id: string,
    state: ServerState,
    secrets: string[],
    { orphanPid = null, link = null }: { orphanPid?: number | null; link?: LinkInfo | null } = {},
  ): Run {
    const ready = Promise.withResolvers<void>()
    // Only `start` waits for it, and a run of an orphan never gets ready.
    ready.promise.catch(() => undefined)
    return {
      id,
      state,
      history: { events: [], log: [] },
      secrets,
      link,
      tracker: null,
      ownConnections: { open: 0, closed: 0 },
      afterTrackerJoin: false,
      trackerJoined: false,
      outbox: [],
      early: [],
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
    startTracker(run)
  }

  // --- the app's own connections (server-link.ts) ---------------------------------------------------

  function expectOpening(run: Run): void {
    run.ownConnections.open++
  }

  function unexpectOpening(run: Run): void {
    run.ownConnections.open = Math.max(0, run.ownConnections.open - 1)
  }

  function expectClosing(run: Run): void {
    run.ownConnections.closed++
  }

  /**
   * Whether `line` is about the app's own connections: the `connection open` and `connection closed` they
   * owe (any such line will do, they are all alike), and the join and leave notices of the tracker with
   * the notices the server sends it right after its join. The tracker's leave comes before the closing of
   * its connection: websockets logs it once MultiServer's handler, which prints the leave, returned.
   */
  function isOwnLine(run: Run, line: string): boolean {
    const end = SERVER_CONNECTION_RE.exec(line)?.groups?.end
    if (end === 'open' || end === 'closed') {
      if (run.ownConnections[end] === 0) return false
      run.ownConnections[end]--
      return true
    }
    const notice = run.afterTrackerJoin ? SERVER_PLAYER_NOTICE_RE.exec(line) : null
    if (notice && notice.groups?.player === run.link?.slot) {
      const text = line.slice(notice.index + notice[0].length)
      if (JOIN_NOTICES.some((start) => text.startsWith(start))) return true
    }
    run.afterTrackerJoin = false
    if (!OWN_TRACKER_RE.test(line)) return false
    const kind = parseServerLine(line)?.kind
    if (kind === 'join') run.afterTrackerJoin = run.trackerJoined = true
    if (kind === 'leave') {
      run.trackerJoined = false
      expectClosing(run)
    }
    return kind === 'join' || kind === 'leave'
  }

  /**
   * After a console command: a connection that opens and closes makes the server log two lines, which
   * flush what the command printed (see server-link.ts).
   */
  function schedulePoke(run: Run): void {
    const timer = setTimeout(() => {
      if (!current(run) || run.state.status !== 'ready' || !run.link) return
      void pokeServer(run.link.url, {
        socket: deps.socket,
        onConnecting: () => expectOpening(run),
        onNeverOpened: () => unexpectOpening(run),
        onClosing: () => expectClosing(run),
      })
    }, pokeMs)
    timer.unref()
  }

  function startTracker(run: Run): void {
    const { link } = run
    if (!link || link.slot === null || run.tracker) return
    run.tracker = connectTracker({
      url: link.url,
      slot: link.slot,
      password: link.password,
      version: link.version,
      log: ctx.log,
      socket: deps.socket,
      retryDelaysMs: trackerRetryMs,
      onConnecting: () => expectOpening(run),
      onNeverOpened: () => unexpectOpening(run),
      // Once its join was printed, its leave owes the closing instead (isOwnLine).
      onClosing: () => {
        if (!run.trackerJoined) expectClosing(run)
      },
      onStatus: (connected) => onTrackerStatus(run, connected),
      onItem: (send) => onItem(run, send),
    })
  }

  /** Closes the tracker: the next state the run sends says so. */
  function closeTracker(run: Run): void {
    run.tracker?.close()
    run.tracker = null
    run.state = withTracker(run.state, null)
    settleAll(run)
  }

  function onTrackerStatus(run: Run, connected: boolean): void {
    if (!connected) settleAll(run)
    if (run.tracker === null || !isLive(run.state.status)) return
    const next = withTracker(run.state, connected ? (run.link?.slot ?? null) : null)
    if (next.tracker === run.state.tracker) return
    run.state = next
    if (current(run)) ctx.bus.emit('server:state', run.state)
  }

  // --- events, items waiting for their class --------------------------------------------------------

  /** Sends the events at the head of the outbox that wait for nothing more. */
  function flushOutbox(run: Run): void {
    for (let next = run.outbox[0]; next !== undefined && next.key === null; next = run.outbox[0]) {
      run.outbox.shift()
      push(run.history.events, next.event)
      if (current(run)) ctx.bus.emit('server:event', { sessionId: run.id, event: next.event })
    }
  }

  function settle(run: Run, entry: Outgoing, itemClass?: ItemClass): void {
    clearTimeout(entry.timer)
    if (itemClass !== undefined) entry.event = { ...entry.event, itemClass }
    entry.key = null
    flushOutbox(run)
  }

  /** Nothing more will tell a class: every event goes out. */
  function settleAll(run: Run): void {
    for (const entry of run.outbox) {
      clearTimeout(entry.timer)
      entry.key = null
    }
    run.early = []
    flushOutbox(run)
  }

  function pruneEarly(run: Run): void {
    const oldest = Date.now() - classifyMs
    run.early = run.early.filter((early) => early.at >= oldest)
  }

  /**
   * An event, in the order of its line. While the tracker is logged in, an item waits for its class:
   * the ItemSend packet comes on another connection, a little after (or before) the line.
   */
  function queueEvent(run: Run, event: ServerEvent, line: string): void {
    const entry: Outgoing = { event, key: null, timer: undefined }
    const team = event.kind === 'item' ? ITEM_RE?.exec(line)?.groups?.team : undefined
    if (team !== undefined && event.player && event.receiver && run.tracker?.connected === true) {
      const key = sendKey(team, event.player, event.receiver)
      pruneEarly(run)
      const at = run.early.findIndex((candidate) => candidate.key === key)
      const [early] = at >= 0 ? run.early.splice(at, 1) : []
      if (early) {
        entry.event = { ...event, itemClass: early.itemClass }
      } else {
        entry.key = key
        entry.timer = setTimeout(() => settle(run, entry), classifyMs)
        entry.timer.unref()
      }
    }
    run.outbox.push(entry)
    flushOutbox(run)
  }

  function onItem(run: Run, send: ItemSend): void {
    const key = sendKey(send.team, send.sender, send.receiver)
    const waiting = run.outbox.find((entry) => entry.key === key)
    if (waiting) return settle(run, waiting, send.itemClass)
    pruneEarly(run)
    run.early.push({ key, itemClass: send.itemClass, at: Date.now() })
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
    if (!current(run) || isOwnLine(run, line)) return
    const shown = redact(line, run.secrets)
    push(run.history.log, shown)
    ctx.bus.emit('server:log', { sessionId: run.id, line: shown })
    const event = parseServerLine(shown, now())
    if (event) queueEvent(run, event, shown)
    if (run.state.status !== 'starting') return
    run.linesSeen++
    if (SERVER_READY_RE.test(line)) return markReady(run)
    if (SERVER_HOSTING_RE.test(line)) run.hostingSeen = true
    armReadyTimer(run)
  }

  /**
   * The server is gone (stopped or crashed): its run says so at once, the session's game ends, and
   * only then does the state go out, so that a screen reading the session on it sees the game over.
   */
  async function ended(run: Run, patch: Pick<ServerState, 'status' | 'error'>): Promise<void> {
    run.state = withTracker({ ...run.state, ...patch }, null)
    try {
      await deps.sessions.setFinished(run.id)
    } catch (error) {
      ctx.log.warn('servers: cannot record the end of the game', { id: run.id, error: String(error) })
    }
    if (current(run)) ctx.bus.emit('server:state', run.state)
  }

  async function onExit(run: Run, exit: ApExit): Promise<void> {
    clearTimers(run)
    closeTracker(run)
    run.proc = null
    if (run.stopRequested) {
      const error: AppErrorData | null = run.killed
        ? { code: 'PROCESS_TIMEOUT', params: { command: SERVER } }
        : null
      await ended(run, { status: 'stopped', error })
      // A server stopped while it was starting: its start is cancelled.
      run.ready.reject(new AppError('TASK_CANCELLED', undefined, { detail: 'stopped while starting' }))
      return
    }
    if (run.state.status === 'starting') return fail(run, exitError(run, exit))
    if (run.state.status !== 'ready') return
    // auto_shutdown, or an /exit typed in the console, ends with 0.
    if (exit.code === 0) return ended(run, { status: 'stopped', error: null })
    // The error says the server had run: it crashed, it did not fail to start.
    const error = exitError(run, exit)
    return ended(run, {
      status: 'crashed',
      error: { ...error, params: { ...error.params, phase: 'running' } },
    })
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

  async function endOrphan(run: Run): Promise<void> {
    const pid = run.orphanPid
    if (pid === null) return
    const before = run.state
    setState(run, { status: 'stopping' })
    const result = await orphans.stop(pid)
    if (result === 'failed') {
      setState(run, { status: before.status, error: before.error })
      throw new AppError('AP_RUNNING', undefined, { detail: `the orphan server ${pid} could not be stopped` })
    }
    run.orphanPid = null
    // Killed without its save: the last minute of play may be lost, as for a server that ignores /exit.
    const error: AppErrorData | null =
      result === 'forced' ? { code: 'PROCESS_TIMEOUT', params: { command: SERVER } } : null
    await ended(run, { status: 'stopped', error })
  }

  function stop(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const run = runs.get(id)
    if (!run) return Promise.resolve()
    if (run.orphanPid !== null) {
      run.stopping ??= endOrphan(run).finally(() => {
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
    // Its leave notice comes before the server's last lines.
    closeTracker(run)
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

  async function launch(id: string, opts: StartOptions): Promise<ServerState> {
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
    // The session would forget its room (the app could no longer wake it, read its log or open it).
    if (session.hosting?.mode === 'web' && opts.replaceWeb !== true) {
      throw new AppError('AP_RUNNING', { reason: 'web-room' }, { detail: session.hosting.roomUrl })
    }
    const install = await deps.locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    if (!(await exists(generation.zipPath)))
      throw new AppError('NOT_FOUND', undefined, { detail: generation.zipPath })
    // MultiServer loads every world with the multidata: a corrupt one stops it.
    const corrupt = await corruptWorld(install)
    if (corrupt !== null) throw new AppError('WORLD_CORRUPT_BLOCKING', { file: corrupt })

    // The current rules and passwords, in the file the server loads (it runs in the session folder).
    const secrets = await deps.sessions.getSecrets(id)
    const entries = buildSessionSettingsEntries(rules, secrets, await romPaths(generation))
    await writeSessionHostYaml(deps.settings, workspace, entries, ctx.platform.os)
    const savefile = saveFileOf(generation.zipPath)
    const resumedFromSave = await exists(savefile)
    // The tracker logs in as the first slot: any slot will do, and the server counts it there.
    const trackerSlot = generation.slots.toSorted((a, b) => a.slot - b.slot)[0]?.name ?? null

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
        {
          link: {
            url: `ws://127.0.0.1:${port}`,
            slot: trackerSlot,
            password: secrets.password || null,
            version: install.version,
          },
        },
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
    start(id, opts = {}) {
      const pending = starts.get(id)
      if (pending) return pending
      const run = runs.get(id)
      if (run?.state.status === 'ready') return Promise.resolve(run.state)
      if (run?.state.status === 'stopping') {
        return Promise.reject(
          new AppError('AP_RUNNING', undefined, { detail: `the server of ${id} is stopping` }),
        )
      }
      // The generation would replace the seed (and its patches) under the server's feet.
      if (deps.isGenerating?.(id) === true) {
        return Promise.reject(new AppError('AP_RUNNING', { reason: 'generating' }))
      }
      const started = launch(id, opts).finally(() => starts.delete(id))
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
      schedulePoke(run)
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
          // It still serves its players: its addresses stay valid. `phase: 'orphan'` picks its text.
          const state: ServerState = {
            sessionId,
            status: 'crashed',
            port: hosting.port,
            addresses: listAddresses(interfaces(), hosting.port),
            startedAt: now().toISOString(),
            resumedFromSave: false,
            error: { code: 'SERVER_START_FAILED', params: { orphanPid: pid, phase: 'orphan' } },
          }
          const run = newRun(sessionId, state, [], { orphanPid: pid })
          runs.set(sessionId, run)
          ctx.bus.emit('server:state', state)
        }
      })()
      return reconciling
    },
  }
}
