// Every task the main process reports (task:progress / task:log / task:done / task:failed), kept
// by id. The app subscribes for its whole life, so the events of a task are kept even when they
// arrive before the TaskRef reply that names it (the first progress always does). useTask reads
// one task; the status bar reads the running ones.
import { create } from 'zustand'
import type { AppErrorData } from '@shared/errors'
import type { TaskDone, TaskFailed, TaskKind, TaskLog, TaskProgress } from '@shared/types'
import { invoke, sharedSubscription, subscribe } from '../lib/goat'

export interface TaskEntry {
  taskId: string
  kind: TaskKind | null
  status: 'running' | 'done' | 'failed'
  progress: TaskProgress | null
  logs: TaskLog[]
  result: unknown
  error: AppErrorData | null
  /** Order of the last change, to drop the oldest finished tasks first. */
  seq: number
}

interface TasksState {
  tasks: Record<string, TaskEntry>
}

/** Log lines kept per task (the newest ones). */
const MAX_TASK_LOGS = 2000
/** Finished tasks kept for late readers; older ones are dropped. */
const MAX_FINISHED_TASKS = 50

export const useTasksStore = create<TasksState>(() => ({ tasks: {} }))

let seq = 0

function update(taskId: string, change: (entry: TaskEntry) => Partial<TaskEntry>): void {
  useTasksStore.setState(({ tasks }) => {
    const entry: TaskEntry = tasks[taskId] ?? {
      taskId,
      kind: null,
      status: 'running',
      progress: null,
      logs: [],
      result: null,
      error: null,
      seq: 0,
    }
    const next = { ...tasks, [taskId]: { ...entry, ...change(entry), seq: ++seq } }
    return { tasks: prune(next) }
  })
}

function prune(tasks: Record<string, TaskEntry>): Record<string, TaskEntry> {
  const finished = Object.values(tasks).filter((task) => task.status !== 'running')
  if (finished.length <= MAX_FINISHED_TASKS) return tasks
  const out = { ...tasks }
  finished
    .sort((a, b) => a.seq - b.seq)
    .slice(0, finished.length - MAX_FINISHED_TASKS)
    .forEach((task) => delete out[task.taskId])
  return out
}

function applyProgress(progress: TaskProgress): void {
  update(progress.taskId, (entry) =>
    // A late progress never brings a finished task back to life.
    entry.status === 'running' ? { kind: progress.kind, progress } : {},
  )
}

function applyLog(log: TaskLog): void {
  update(log.taskId, (entry) => ({ logs: [...entry.logs, log].slice(-MAX_TASK_LOGS) }))
}

function applyDone(done: TaskDone): void {
  update(done.taskId, () => ({ kind: done.kind, status: 'done', result: done.result }))
}

function applyFailed(failed: TaskFailed): void {
  update(failed.taskId, () => ({ kind: failed.kind, status: 'failed', error: failed.error }))
}

/**
 * Keeps the task events flowing into the store while at least one user holds it (the app shell
 * does, for its whole life). Returns the release function.
 */
export const retainTaskEvents = sharedSubscription(() => {
  let live = true
  const offs = [
    subscribe('task:progress', applyProgress),
    subscribe('task:log', applyLog),
    subscribe('task:done', applyDone),
    subscribe('task:failed', applyFailed),
  ]
  // Tasks that started before this renderer did (a reload): their latest progress.
  invoke('tasks:list', undefined).then(
    (list) => {
      if (!live) return
      const known = useTasksStore.getState().tasks
      for (const progress of list.filter((task) => !known[task.taskId])) applyProgress(progress)
    },
    () => undefined,
  )
  return () => {
    live = false
    for (const off of offs) off()
    useTasksStore.setState({ tasks: {} })
  }
})
