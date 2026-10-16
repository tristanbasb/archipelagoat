// Long operations (install, generation, scans…) run as tasks: the channel answers a TaskRef at once,
// then the task publishes task:progress / task:log and ends with task:done or task:failed.
import { randomUUID } from 'node:crypto'
import { AppError, toAppErrorData } from '@shared/errors'
import type { TaskKind, TaskLog, TaskProgress, TaskRef } from '@shared/types'
import type { EventBus } from './events'
import type { Logger } from './logger'

export interface TaskHandle {
  readonly id: string
  /** Aborted when the task is cancelled; long steps must watch it. */
  readonly signal: AbortSignal
  progress(stage: string, percent?: number | null, detail?: Record<string, string | number>): void
  log(stream: TaskLog['stream'], line: string): void
}

export interface TaskManager {
  /** Returns at once; `run` starts on the next turn of the event loop, after the caller has the ref. */
  start<T>(kind: TaskKind, run: (t: TaskHandle) => Promise<T>): TaskRef
  /** Emits task:failed TASK_CANCELLED right away; whatever `run` does afterwards is ignored. */
  cancel(taskId: string): void
  /** Latest progress of each running task. */
  list(): TaskProgress[]
}

interface Running {
  progress: TaskProgress
  controller: AbortController
}

export function createTaskManager(bus: EventBus, log?: Logger): TaskManager {
  const running = new Map<string, Running>()

  return {
    start(kind, run) {
      const taskId = randomUUID()
      const task: Running = {
        progress: { taskId, kind, stage: 'init', percent: null },
        controller: new AbortController(),
      }
      running.set(taskId, task)
      bus.emit('task:progress', task.progress)

      const isRunning = (): boolean => running.get(taskId) === task
      const handle: TaskHandle = {
        id: taskId,
        signal: task.controller.signal,
        progress(stage, percent = null, detail) {
          if (!isRunning()) return
          task.progress = detail ? { taskId, kind, stage, percent, detail } : { taskId, kind, stage, percent }
          bus.emit('task:progress', task.progress)
        },
        log(stream, line) {
          if (isRunning()) bus.emit('task:log', { taskId, stream, line })
        },
      }

      setImmediate(() => {
        if (!isRunning()) return
        Promise.resolve()
          .then(() => run(handle))
          .then(
            (result) => {
              if (!isRunning()) return
              running.delete(taskId)
              bus.emit('task:done', { taskId, kind, result })
            },
            (error: unknown) => {
              if (!isRunning()) return
              running.delete(taskId)
              const data = toAppErrorData(error)
              if (data.code === 'AP_UNKNOWN') log?.error(`task ${kind} failed`, error)
              bus.emit('task:failed', { taskId, kind, error: data })
            },
          )
      })
      return { taskId }
    },

    cancel(taskId) {
      const task = running.get(taskId)
      if (!task) return
      running.delete(taskId)
      task.controller.abort(new AppError('TASK_CANCELLED'))
      bus.emit('task:failed', { taskId, kind: task.progress.kind, error: { code: 'TASK_CANCELLED' } })
    },

    list() {
      return [...running.values()].map((task) => ({ ...task.progress }))
    },
  }
}
