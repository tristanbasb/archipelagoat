// Installs APWorlds one at a time: worlds:prepareInstall (a task that inspects the file), the trust
// dialog, then worlds:confirmInstall. Successive start() calls wait in a queue.
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toAppErrorData, type AppErrorData } from '@shared/errors'
import type { WorldInstallPlan, WorldSource } from '@shared/types'
import { useToast } from '../design/components'
import { TrustDialog } from '../features/worlds/TrustDialog'
import { describeError } from '../lib/errors'
import { invoke } from '../lib/goat'
import { useTask } from './useTask'

export type WorldInstallState = 'idle' | 'preparing' | 'review' | 'installing' | 'error'

export interface WorldInstall {
  /** Queues an install; resolves once the user installed it or gave up. */
  start: (source: WorldSource) => Promise<{ installed: boolean }>
  /** The dialog to render (the trust screen of the current install). */
  dialog: ReactNode
  state: WorldInstallState
}

interface Job {
  id: number
  source: WorldSource
  resolve: (result: { installed: boolean }) => void
  taskId: string | null
  prepareError: AppErrorData | null
  installError: AppErrorData | null
  installing: boolean
}

/** Lists that change when a world is installed, removed or switched on or off. */
export const WORLD_QUERIES = ['worlds:list', 'catalog:list', 'studio:games'] as const

export function useWorldInstall(): WorldInstall {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [queue, setQueue] = useState<Job[]>([])
  const lastId = useRef(0)
  const started = useRef(new Set<number>())
  const finished = useRef(new Set<number>())

  const current = queue[0] ?? null
  const task = useTask(current?.taskId ?? null)
  const plan = task.status === 'done' ? (task.result as WorldInstallPlan) : null
  const prepareError = current?.prepareError ?? (task.status === 'failed' ? task.error : null)

  const patch = useCallback((id: number, change: Partial<Job>): void => {
    setQueue((jobs) => jobs.map((job) => (job.id === id ? { ...job, ...change } : job)))
  }, [])

  const finish = (job: Job, installed: boolean): void => {
    finished.current.add(job.id)
    job.resolve({ installed })
    setQueue((jobs) => jobs.filter((other) => other.id !== job.id))
  }

  // Inspect the job at the head of the queue (once, even when React runs the effect twice).
  useEffect(() => {
    if (!current || started.current.has(current.id)) return
    started.current.add(current.id)
    const { id, source } = current
    invoke('worlds:prepareInstall', { source }).then(
      ({ taskId }) => {
        // Given up before the task even had an id: stop it.
        if (finished.current.has(id)) void invoke('tasks:cancel', { taskId }).catch(() => undefined)
        else patch(id, { taskId })
      },
      (error: unknown) => patch(id, { prepareError: toAppErrorData(error) }),
    )
  }, [current, patch])

  // Leaving the screen gives up every waiting install: the callers learn it, the inspection stops.
  const queueRef = useRef(queue)
  useEffect(() => {
    queueRef.current = queue
  })
  useEffect(
    () => () => {
      for (const job of queueRef.current) {
        if (finished.current.has(job.id)) continue
        finished.current.add(job.id)
        if (job.taskId) void invoke('tasks:cancel', { taskId: job.taskId }).catch(() => undefined)
        job.resolve({ installed: false })
      }
    },
    [],
  )

  const start = useCallback(
    (source: WorldSource) =>
      new Promise<{ installed: boolean }>((resolve) => {
        const id = ++lastId.current
        setQueue((jobs) => [
          ...jobs,
          { id, source, resolve, taskId: null, prepareError: null, installError: null, installing: false },
        ])
      }),
    [],
  )

  const confirm = async (): Promise<void> => {
    if (!current || !plan || current.installing) return
    patch(current.id, { installing: true, installError: null })
    try {
      const { world, restartNeeded } = await invoke('worlds:confirmInstall', { planId: plan.planId })
      const game = world.game ?? plan.manifest?.game ?? plan.module
      toast.push(
        restartNeeded
          ? {
              tone: 'warn',
              title: t('worldInstall.restartTitle'),
              body: t('worldInstall.restartBody', { game }),
            }
          : { tone: 'ok', title: t('worldInstall.installed', { game }) },
      )
      for (const name of WORLD_QUERIES) void queryClient.invalidateQueries({ queryKey: [name] })
      finish(current, true)
    } catch (error) {
      patch(current.id, { installing: false, installError: toAppErrorData(error) })
    }
  }

  /**
   * The catalog had no file to give (WORLD_RELEASE_UNAVAILABLE): the player picks the one downloaded
   * by hand, and the same install goes on from it, its caller still waiting for the outcome.
   */
  const installFromFile = async (): Promise<void> => {
    if (!current) return
    const job = current
    let paths: string[]
    try {
      paths = await invoke('app:pickPaths', {
        mode: 'file',
        title: t('worldInstall.pickFileTitle'),
        filters: [{ name: 'APWorld', extensions: ['apworld'] }],
      })
    } catch (error) {
      const { title, body } = describeError(error, t)
      toast.push({ tone: 'error', title, body })
      return
    }
    const [path] = paths
    if (path === undefined || finished.current.has(job.id)) return
    // A new id: the effect above inspects the file as it inspects any new job.
    const id = ++lastId.current
    const source: WorldSource = { kind: 'file', path }
    setQueue((jobs) =>
      jobs.map((other) =>
        other.id === job.id
          ? { ...other, id, source, taskId: null, prepareError: null, installError: null }
          : other,
      ),
    )
  }

  const cancel = (): void => {
    if (!current || current.installing) return
    if (current.taskId && task.status === 'running') {
      void invoke('tasks:cancel', { taskId: current.taskId }).catch(() => undefined)
    }
    finish(current, false)
  }

  const state: WorldInstallState = !current
    ? 'idle'
    : current.installing
      ? 'installing'
      : plan
        ? 'review'
        : prepareError
          ? 'error'
          : 'preparing'

  const dialog = (
    <TrustDialog
      open={current !== null}
      plan={plan}
      progress={task.progress}
      error={plan ? (current?.installError ?? null) : prepareError}
      installing={current?.installing ?? false}
      queued={Math.max(0, queue.length - 1)}
      onConfirm={() => void confirm()}
      onCancel={cancel}
      onPickFile={() => void installFromFile()}
    />
  )

  return { start, dialog, state }
}
