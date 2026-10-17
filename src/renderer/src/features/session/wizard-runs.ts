// The tasks a wizard started for a session (its generation, its archipelago.gg hosting). They outlive
// the screen: leaving the wizard and coming back keeps following them instead of offering to start
// them again. A task the app's task list no longer knows (dropped long after it ended) is forgotten.
import { useCallback, useRef, useState, type SetStateAction } from 'react'
import { useTasksStore } from '../../stores/tasks'

/** A generation started from the wizard. */
export interface GenerationRun {
  taskId: string
  startedAt: number
  /** Its success was already celebrated: the confetti and the jingle play once. */
  celebrated: boolean
}

interface SessionRuns {
  generation: GenerationRun | null
  hostTaskId: string | null
}

export interface WizardRuns extends SessionRuns {
  setGeneration: (action: SetStateAction<GenerationRun | null>) => void
  setHostTaskId: (taskId: string | null) => void
}

const saved = new Map<string, SessionRuns>()

/** The session whose wizard started this task (its generation or its hosting); null when none did. */
export function sessionOfTask(taskId: string): string | null {
  for (const [sessionId, runs] of saved) {
    if (runs.generation?.taskId === taskId || runs.hostTaskId === taskId) return sessionId
  }
  return null
}

/** What the wizard of this session left running; a success that ended meanwhile is not celebrated. */
function restore(sessionId: string): SessionRuns {
  const { tasks } = useTasksStore.getState()
  const runs = saved.get(sessionId)
  const generation = runs?.generation ? tasks[runs.generation.taskId] : undefined
  const host = runs?.hostTaskId ? tasks[runs.hostTaskId] : undefined
  return {
    generation:
      runs?.generation && generation
        ? { ...runs.generation, celebrated: runs.generation.celebrated || generation.status !== 'running' }
        : null,
    hostTaskId: host ? (runs?.hostTaskId ?? null) : null,
  }
}

export function useWizardRuns(sessionId: string): WizardRuns {
  const [runs, setRuns] = useState(() => restore(sessionId))
  const latest = useRef(runs)

  const update = useCallback(
    (change: Partial<SessionRuns>) => {
      latest.current = { ...latest.current, ...change }
      saved.set(sessionId, latest.current)
      setRuns(latest.current)
    },
    [sessionId],
  )
  const setGeneration = useCallback(
    (action: SetStateAction<GenerationRun | null>) =>
      update({ generation: typeof action === 'function' ? action(latest.current.generation) : action }),
    [update],
  )
  const setHostTaskId = useCallback((taskId: string | null) => update({ hostTaskId: taskId }), [update])

  return { ...runs, setGeneration, setHostTaskId }
}
