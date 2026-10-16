// Type of `window.goat`, the only API the preload exposes to the renderer.
import type { ChannelInput, ChannelName, ChannelOutput } from './ipc/contract'
import type { EventName, EventPayloads } from './ipc/events'
import type { OS } from './types'

/** Channels that take no input can be invoked without one. */
export type InvokeArgs<C extends ChannelName> =
  undefined extends ChannelInput<C> ? [input?: ChannelInput<C>] : [input: ChannelInput<C>]

export interface GoatApi {
  /**
   * Calls a channel of the contract. Resolves with its output; rejects with a `GoatError` (see
   * `@shared/errors`): test it with `instanceof GoatError` or `isGoatError` and read its fields,
   * because across the context bridge the rejection is a plain object, not a real instance.
   */
  invoke<C extends ChannelName>(channel: C, ...args: InvokeArgs<C>): Promise<ChannelOutput<C>>
  /** Subscribes to a push event; returns the unsubscribe function. */
  on<E extends EventName>(event: E, cb: (payload: EventPayloads[E]) => void): () => void
  readonly os: OS
  /** Absolute path of a dropped or picked file (`webUtils.getPathForFile`); '' when it has none. */
  pathForFile(file: File): string
}

declare global {
  interface Window {
    goat: GoatApi
  }
}
