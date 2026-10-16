// In-process bus for the push events of the contract. src/main/index.ts relays every event to the
// renderer windows.
import type { EventName, EventPayloads } from '@shared/ipc/events'
import type { Logger } from './logger'

export interface EventBus {
  emit<E extends EventName>(name: E, payload: EventPayloads[E]): void
  /** Returns the unsubscribe function. */
  on<E extends EventName>(name: E, cb: (payload: EventPayloads[E]) => void): () => void
}

type AnyListener = (payload: unknown) => void

export function createEventBus(log?: Logger): EventBus {
  const listeners = new Map<EventName, Set<AnyListener>>()
  return {
    emit(name, payload) {
      // Copy first: a listener that subscribes during the emit waits for the next one.
      for (const cb of [...(listeners.get(name) ?? [])]) {
        try {
          cb(payload)
        } catch (error) {
          if (log) log.error(`event listener failed: ${name}`, error)
          else console.error(`event listener failed: ${name}`, error)
        }
      }
    },
    on(name, cb) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      const listener = cb as AnyListener
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
  }
}
