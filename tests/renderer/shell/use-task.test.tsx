import { renderHook, waitFor } from '@testing-library/react'
import { useTask } from '@renderer/hooks/useTask'
import { useTasksStore } from '@renderer/stores/tasks'
import { installGoatMock } from '../goat-mock'

describe('useTask', () => {
  it('is idle without a task id', () => {
    installGoatMock()
    const { result } = renderHook(() => useTask(null))
    expect(result.current).toEqual({ status: 'idle', progress: null, logs: [], result: null, error: null })
  })

  it('useTask aggregates progress, logs and done events', () => {
    const goat = installGoatMock()
    const { result } = renderHook(() => useTask('t1'))
    expect(result.current.status).toBe('running')

    goat.emit('task:progress', { taskId: 't1', kind: 'generate', stage: 'fill', percent: 40 })
    goat.emit('task:log', { taskId: 't1', stream: 'stdout', line: 'Filling the world with items.' })
    goat.emit('task:log', { taskId: 'other', stream: 'stdout', line: 'not mine' })
    goat.emit('task:log', { taskId: 't1', stream: 'stderr', line: 'Warning: low on spots' })
    goat.emit('task:progress', { taskId: 't1', kind: 'generate', stage: 'output', percent: 90 })

    expect(result.current.status).toBe('running')
    expect(result.current.progress).toEqual({ taskId: 't1', kind: 'generate', stage: 'output', percent: 90 })
    expect(result.current.logs.map((log) => log.line)).toEqual([
      'Filling the world with items.',
      'Warning: low on spots',
    ])

    goat.emit('task:done', { taskId: 't1', kind: 'generate', result: { seedName: 'W42' } })
    expect(result.current).toMatchObject({ status: 'done', result: { seedName: 'W42' }, error: null })
    expect(result.current.logs).toHaveLength(2)
  })

  it('reports a failed task with its error', () => {
    const goat = installGoatMock()
    const { result } = renderHook(() => useTask('t2'))
    goat.emit('task:failed', {
      taskId: 't2',
      kind: 'generate',
      error: { code: 'AP_FILL_UNBEATABLE', logPath: 'C:\\logs\\gen.txt' },
    })
    expect(result.current).toMatchObject({
      status: 'failed',
      error: { code: 'AP_FILL_UNBEATABLE', logPath: 'C:\\logs\\gen.txt' },
    })
  })

  it('keeps the events that arrive before the TaskRef reply', () => {
    const goat = installGoatMock()
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useTask(id), {
      initialProps: { id: null as string | null },
    })
    // The main process emits the first progress before `invoke` resolves with the task id.
    goat.emit('task:progress', { taskId: 't3', kind: 'world-prepare', stage: 'init', percent: null })
    goat.emit('task:log', { taskId: 't3', stream: 'app', line: 'reading archive' })
    rerender({ id: 't3' })
    expect(result.current.status).toBe('running')
    expect(result.current.progress?.stage).toBe('init')
    expect(result.current.logs).toHaveLength(1)
  })

  it('seeds the running tasks from tasks:list for the status bar', async () => {
    installGoatMock({
      'tasks:list': () => [{ taskId: 'old', kind: 'ap-install', stage: 'download', percent: 12 }],
    })
    const { result } = renderHook(() => useTask('old'))
    await waitFor(() => expect(result.current.progress?.stage).toBe('download'))
    expect(Object.values(useTasksStore.getState().tasks).map((task) => task.status)).toEqual(['running'])
  })

  it('keeps the newest 2000 log lines and the 50 latest finished tasks', () => {
    const goat = installGoatMock()
    const { result } = renderHook(() => useTask('long'))
    for (let i = 0; i < 2005; i++)
      goat.emit('task:log', { taskId: 'long', stream: 'stdout', line: `line ${i}` })
    expect(result.current.logs).toHaveLength(2000)
    expect(result.current.logs[0]?.line).toBe('line 5')

    for (let i = 0; i < 55; i++) goat.emit('task:done', { taskId: `old-${i}`, kind: 'rom-scan', result: i })
    const ids = Object.keys(useTasksStore.getState().tasks)
    expect(ids).toHaveLength(51)
    expect(ids).toContain('long')
    expect(ids).not.toContain('old-4')
    expect(ids).toContain('old-5')
  })
})
