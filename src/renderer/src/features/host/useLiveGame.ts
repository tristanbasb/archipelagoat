// Live data of the screen. A local server: its state, feed and console, rebuilt from server:history
// on mount and then kept up to date by the server:* events. An archipelago.gg room: its state and
// its log, read every 5 s while the window is visible.
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { GoatError } from '@shared/errors'
import type { ServerState, WebRoom } from '@shared/types'
import type { TerminalLine } from '../../design/components'
import { useEvent } from '../../hooks/useEvent'
import { useIpcQuery } from '../../hooks/useIpc'
import { invoke } from '../../lib/goat'
import {
  appendCapped,
  appendLogChunk,
  EMPTY_ROOM_LOG,
  feedFromHistory,
  MAX_EVENTS,
  MAX_LINES,
  type LiveFeed,
  type RoomLog,
} from './live-state'

/** The room log is read this often, and only while the window is visible (spec §3.14). */
export const LOG_POLL_MS = 5_000

const EMPTY_FEED: LiveFeed = { events: [], lines: [] }

const feedKey = (sessionId: string): readonly unknown[] => ['host:feed', sessionId]
const roomLogKey = (roomId: string): readonly unknown[] => ['host:roomLog', roomId]

/**
 * Updates a live buffer. Before its first answer it stays empty: the main process sends events and
 * answers in order, so the history it answers with already holds every event sent before it. If
 * that first read failed, the live events still start a buffer.
 */
function updateBuffer<T>(
  queryClient: QueryClient,
  key: readonly unknown[],
  empty: T,
  update: (current: T) => T,
): void {
  queryClient.setQueryData<T>(key, (current) => {
    if (current !== undefined) return update(current)
    return queryClient.getQueryState(key)?.status === 'error' ? update(empty) : undefined
  })
}

export interface LocalServerLive {
  /** null: no server runs for this session. */
  server: UseQueryResult<ServerState | null, GoatError>
  feed: UseQueryResult<LiveFeed, GoatError>
  /** Adds a line of the app's own to the console (a command echo, a refusal). */
  print: (line: TerminalLine) => void
}

export function useLocalServer(sessionId: string): LocalServerLive {
  const queryClient = useQueryClient()
  // The events keep both up to date, so no refetch; and no cache once the screen is gone, since the
  // events missed meanwhile would make it wrong.
  const server = useIpcQuery('server:get', { sessionId }, { staleTime: Infinity, gcTime: 0 })
  const feed = useQuery<LiveFeed, GoatError>({
    queryKey: feedKey(sessionId),
    queryFn: async () => feedFromHistory(await invoke('server:history', { sessionId })),
    staleTime: Infinity,
    gcTime: 0,
  })

  const updateFeed = useCallback(
    (update: (current: LiveFeed) => LiveFeed) =>
      updateBuffer(queryClient, feedKey(sessionId), EMPTY_FEED, update),
    [queryClient, sessionId],
  )
  const print = useCallback(
    (line: TerminalLine) =>
      updateFeed((current) => ({ ...current, lines: appendCapped(current.lines, [line], MAX_LINES) })),
    [updateFeed],
  )

  useEvent('server:state', (state) => {
    if (state.sessionId === sessionId) queryClient.setQueryData(['server:get', { sessionId }], state)
  })
  useEvent('server:event', ({ sessionId: from, event }) => {
    if (from !== sessionId) return
    updateFeed((current) => ({ ...current, events: appendCapped(current.events, [event], MAX_EVENTS) }))
  })
  useEvent('server:log', ({ sessionId: from, line }) => {
    if (from === sessionId) print({ text: line })
  })

  return { server, feed, print }
}

export interface WebRoomLive {
  room: UseQueryResult<WebRoom, GoatError>
  log: UseQueryResult<RoomLog, GoatError>
  print: (line: TerminalLine) => void
}

export function useWebRoom(roomId: string): WebRoomLive {
  const queryClient = useQueryClient()
  const room = useIpcQuery('webhost:room', { roomId })
  const log = useQuery<RoomLog, GoatError>({
    queryKey: roomLogKey(roomId),
    queryFn: async () => {
      const fromByte = queryClient.getQueryData<RoomLog>(roomLogKey(roomId))?.nextByte ?? 0
      const chunk = await invoke('webhost:log', { roomId, fromByte })
      // Lines printed while the read was running are kept.
      return appendLogChunk(queryClient.getQueryData<RoomLog>(roomLogKey(roomId)) ?? EMPTY_ROOM_LOG, chunk)
    },
    // TanStack Query pauses the interval while the document is hidden (refetchIntervalInBackground).
    refetchInterval: LOG_POLL_MS,
    gcTime: 0,
  })

  const print = useCallback(
    (line: TerminalLine) =>
      updateBuffer(queryClient, roomLogKey(roomId), EMPTY_ROOM_LOG, (current) => ({
        ...current,
        lines: appendCapped(current.lines, [line], MAX_LINES),
      })),
    [queryClient, roomId],
  )

  return { room, log, print }
}
