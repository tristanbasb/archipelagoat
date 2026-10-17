// The only renderer module that touches `window.goat` (the preload bridge). Screens go through the
// hooks (useIpcQuery, useIpcMutation, useTask, useEvent), which go through here.
import type { InvokeArgs } from '@shared/goat-api'
import type { ChannelInput, ChannelName, ChannelOutput } from '@shared/ipc/contract'
import type { EventName, EventPayloads } from '@shared/ipc/events'

/**
 * Calls a channel. Rejects with the plain GoatError-shaped object of the preload: read its `code`,
 * `params`, `detail` and `logPath` (or use `isGoatError`), never `instanceof Error`.
 */
export function invoke<C extends ChannelName>(channel: C, input: ChannelInput<C>): Promise<ChannelOutput<C>> {
  return window.goat.invoke(channel, ...([input] as InvokeArgs<C>))
}

/** Subscribes to a main-process event; returns the unsubscribe function. */
export function subscribe<E extends EventName>(
  event: E,
  cb: (payload: EventPayloads[E]) => void,
): () => void {
  return window.goat.on(event, cb)
}

/** Absolute path of a dropped file ('' when it has none). */
export function pathForFile(file: File): string {
  return window.goat.pathForFile(file)
}

/**
 * A subscription shared by every user: `start` runs for the first one, its stop function after the
 * last one leaves. `retain()` returns the release function (calling it twice is harmless).
 */
export function sharedSubscription(start: () => () => void): () => () => void {
  let users = 0
  let stop: (() => void) | null = null
  return () => {
    if (users++ === 0) stop = start()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--users === 0) {
        stop?.()
        stop = null
      }
    }
  }
}
