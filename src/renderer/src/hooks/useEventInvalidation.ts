// The IPC queries a main-process event makes stale, refreshed in one place: the app shell calls
// useEventInvalidation once, for its whole life, so screens never subscribe for this themselves.
// (config:changed is the config store's job; the covers are the one thing it makes stale, below.)
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { ChannelName } from '@shared/ipc/contract'
import type { EventName } from '@shared/ipc/events'
import { useConfig } from '../stores/config'
import { useEvent } from './useEvent'

const EVENT_INVALIDATIONS = {
  // Archipelago installed or updated: another version, its worlds, what the health check finds,
  // the games the studio knows, and whether its settings point at BizHawk.
  'ap:installed': [
    'ap:detect',
    'ap:latestRelease',
    'worlds:list',
    'doctor:run',
    'studio:games',
    'bizhawk:state',
  ],
  // A world installed, removed, switched on or off, by the app or outside it.
  'worlds:changed': ['worlds:list', 'doctor:run', 'studio:games', 'catalog:list'],
  // The table of the sizes of the games changed (the datapackage was refreshed, a game was generated,
  // its profiles were measured).
  'checks:changed': ['checks:estimate', 'profiles:get'],
  // A generation read the exact checks of its players from its multidata before it ended; a measure
  // (which the check step may have been left during) wrote them.
  'task:done': ['checks:lastSession'],
  // A local server started, stopped or crashed: its game is live, or over (the main process records
  // that before it sends the state).
  'server:state': ['session:list', 'session:get'],
} as const satisfies Partial<Record<EventName, readonly ChannelName[]>>

/**
 * covers:get answers null for reasons that pass: the catalog it looks covers up in is not built yet
 * (only catalog:list builds it), or After Dark is hidden. Those answers are asked again when either
 * changes; the cache of a null answer also expires by itself (GameCover).
 */
function refreshCovers(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['covers:get'] })
}

export function useEventInvalidation(): void {
  const queryClient = useQueryClient()
  const { loaded, showAfterDark } = useConfig()
  const refresh = (channels: readonly ChannelName[]): void => {
    for (const name of channels) void queryClient.invalidateQueries({ queryKey: [name] })
  }
  useEvent('ap:installed', () => refresh(EVENT_INVALIDATIONS['ap:installed']))
  useEvent('worlds:changed', () => refresh(EVENT_INVALIDATIONS['worlds:changed']))
  useEvent('checks:changed', () => refresh(EVENT_INVALIDATIONS['checks:changed']))
  useEvent('task:done', ({ kind }) => {
    if (kind === 'generate' || kind === 'measure') refresh(EVENT_INVALIDATIONS['task:done'])
  })
  useEvent('server:state', () => refresh(EVENT_INVALIDATIONS['server:state']))

  // A catalog that resolves (fetched, or set after a refresh) may know covers it did not.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return
        const key = event.query.queryKey as readonly unknown[]
        if (key[0] === 'catalog:list') refreshCovers(queryClient)
      }),
    [queryClient],
  )

  // After Dark switched on or off changes which covers main serves (not the first value it loads).
  const shownAfterDark = useRef<boolean | null>(null)
  useEffect(() => {
    if (!loaded) return
    if (shownAfterDark.current !== null && shownAfterDark.current !== showAfterDark)
      refreshCovers(queryClient)
    shownAfterDark.current = showAfterDark
  }, [loaded, showAfterDark, queryClient])
}
