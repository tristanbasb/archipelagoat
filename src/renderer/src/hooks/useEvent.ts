import { useEffect, useEffectEvent } from 'react'
import type { EventName, EventPayloads } from '@shared/ipc/events'
import { subscribe } from '../lib/goat'

/** Listens to a main-process event while mounted; `cb` always sees the latest props and state. */
export function useEvent<E extends EventName>(name: E, cb: (payload: EventPayloads[E]) => void): void {
  const onEvent = useEffectEvent(cb)
  useEffect(() => subscribe(name, (payload) => onEvent(payload)), [name])
}
