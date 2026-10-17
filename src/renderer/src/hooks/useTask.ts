import { useEffect, useMemo } from 'react'
import type { AppErrorData } from '@shared/errors'
import type { TaskLog, TaskProgress } from '@shared/types'
import { retainTaskEvents, useTasksStore } from '../stores/tasks'

export interface TaskState {
  status: 'idle' | 'running' | 'done' | 'failed'
  progress: TaskProgress | null
  logs: TaskLog[]
  result: unknown
  error: AppErrorData | null
}

const IDLE: TaskState = { status: 'idle', progress: null, logs: [], result: null, error: null }
const NO_LOGS: TaskLog[] = []

/**
 * The live state of a task started by a channel that answered a TaskRef. A known id with no event
 * yet is `running`; the events that came before the id are already in the store.
 */
export function useTask(taskId: string | null): TaskState {
  useEffect(() => retainTaskEvents(), [])
  const entry = useTasksStore((state) => (taskId ? state.tasks[taskId] : undefined))
  return useMemo(() => {
    if (!taskId) return IDLE
    if (!entry) return { ...IDLE, status: 'running', logs: NO_LOGS }
    return {
      status: entry.status,
      progress: entry.progress,
      logs: entry.logs,
      result: entry.result,
      error: entry.error,
    }
  }, [taskId, entry])
}
