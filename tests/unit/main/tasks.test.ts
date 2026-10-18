import { createEventBus } from '@main/core/events'
import { createTaskManager, startTracked, tasksToConfirm } from '@main/core/tasks'
import { createLifecycle } from '@main/lifecycle'
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

describe('tasksToConfirm', () => {
  it('leaves the refinement of profiles out of what closing the window asks about', async () => {
    const bus = createEventBus(silentLogger)
    const tasks = createTaskManager(bus, silentLogger)
    const lifecycle = createLifecycle({ bus, log: silentLogger, quit: () => undefined })
    const asked: string[][] = []
    bus.on('app:quitRequested', ({ runningTasks }) => void asked.push(runningTasks))
    lifecycle.onCloseRequested(() => ({ servers: [], tasks: tasksToConfirm(tasks) }))

    // A refinement nobody asked for: the window closes, and quitting cancels it.
    const background = tasks.start('profiles', () => new Promise<never>(() => undefined))
    expect(tasksToConfirm(tasks)).toEqual([])
    expect(lifecycle.requestClose()).toBe(true)
    expect(asked).toEqual([])
    expect(tasks.list().map((task) => task.taskId)).toEqual([background.taskId])

    // A task the user started is asked about, the refinement still left out.
    tasks.start('measure', () => new Promise<never>(() => undefined))
    await nextTick()
    expect(tasksToConfirm(tasks)).toEqual(['measure'])
    expect(lifecycle.requestClose()).toBe(false)
    expect(asked).toEqual([['measure']])
  })
})

describe('startTracked', () => {
  function tracked() {
    const bus = createEventBus(silentLogger)
    const tasks = createTaskManager(bus, silentLogger)
    const ends: string[] = []
    return { bus, tasks, ends }
  }

  it('calls onEnd once the run settles, success or failure, and not before', async () => {
    const { bus, tasks, ends } = tracked()
    let finish: (() => void) | undefined
    startTracked(
      tasks,
      bus,
      'generate',
      () => new Promise<void>((resolve) => (finish = resolve)),
      () => ends.push('ok'),
    )
    startTracked(
      tasks,
      bus,
      'generate',
      () => Promise.reject(new Error('boom')),
      () => ends.push('failed'),
    )
    await nextTick()
    await nextTick()
    expect(ends).toEqual(['failed'])
    finish?.()
    await nextTick()
    expect(ends).toEqual(['failed', 'ok'])
  })

  it('calls onEnd when the task is cancelled before its run starts, which then never runs', async () => {
    const { bus, tasks, ends } = tracked()
    const run = vi.fn(() => Promise.resolve(null))
    const ref = startTracked(tasks, bus, 'webhost-host', run, () => ends.push('end'))
    tasks.cancel(ref.taskId)
    expect(ends).toEqual(['end'])
    await nextTick()
    expect(run).not.toHaveBeenCalled()
    expect(ends).toEqual(['end'])
  })

  it('a cancel after the start waits for the run to settle (its cleanup)', async () => {
    const { bus, tasks, ends } = tracked()
    let finish: (() => void) | undefined
    const ref = startTracked(
      tasks,
      bus,
      'generate',
      () => new Promise<void>((resolve) => (finish = resolve)),
      () => ends.push('end'),
    )
    await nextTick()
    tasks.cancel(ref.taskId)
    expect(ends).toEqual([])
    finish?.()
    await nextTick()
    expect(ends).toEqual(['end'])
  })
})
