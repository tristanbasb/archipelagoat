// The only list of push event names. It stays free of zod and of any runtime import: the sandboxed
// preload bundles it to refuse subscriptions to anything else.
export const EVENT_NAMES = [
  'task:progress',
  'task:log',
  'task:done',
  'task:failed',
  'server:state',
  'server:event',
  'server:log',
  'app:openRequest',
  'app:quitRequested',
  'config:changed',
  'worlds:changed',
  'ap:installed',
] as const

export type EventName = (typeof EVENT_NAMES)[number]
