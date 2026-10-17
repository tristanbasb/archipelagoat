// Hosting a session on archipelago.gg and following its room (spec §3.14): upload the generation's
// zip, open ONE room (/new_room is not idempotent), wake it, wait for its port; then read it, wake
// it again (its port can change), send console commands, read its log, and open it as its owner in
// the browser. The session keeps its room (`session.hosting`) from the moment the room exists, and
// hosting it again reuses that room for the same generation: only an explicit `newRoom` (or a new
// generation) uploads the seed and opens another one. One hosting task per session at a time.
import { setTimeout as delay } from 'node:timers/promises'
import { AppError } from '@shared/errors'
import type { Hosting, TaskRef, WebRoom, WebRoomRef } from '@shared/types'
import type { ServerManager } from '../ap/server'
import type { CoreContext } from '../context'
import type { SessionStore } from '../sessions/store'
import { redact } from '../system/redact'
import { startTracked, type TaskHandle } from '../tasks'
import {
  createWebhostClient,
  normalizeWebUrl,
  toIsoDate,
  type RoomStatus,
  type WebhostClient,
} from './client'
import { createCookieJar, type CookieJarStore } from './cookies'

type WebHosting = Extract<Hosting, { mode: 'web' }>

/** Waits `ms`; rejects with TASK_CANCELLED as soon as `signal` fires. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const PORT_POLL_FIRST_MS = 1000
const PORT_POLL_MAX_MS = 5000
const PORT_WAIT_MS = 60_000
/** Between the identity page and the room in the browser, which must keep the cookie first. */
const OWNER_DELAY_MS = 2000
/** A log line without its end for that long is shown as it is. */
const MAX_PARTIAL_LOG = 64 * 1024

const realSleep: Sleep = async (ms, signal) => {
  try {
    await delay(ms, undefined, signal ? { signal } : {})
  } catch (cause) {
    throw new AppError('TASK_CANCELLED', undefined, { cause })
  }
}

/** What the live screen shows of a room: absolute links, the site's host, no port before a start. */
export function toWebRoom(roomId: string, seedId: string, status: RoomStatus, base: string): WebRoom {
  return {
    roomId,
    seedId,
    roomUrl: normalizeWebUrl(base, `/room/${roomId}`),
    // room_status has no host field: the room runs on the site's own host.
    host: new URL(base).hostname,
    port: status.lastPort > 0 ? status.lastPort : null,
    lastActivity: toIsoDate(status.lastActivity),
    timeoutS: status.timeoutS,
    players: status.players.map(({ name, game }) => ({ name, game })),
    downloads: status.downloads.map(({ slot, download }) => ({ slot, url: normalizeWebUrl(base, download) })),
    trackerUrl: status.tracker ? normalizeWebUrl(base, `/tracker/${status.tracker}`) : null,
  }
}

export interface WaitForPortOptions {
  signal?: AbortSignal
  sleep?: Sleep
  now?: () => number
  /** Called before each wait, with the time spent so far. */
  onWait?: (elapsedMs: number) => void
}

/**
 * Polls room_status until the room has a port: backoff from 1 s doubling up to 5 s, 60 s in all.
 * `last_port: -1` (or no port in time) is WEBHOST_ROOM_FAILED. A failed read (WEBHOST_UNAVAILABLE)
 * is tried again within the same 60 s: room_status is a plain GET.
 */
export async function waitForPort(
  client: WebhostClient,
  roomId: string,
  opts: WaitForPortOptions = {},
): Promise<RoomStatus> {
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const started = now()
  let wait = PORT_POLL_FIRST_MS
  for (;;) {
    const { status, error } = await client.roomStatus(roomId, opts.signal).then(
      (answer) => ({ status: answer, error: null }),
      (failure: unknown) => {
        if (!(failure instanceof AppError) || failure.code !== 'WEBHOST_UNAVAILABLE') throw failure
        return { status: null, error: failure }
      },
    )
    if (status?.lastPort === -1) {
      throw new AppError('WEBHOST_ROOM_FAILED', undefined, { detail: 'last_port -1' })
    }
    if (status && status.lastPort > 0) return status
    const elapsed = now() - started
    if (elapsed >= PORT_WAIT_MS) {
      // The site still unreachable at the end says so; otherwise the room never got a port.
      throw error ?? new AppError('WEBHOST_ROOM_FAILED', undefined, { detail: 'no port after 60 s' })
    }
    opts.onWait?.(elapsed)
    await sleep(Math.min(wait, PORT_WAIT_MS - elapsed), opts.signal)
    wait = Math.min(wait * 2, PORT_POLL_MAX_MS)
  }
}

