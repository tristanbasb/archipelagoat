import { createEventBus } from '@main/core/events'
import { createLifecycle } from '@main/lifecycle'
import type { QuitRequest } from '@shared/types'
import { silentLogger } from '../../helpers/core'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function setup(timeoutMs?: number) {
  const bus = createEventBus(silentLogger)
  const quitRequests: QuitRequest[] = []
  bus.on('app:quitRequested', (request) => void quitRequests.push(request))
  const quit = vi.fn()
  const log = { ...silentLogger, warn: vi.fn(), error: vi.fn() }
  const lifecycle = createLifecycle({ bus, log, quit, timeoutMs })
  return { lifecycle, quit, quitRequests, log }
}

describe('lifecycle', () => {
  it('runs early before-quit hooks before late ones', async () => {
    const { lifecycle } = setup()
    const order: string[] = []
    lifecycle.onBeforeQuit(
      async () => {
        await delay(5)
        order.push('late')
      },
      { phase: 'late' },
    )
    lifecycle.onBeforeQuit(
      async () => {
        await delay(30)
        order.push('early-slow')
      },
      { phase: 'early' },
    )
    lifecycle.onBeforeQuit(() => {
      order.push('early-default')
      return Promise.resolve()
    })

    await lifecycle.runBeforeQuit()
    expect(order).toEqual(['early-default', 'early-slow', 'late'])
  })

  it('a failing hook does not stop the others', async () => {
    const { lifecycle, log } = setup()
    const late = vi.fn(() => Promise.resolve())
    lifecycle.onBeforeQuit(() => Promise.reject(new Error('server refused /exit')), { phase: 'early' })
    lifecycle.onBeforeQuit(late, { phase: 'late' })
    await lifecycle.runBeforeQuit()
    expect(late).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('gives up waiting after the global timeout', async () => {
    const { lifecycle, log } = setup(40)
    lifecycle.onBeforeQuit(() => new Promise<void>(() => undefined))
    const started = Date.now()
    await lifecycle.runBeforeQuit()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('runs the before-quit hooks only once', async () => {
    const { lifecycle } = setup()
    const hook = vi.fn(() => Promise.resolve())
    lifecycle.onBeforeQuit(hook)
    await Promise.all([lifecycle.runBeforeQuit(), lifecycle.runBeforeQuit()])
    await lifecycle.runBeforeQuit()
    expect(hook).toHaveBeenCalledOnce()
  })

  it('onWindowReady replays when the window is already ready', () => {
    const { lifecycle } = setup()
    const before = vi.fn()
    lifecycle.onWindowReady(before)
    expect(before).not.toHaveBeenCalled()

    lifecycle.windowReady()
    expect(before).toHaveBeenCalledOnce()

    const after = vi.fn()
    lifecycle.onWindowReady(after)
    expect(after).toHaveBeenCalledOnce()

    lifecycle.windowReady()
    expect(before).toHaveBeenCalledOnce()
    expect(after).toHaveBeenCalledOnce()
  })

  it('close request emits app:quitRequested when a server runs, and quits after app:confirmQuit', () => {
    const { lifecycle, quit, quitRequests } = setup()
    lifecycle.onCloseRequested(() => ({ servers: ['session-1'], tasks: [] }))
    lifecycle.onCloseRequested(() => ({ servers: [], tasks: ['generate'] }))

    expect(lifecycle.requestClose()).toBe(false)
    expect(quitRequests).toEqual([
      { requestId: expect.any(String) as unknown, runningServers: ['session-1'], runningTasks: ['generate'] },
    ])
    const [{ requestId }] = quitRequests as [QuitRequest]

    lifecycle.confirmQuit('stale-request', true)
    expect(quit).not.toHaveBeenCalled()

    lifecycle.confirmQuit(requestId, true)
    expect(quit).toHaveBeenCalledOnce()
    expect(lifecycle.requestClose()).toBe(true)
  })

  it('lets the window close when nothing runs, and keeps it open when the user declines', () => {
    const { lifecycle, quit, quitRequests } = setup()
    expect(lifecycle.requestClose()).toBe(true)
    expect(quitRequests).toEqual([])

    let running = true
    lifecycle.onCloseRequested(() => ({ servers: running ? ['s'] : [], tasks: [] }))
    expect(lifecycle.requestClose()).toBe(false)
    lifecycle.confirmQuit(quitRequests[0]?.requestId ?? '', false)
    expect(quit).not.toHaveBeenCalled()
    expect(lifecycle.requestClose()).toBe(false)

    running = false
    expect(lifecycle.requestClose()).toBe(true)
  })

  it('lets the window close once quitting has started', async () => {
    const { lifecycle } = setup()
    lifecycle.onCloseRequested(() => ({ servers: ['s'], tasks: [] }))
    await lifecycle.runBeforeQuit()
    expect(lifecycle.requestClose()).toBe(true)
  })

  it('buffers second-instance argv and opened files until a listener subscribes', () => {
    const { lifecycle } = setup()
    lifecycle.secondInstance(['goat.exe', 'archipelago://a'])
    lifecycle.openFile('/x/patch.apemerald')

    const argv = vi.fn()
    const file = vi.fn()
    lifecycle.onSecondInstance(argv)
    lifecycle.onOpenFile(file)
    expect(argv).toHaveBeenCalledExactlyOnceWith(['goat.exe', 'archipelago://a'])
    expect(file).toHaveBeenCalledExactlyOnceWith('/x/patch.apemerald')

    lifecycle.secondInstance(['goat.exe', 'archipelago://b'])
    expect(argv).toHaveBeenLastCalledWith(['goat.exe', 'archipelago://b'])
  })
})
