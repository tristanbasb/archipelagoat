// The IPC queries a main-process event makes stale, refreshed in one place: the app shell calls
// useEventInvalidation once, for its whole life, so screens never subscribe for this themselves.
// (config:changed is the config store's job.)
import { useQueryClient } from '@tanstack/react-query'
import type { ChannelName } from '@shared/ipc/contract'
import type { EventName } from '@shared/ipc/events'
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
  // A local server started, stopped or crashed: its game is live, or over (the main process records
  // that before it sends the state).
  'server:state': ['session:list', 'session:get'],
} as const satisfies Partial<Record<EventName, readonly ChannelName[]>>

export function useEventInvalidation(): void {
  const queryClient = useQueryClient()
  const refresh = (channels: readonly ChannelName[]): void => {
    for (const name of channels) void queryClient.invalidateQueries({ queryKey: [name] })
  }
  useEvent('ap:installed', () => refresh(EVENT_INVALIDATIONS['ap:installed']))
  useEvent('worlds:changed', () => refresh(EVENT_INVALIDATIONS['worlds:changed']))
  useEvent('server:state', () => refresh(EVENT_INVALIDATIONS['server:state']))
}