export interface HostOnWebDeps {
  sessions: Pick<SessionStore, 'get' | 'setHosting'>
  /** The local servers (Task 16): a session whose server runs keeps it as its hosting. */
  servers: Pick<ServerManager, 'isBusy'>
  client: WebhostClient
  /** Replaces the real waits (tests). */
  sleep?: Sleep
  now?: () => number
}

export interface HostOnWebOptions {
  /** Uploads the seed again and opens another room, even when the session has one for its seed. */
  newRoom?: boolean
}

/**
 * The `webhost-host` task (after the consent of the dialog): stages upload, room, wake, port.
 * AP_RUNNING `{ reason: 'local-server' }` before anything while a local server of the session runs.
 * A session that already has a room for its generation gets that room woken up and read again
 * (stages wake, port): /new_room is not idempotent, and a second room would orphan the first one,
 * its players included. `opts.newRoom` asks for a new room anyway.
 */
export async function hostOnWeb(
  ctx: Pick<CoreContext, 'log'>,
  deps: HostOnWebDeps,
  sessionId: string,
  task: TaskHandle,
  opts: HostOnWebOptions = {},
): Promise<WebRoom> {
  const { sessions, client } = deps
  if (deps.servers.isBusy(sessionId)) throw new AppError('AP_RUNNING', { reason: 'local-server' })
  const session = await sessions.get(sessionId)
  const { generation } = session
  if (!generation) throw new AppError('NOT_FOUND', undefined, { detail: 'no generation' })
  const existing = session.hosting
  const reuse =
    opts.newRoom !== true &&
    existing?.mode === 'web' &&
    (existing.seedName ?? generation.seedName) === generation.seedName
  let hosting: WebHosting
  if (reuse) {
    hosting = existing
    ctx.log.info('webhost: reusing the room of the session', { sessionId, roomId: hosting.roomId })
  } else {
    task.progress('upload', 5)
    const seedId = await client.uploadSeed(generation.zipPath, task.signal)
    ctx.log.info('webhost: seed uploaded', { sessionId, seedId })

    task.progress('room', 40)
    // Called once and never retried, nor cancelled halfway (the site could create a room nobody keeps).
    // The session keeps the room at once, so a later failure never loses it.
    if (task.signal.aborted) throw new AppError('TASK_CANCELLED')
    const roomId = await client.createRoom(seedId)
    hosting = {
      mode: 'web',
      seedId,
      roomId,
      roomUrl: normalizeWebUrl(client.baseUrl, `/room/${roomId}`),
      port: null,
      seedName: generation.seedName,
    }
    await sessions.setHosting(sessionId, hosting)
    ctx.log.info('webhost: room created', { sessionId, roomId })
  }
  const { roomId, seedId } = hosting

  task.progress('wake', 55)
  await client.wake(roomId, task.signal)

  task.progress('port', 65)
  const status = await waitForPort(client, roomId, {
    signal: task.signal,
    sleep: deps.sleep,
    now: deps.now,
    onWait: (elapsed) =>
      task.progress('port', 65 + Math.round((30 * Math.min(elapsed, PORT_WAIT_MS)) / PORT_WAIT_MS)),
  })
  const room = toWebRoom(roomId, seedId, status, client.baseUrl)
  await sessions.setHosting(sessionId, { ...hosting, port: room.port })
  return room
}

// --- the webhost service ----------------------------------------------------------------------------

export interface WebhostService {
  /**
   * Starts the `webhost-host` task; its result is the WebRoom. While one runs for the session, its
   * ref is answered again: a second call never uploads a second time.
   */
  host(sessionId: string, opts?: HostOnWebOptions): TaskRef
  room(roomId: string): Promise<WebRoom>
  /** Wakes the room, then reads its port again (it can change). */
  wake(roomId: string): Promise<WebRoom>
  command(roomId: string, command: string): Promise<void>
  readLog(roomId: string, fromByte: number): Promise<{ text: string; nextByte: number }>
  myRooms(): Promise<WebRoomRef[]>
  /** Gives the browser the app's identity (`/session/<uuid>`), then opens the room there. */
  openAsOwner(roomId: string): Promise<void>
}

export interface WebhostServiceDeps {
  /** Resolved on use. */
  sessions: () => Pick<SessionStore, 'list' | 'get' | 'setHosting' | 'getSecrets'>
  /** Resolved on use. */
  servers: () => Pick<ServerManager, 'isBusy'>
  sleep?: Sleep
  now?: () => number
  ownerDelayMs?: number
}

