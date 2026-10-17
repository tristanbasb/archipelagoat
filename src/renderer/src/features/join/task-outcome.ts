// Awaiting a task started by a channel that answered a TaskRef: its result once done, its error
// data if it failed. The waits of a component are dropped (they never settle) when it unmounts.
import { useCallback, useEffect, useRef } from 'react'
import { retainTaskEvents, useTasksStore, type TaskEntry } from '../../stores/tasks'

type Settle = (entry: TaskEntry | undefined) => boolean

/** Resolves with the result of `taskId`, rejects with its AppErrorData; `drop` stops waiting. */
function waitForTask(taskId: string): { promise: Promise<unknown>; drop: () => void } {
  let stop = (): void => undefined
  const promise = new Promise<unknown>((resolve, reject) => {
    const settle: Settle = (entry) => {
      if (entry?.status === 'done') resolve(entry.result)
      // Task errors are AppErrorData, the same shape as a rejected invoke.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      else if (entry?.status === 'failed') reject(entry.error)
      else return false
      return true
    }
    // The events of a task are kept from the moment someone holds them: hold them while waiting.
    const release = retainTaskEvents()
    let unsubscribe = (): void => undefined
    stop = () => {
      unsubscribe()
      release()
    }
    if (settle(useTasksStore.getState().tasks[taskId])) {
      stop()
      return
    }
    unsubscribe = useTasksStore.subscribe((state) => {
      if (settle(state.tasks[taskId])) stop()
    })
  })
  return { promise, drop: () => stop() }
}

/** `wait(taskId)`: the outcome of a task, for as long as the calling component is mounted. */
export function useTaskOutcome(): (taskId: string) => Promise<unknown> {
  const waits = useRef(new Set<() => void>())

  useEffect(() => {
    const pending = waits.current
    return () => {
      for (const drop of pending) drop()
      pending.clear()
    }
  }, [])

  return useCallback((taskId: string) => {
    const { promise, drop } = waitForTask(taskId)
    waits.current.add(drop)
    const forget = (): void => {
      waits.current.delete(drop)
    }
    promise.then(forget, forget)
    return promise
  }, [])
}
