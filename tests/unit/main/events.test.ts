import { createEventBus } from '@main/core/events'
import { silentLogger } from '../../helpers/core'

describe('event bus', () => {
  it('delivers payloads to every listener of the event until it unsubscribes', () => {
    const bus = createEventBus(silentLogger)
    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()
    const off = bus.on('worlds:changed', first)
    bus.on('worlds:changed', second)
    bus.on('task:log', other)

    bus.emit('worlds:changed', null)
    off()
    bus.emit('worlds:changed', null)

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledTimes(2)
    expect(other).not.toHaveBeenCalled()
  })

  it('a throwing listener is logged and does not stop the others', () => {
    const log = { ...silentLogger, error: vi.fn() }
    const bus = createEventBus(log)
    const after = vi.fn()
    bus.on('task:log', () => {
      throw new Error('listener bug')
    })
    bus.on('task:log', after)
    expect(() => bus.emit('task:log', { taskId: 't', stream: 'app', line: 'x' })).not.toThrow()
    expect(after).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('a listener added during an emit waits for the next one', () => {
    const bus = createEventBus(silentLogger)
    const late = vi.fn()
    bus.on('worlds:changed', () => void bus.on('worlds:changed', late))
    bus.emit('worlds:changed', null)
    expect(late).not.toHaveBeenCalled()
  })
})
