// The join flow: resolve what the player gave, prepare it (a room answers its slots first, then the
// slot picked), and check the plan again after a fix. A new attempt drops the one under way.
import { useEffect, useRef, useState } from 'react'
import { toAppErrorData, type AppErrorData } from '@shared/errors'
import type { JoinPlan, JoinTarget } from '@shared/types'
import { useIpcMutation } from '../../hooks/useIpc'
import { invoke } from '../../lib/goat'
import { targetLabel, type RoomHistory } from './room-history'
import { useTaskOutcome } from './task-outcome'

export interface Job {
  /** What the player gave: a room link, an address or a patch path. */
  source: string
  target: JoinTarget
}

export type Stage =
  | { kind: 'idle' }
  | { kind: 'preparing'; taskId: string | null; slotName: string | null }
  | { kind: 'failed'; error: AppErrorData; slotName: string | null }

export interface JoinFlow {
  input: string
  setInput: (value: string) => void
  /** join:resolve refused the input. */
  entryError: AppErrorData | null
  resolving: boolean
  job: Job | null
  stage: Stage
  /** The first plan of a room: its slots. */
  roomPlan: JoinPlan | null
  /** The plan to play. */
  plan: JoinPlan | null
  start: (input: string) => Promise<void>
  chooseSlot: (name: string) => void
  retry: () => void
  changeSlot: () => void
  reset: () => void
  /** join:refresh; rejects with the error data. */
  recheck: () => Promise<void>
}

const cancelTask = (taskId: string): void => {
  void invoke('tasks:cancel', { taskId }).catch(() => undefined)
}

export function useJoinFlow(history: RoomHistory): JoinFlow {
  const wait = useTaskOutcome()
  const resolve = useIpcMutation('join:resolve')
  const prepare = useIpcMutation('join:prepare')
  const refresh = useIpcMutation('join:refresh')
  const [input, setInput] = useState('')
  const [entryError, setEntryError] = useState<AppErrorData | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'idle' })
  const [roomPlan, setRoomPlan] = useState<JoinPlan | null>(null)
  const [plan, setPlan] = useState<JoinPlan | null>(null)
  // Each attempt has a number: the late answers of an older one are ignored.
  const attempt = useRef(0)
  const alive = useRef(false)
  const runningTask = useRef<string | null>(null)

  // Leaving the screen stops the preparation under way.
  useEffect(() => {
    alive.current = true
    const tasks = runningTask
    return () => {
      alive.current = false
      if (tasks.current) cancelTask(tasks.current)
      tasks.current = null
    }
  }, [])

  const isCurrent = (id: number): boolean => alive.current && id === attempt.current

  /** Drops the attempt under way (its task is cancelled) and numbers a new one. */
  const nextAttempt = (): number => {
    if (runningTask.current) cancelTask(runningTask.current)
    runningTask.current = null
    return ++attempt.current
  }

  const prepareFor = async (id: number, current: Job, slotName: string | null): Promise<void> => {
    setStage({ kind: 'preparing', taskId: null, slotName })
    try {
      const { taskId } = await prepare.mutateAsync(
        slotName === null ? { target: current.target } : { target: current.target, slotName },
      )
      if (!isCurrent(id)) {
        cancelTask(taskId)
        return
      }
      runningTask.current = taskId
      setStage({ kind: 'preparing', taskId, slotName })
      const prepared = (await wait(taskId)) as JoinPlan
      if (!isCurrent(id)) return
      runningTask.current = null
      // A room answers its slots first: the player picks one, which is prepared in turn.
      if (current.target.kind === 'room' && prepared.slot === null) {
        setRoomPlan(prepared)
        setPlan(null)
      } else {
        setPlan(prepared)
      }
      setStage({ kind: 'idle' })
      history.remember({
        input: current.source,
        kind: current.target.kind,
        label: targetLabel(current.target),
        slot: prepared.slot?.name ?? prepared.connect.slot,
        game: prepared.slot?.game ?? prepared.manifest?.game ?? null,
      })
    } catch (error) {
      if (!isCurrent(id)) return
      runningTask.current = null
      setStage({ kind: 'failed', error: toAppErrorData(error), slotName })
    }
  }

  const start = async (raw: string): Promise<void> => {
    const source = raw.trim()
    if (!source) return
    const id = nextAttempt()
    setInput(source)
    setEntryError(null)
    setJob(null)
    setRoomPlan(null)
    setPlan(null)
    setStage({ kind: 'idle' })
    let target: JoinTarget
    try {
      target = await resolve.mutateAsync({ input: source })
    } catch (error) {
      if (isCurrent(id)) setEntryError(toAppErrorData(error))
      return
    }
    if (!isCurrent(id)) return
    const next = { source, target }
    setJob(next)
    await prepareFor(id, next, null)
  }

  return {
    input,
    setInput,
    entryError,
    resolving: resolve.isPending,
    job,
    stage,
    roomPlan,
    plan,
    start,
    chooseSlot: (name) => {
      if (job) void prepareFor(nextAttempt(), job, name)
    },
    retry: () => {
      if (job && stage.kind === 'failed') void prepareFor(nextAttempt(), job, stage.slotName)
    },
    changeSlot: () => {
      nextAttempt()
      setPlan(null)
      setStage({ kind: 'idle' })
    },
    reset: () => {
      nextAttempt()
      setJob(null)
      setRoomPlan(null)
      setPlan(null)
      setStage({ kind: 'idle' })
    },
    recheck: async () => {
      if (!plan) return
      const id = attempt.current
      const next = await refresh.mutateAsync({ planId: plan.planId })
      if (isCurrent(id)) setPlan(next)
    },
  }
}