export function createWebhostService(ctx: CoreContext, deps: WebhostServiceDeps): WebhostService {
  let jar: CookieJarStore | null = null
  /** A client for the site of the current config (GOAT_WEBHOST_URL in the tests), one jar for all. */
  const client = (): WebhostClient =>
    createWebhostClient(ctx, {
      baseUrl: ctx.config.get().webhostUrl,
      jar: (jar ??= createCookieJar(ctx.secrets, ctx.log)),
    })
  const sleep = deps.sleep ?? realSleep
  /** The hosting task running for each session. */
  const hostings = new Map<string, TaskRef>()

  /** The session whose hosting is this room, if any. */
  async function hostOf(roomId: string): Promise<{ id: string; hosting: WebHosting } | null> {
    const sessions = deps.sessions()
    for (const summary of await sessions.list()) {
      if (summary.hostingMode !== 'web') continue
      const hosting = (await sessions.get(summary.id).catch(() => null))?.hosting
      if (hosting?.mode === 'web' && hosting.roomId === roomId) return { id: summary.id, hosting }
    }
    return null
  }

  /** The room with the seed of its session (none for a room no session knows); the session follows its port. */
  async function describe(web: WebhostClient, roomId: string, status: RoomStatus): Promise<WebRoom> {
    const owner = await hostOf(roomId)
    const room = toWebRoom(roomId, owner?.hosting.seedId ?? '', status, web.baseUrl)
    if (owner && room.port !== null && room.port !== owner.hosting.port) {
      await deps
        .sessions()
        .setHosting(owner.id, { ...owner.hosting, port: room.port })
        .catch((error: unknown) => ctx.log.warn('webhost: could not save the new port of a room', error))
    }
    return room
  }

  /**
   * The complete lines of a log chunk, masked: the passwords of the room's session, and what
   * Archipelago prints that holds one (a refused connection, `/options`). A line still being written
   * is read again next time, so that the per-line rules see it whole; one that never ends (more than
   * MAX_PARTIAL_LOG bytes) goes through as it is.
   */
  async function maskedLog(
    roomId: string,
    fromByte: number,
    chunk: { text: string; nextByte: number },
  ): Promise<{ text: string; nextByte: number }> {
    const lineEnd = chunk.text.lastIndexOf('\n') + 1
    const tooLong = lineEnd === 0 && chunk.nextByte - fromByte > MAX_PARTIAL_LOG
    const cut = tooLong ? chunk.text.length : lineEnd
    const text = chunk.text.slice(0, cut)
    const nextByte = cut === chunk.text.length ? chunk.nextByte : fromByte + Buffer.byteLength(text, 'utf8')
    if (text === '') return { text, nextByte }
    const owner = await hostOf(roomId).catch(() => null)
    const secrets = owner
      ? await deps
          .sessions()
          .getSecrets(owner.id)
          .catch(() => null)
      : null
    const known = [secrets?.password, secrets?.serverPassword].filter((s): s is string => !!s)
    return { text: redact(text, known), nextByte }
  }

  return {
    host(sessionId, opts = {}) {
      const running = hostings.get(sessionId)
      if (running) return running
      const ref = startTracked(
        ctx.tasks,
        ctx.bus,
        'webhost-host',
        (task) =>
          hostOnWeb(
            ctx,
            {
              sessions: deps.sessions(),
              servers: deps.servers(),
              client: client(),
              sleep: deps.sleep,
              now: deps.now,
            },
            sessionId,
            task,
            opts,
          ),
        () => {
          if (hostings.get(sessionId) === ref) hostings.delete(sessionId)
        },
      )
      hostings.set(sessionId, ref)
      return ref
    },

    async room(roomId) {
      const web = client()
      return describe(web, roomId, await web.roomStatus(roomId))
    },

    async wake(roomId) {
      const web = client()
      await web.wake(roomId)
      return describe(web, roomId, await waitForPort(web, roomId, { sleep, now: deps.now }))
    },

    command: (roomId, command) => client().sendCommand(roomId, command),

    readLog: async (roomId, fromByte) =>
      maskedLog(roomId, fromByte, await client().readLog(roomId, fromByte)),

    myRooms: () => client().myRooms(),

    async openAsOwner(roomId) {
      const web = client()
      const identityUrl = await web.ownerUrl(roomId)
      // The URL holds the identity, a credential: an error from the shell must not carry it along.
      await ctx.platform.openExternal(identityUrl).catch(() => {
        throw new AppError('AP_UNKNOWN', undefined, { detail: 'the browser could not be opened' })
      })
      await sleep(deps.ownerDelayMs ?? OWNER_DELAY_MS)
      await ctx.platform.openExternal(normalizeWebUrl(web.baseUrl, `/room/${roomId}`))
    },
  }
}
