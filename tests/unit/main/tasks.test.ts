import { createEventBus } from '@main/core/events'
import { createTaskManager } from '@main/core/tasks'
import { AppError } from '@shared/errors'
import type { TaskDone, TaskFailed } from '@shared/types'
import { silentLogger } from '../../helpers/core'

const TASK_EVENTS = ['task:progress', 'task:log', 'task:done', 'task:failed'] as const
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function setup() {
  const bus = createEventBus(silentLogger)
  const events: { name: string; payload: unknown }[] = []
  for (const name of TASK_EVENTS) bus.on(name, (payload) => void events.push({ name, payload }))
  const tasks = createTaskManager(bus, silentLogger)
  const settled = (taskId: string): Promise<TaskDone | TaskFailed> =>
    new Promise((resolve) => {
      bus.on('task:done', (p) => p.taskId === taskId && resolve(p))
      bus.on('task:failed', (p) => p.taskId === taskId && resolve(p))
    })
  return { events, tasks, settled }
}

describe('task manager', () => {
  it('emits progress then done with result', async () => {
    const { events, tasks, settled } = setup()
    const ref = tasks.start('templates', (t) => {
      t.progress('download', 50, { file: 'a.yaml' })
      t.log('stdout', 'hello')
      return Promise.resolve({ count: 3 })
    })
    const done = settled(ref.taskId)
    expect(ref).toEqual({ taskId: expect.any(String) as unknown })
    expect(tasks.list()).toEqual([{ taskId: ref.taskId, kind: 'templates', stage: 'init', percent: null }])

    expect(await done).toEqual({ taskId: ref.taskId, kind: 'templates', result: { count: 3 } })
    expect(events).toEqual([
      {
        name: 'task:progress',
        payload: { taskId: ref.taskId, kind: 'templates', stage: 'init', percent: null },
      },
      {
        name: 'task:progress',
        payload: {
          taskId: ref.taskId,
          kind: 'templates',
          stage: 'download',
          percent: 50,
          detail: { file: 'a.yaml' },
        },
      },
      { name: 'task:log', payload: { taskId: ref.taskId, stream: 'stdout', line: 'hello' } },
      { name: 'task:done', payload: { taskId: ref.taskId, kind: 'templates', result: { count: 3 } } },
    ])
    expect(tasks.list()).toEqual([])
  })

  it('returns the task ref before the task starts running', () => {
    const { tasks } = setup()
    const run = vi.fn(() => Promise.resolve(null))
    tasks.start('rom-scan', run)
    expect(run).not.toHaveBeenCalled()
  })

  it('list reports the latest progress of each running task', async () => {
    const { tasks } = setup()
    let release = (): void => undefined
    const ref = tasks.start('generate', (t) => {
      t.progress('fill', 40)
      return new Promise<null>((resolve) => (release = () => resolve(null)))
    })
    await nextTick()
    expect(tasks.list()).toEqual([{ taskId: ref.taskId, kind: 'generate', stage: 'fill', percent: 40 }])
    release()
  })

  it('cancel aborts signal and emits failed TASK_CANCELLED', async () => {
    const { events, tasks, settled } = setup()
    let signal: AbortSignal | undefined
    const ref = tasks.start(
      'generate',
      (t) =>
        new Promise((_, reject) => {
          signal = t.signal
          t.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const failed = settled(ref.taskId)
    await nextTick()
    tasks.cancel(ref.taskId)

    expect(signal?.aborted).toBe(true)
    expect(await failed).toEqual({ taskId: ref.taskId, kind: 'generate', error: { code: 'TASK_CANCELLED' } })
    await nextTick()
    expect(events.filter((e) => e.name === 'task:failed')).toHaveLength(1)
    expect(tasks.list()).toEqual([])
  })

  it('a task cancelled before it starts never runs', async () => {
    const { tasks, settled } = setup()
    const run = vi.fn(() => Promise.resolve(null))
    const ref = tasks.start('ap-install', run)
    const failed = settled(ref.taskId)
    tasks.cancel(ref.taskId)
    expect(await failed).toMatchObject({ error: { code: 'TASK_CANCELLED' } })
    await nextTick()
    expect(run).not.toHaveBeenCalled()
  })

  it('an AppError keeps its code and params', async () => {
    const { tasks, settled } = setup()
    const ref = tasks.start('ap-install', () =>
      Promise.reject(new AppError('INSTALL_FAILED', { exitCode: 2 })),
    )
    expect(await settled(ref.taskId)).toEqual({
      taskId: ref.taskId,
      kind: 'ap-install',
      error: { code: 'INSTALL_FAILED', params: { exitCode: 2 } },
    })
  })

  it('unknown thrown error becomes AP_UNKNOWN', async () => {
    const { tasks, settled } = setup()
    const ref = tasks.start('world-prepare', () => {
      throw new Error('boom')
    })
    expect(await settled(ref.taskId)).toEqual({
      taskId: ref.taskId,
      kind: 'world-prepare',
      error: { code: 'AP_UNKNOWN', detail: 'Error: boom' },
    })
  })

  it('ignores progress and logs after the end, and unknown cancels', async () => {
    const { events, tasks, settled } = setup()
    let late: (() => void) | undefined
    const ref = tasks.start('join-prepare', (t) => {
      late = () => {
        t.progress('late', 99)
        t.log('app', 'late')
      }
      return Promise.resolve('ok')
    })
    await settled(ref.taskId)
    const count = events.length
    late?.()
    tasks.cancel(ref.taskId)
    tasks.cancel('unknown')
    expect(events).toHaveLength(count)
  })
})
