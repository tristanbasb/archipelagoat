// Pure helpers of the live game screen: the feed and console buffers, who is online, whether a room
// is awake, the room log stream and slot file paths. No React here.
import type { ServerEvent, ServerHistory, WebRoom } from '@shared/types'
import type { TerminalLine } from '../../design/components'

/** How many feed events and console lines the screen keeps (the main process keeps 500 of each). */
export const MAX_EVENTS = 1000
export const MAX_LINES = 1000

/** `list` then `items`, keeping the newest `max`. */
export function appendCapped<T>(list: readonly T[], items: readonly T[], max: number): T[] {
  const next = [...list, ...items]
  return next.length > max ? next.slice(next.length - max) : next
}

/** What the local server screen shows: the event feed and the console. */
export interface LiveFeed {
  events: ServerEvent[]
  lines: TerminalLine[]
}

export function feedFromHistory(history: ServerHistory): LiveFeed {
  return {
    events: history.events.slice(-MAX_EVENTS),
    lines: history.log.slice(-MAX_LINES).map((text) => ({ text })),
  }
}

export interface Presence {
  /** Players with at least one open connection. */
  online: ReadonlySet<string>
  /** Players who completed their goal. */
  goals: ReadonlySet<string>
  /** The whole team completed its games. */
  everyoneDone: boolean
}

/**
 * Who is online and who finished, replayed from the feed. A player can hold several connections (a
 * game client and a tracker), so connections are counted; a leave whose join fell out of the
 * history ring counts for nothing. A server that does not run (`running: false`) has nobody online,
 * but the goals reached stay.
 */
export function presence(
  events: readonly ServerEvent[],
  { running = true }: { running?: boolean } = {},
): Presence {
  const connections = new Map<string, number>()
  const goals = new Set<string>()
  let everyoneDone = false
  for (const event of events) {
    if (event.kind === 'all-goals') everyoneDone = true
    if (!event.player) continue
    const count = connections.get(event.player) ?? 0
    if (event.kind === 'join') connections.set(event.player, count + 1)
    else if (event.kind === 'leave') connections.set(event.player, Math.max(0, count - 1))
    else if (event.kind === 'goal') goals.add(event.player)
  }
  const online = new Set(
    running ? [...connections].filter(([, count]) => count > 0).map(([name]) => name) : [],
  )
  return { online, goals, everyoneDone }
}

/** What the host types in the console reaches everyone under this name (MultiServer.py:2342). */
export const SERVER_SPEAKER = '[Server]'

/** The message of a chat event, without the `Notice (all): <player>: ` the log line may start with. */
export function chatMessage(event: ServerEvent): string {
  const prefix = `${event.player ?? ''}: `
  const at = event.text.indexOf(prefix)
  return at >= 0 ? event.text.slice(at + prefix.length) : event.text
}

/**
 * Whether an archipelago.gg room runs. It has no port before its first start; it shuts down once
 * idle for `timeoutS` and keeps its last port until someone wakes it up (research brief §1.8).
 */
export function roomAwake(
  room: Pick<WebRoom, 'port' | 'lastActivity' | 'timeoutS'>,
  now: number = Date.now(),
): boolean {
  if (room.port === null) return false
  if (room.lastActivity === null || room.timeoutS === null) return true
  const last = Date.parse(room.lastActivity)
  return Number.isNaN(last) || last + room.timeoutS * 1000 > now
}

/** The log of an archipelago.gg room, read by byte ranges. */
export interface RoomLog {
  lines: TerminalLine[]
  /** The end of the log that has no line break yet. */
  partial: string
  /** Where the next read starts. */
  nextByte: number
}

export const EMPTY_ROOM_LOG: RoomLog = { lines: [], partial: '', nextByte: 0 }

export function appendLogChunk(log: RoomLog, chunk: { text: string; nextByte: number }): RoomLog {
  const parts = (log.partial + chunk.text).split(/\r?\n/)
  const partial = parts.pop() ?? ''
  return {
    lines: appendCapped(
      log.lines,
      parts.map((text) => ({ text })),
      MAX_LINES,
    ),
    partial,
    nextByte: chunk.nextByte,
  }
}

/** The lines to show, the unfinished one included. */
export function roomLogLines(log: RoomLog): TerminalLine[] {
  return log.partial ? [...log.lines, { text: log.partial }] : log.lines
}

function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
}

/** The folder of a slot's file (`workspace/output/slots/P<n>_<name>`), or null for a bare name. */
export function slotFolder(patchFile: string): string | null {
  const index = lastSeparator(patchFile)
  return index > 0 ? patchFile.slice(0, index) : null
}

export function fileName(path: string): string {
  return path.slice(lastSeparator(path) + 1)
}
