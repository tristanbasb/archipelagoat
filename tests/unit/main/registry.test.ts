import { createIpcRegistry, type IpcMainLike } from '@main/ipc/registry'
import type { Logger } from '@main/core/logger'
import { AppError } from '@shared/errors'
import { channels } from '@shared/ipc'
import { silentLogger } from '../../helpers/core'

type Listener = Parameters<IpcMainLike['handle']>[1]

function setup(log: Logger = silentLogger) {
  const registry = createIpcRegistry()
  const listeners = new Map<string, Listener>()
  registry.installIpc({ handle: (name, listener) => void listeners.set(name, listener) }, { log })
  const call = (name: string, input?: unknown): Promise<unknown> => {
    const listener = listeners.get(name)
    if (!listener) throw new Error(`no listener for ${name}`)
    return Promise.resolve(listener({ sender: { id: 7 } }, input))
  }
  return { registry, listeners, call }
}

describe('ipc registry', () => {
  it('installs one ipcMain handler per channel of the contract', () => {
    const { listeners } = setup()
    expect([...listeners.keys()].sort()).toEqual(Object.keys(channels).sort())
  })

  it('unregistered channel answers NOT_IMPLEMENTED', async () => {
    const { call } = setup()
    expect(await call('vault:list')).toEqual({ ok: false, error: { code: 'NOT_IMPLEMENTED' } })
  })

  it('invalid input answers INVALID_INPUT with zod path in detail', async () => {
    const { registry, call } = setup()
    const handler = vi.fn(() => Promise.reject(new Error('unreachable')))
    registry.registerHandler('session:get', handler)
    registry.registerHandler('session:update', handler)

    expect(await call('session:get', {})).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', detail: expect.stringMatching(/^id: /) as unknown },
    })
    const nested = (await call('session:update', { id: 's', rules: { hintCost: 'ten' } })) as {
      error: { detail: string }
    }
    expect(nested.error.detail).toContain('rules.hintCost')
    expect(await call('session:get', { id: 's', extra: 1 })).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('passes the parsed input and the sender id, and wraps the value', async () => {
    const { registry, call } = setup()
    const handler = vi.fn((input: { id: string; fileId: string }) =>
      Promise.resolve({ text: `${input.id}/${input.fileId}` }),
    )
    registry.registerHandler('session:readFile', handler)
    expect(await call('session:readFile', { id: 's1', fileId: 'f2' })).toEqual({
      ok: true,
      value: { text: 's1/f2' },
    })
    expect(handler).toHaveBeenCalledWith({ id: 's1', fileId: 'f2' }, { senderId: 7 })
  })

  it('AppError thrown by handler is returned as data', async () => {
    const { registry, call } = setup()
    registry.registerHandler('session:get', () =>
      Promise.reject(new AppError('NOT_FOUND', { id: 's1' }, { detail: 'gone' })),
    )
    expect(await call('session:get', { id: 's1' })).toStrictEqual({
      ok: false,
      error: { code: 'NOT_FOUND', params: { id: 's1' }, detail: 'gone' },
    })
  })

  it('an unexpected error becomes AP_UNKNOWN and is logged', async () => {
    const log = { ...silentLogger, error: vi.fn() }
    const { registry, call } = setup(log)
    registry.registerHandler('tasks:list', () => {
      throw new TypeError('bug')
    })
    expect(await call('tasks:list')).toEqual({
      ok: false,
      error: { code: 'AP_UNKNOWN', detail: 'TypeError: bug' },
    })
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('refuses a second handler for the same channel', () => {
    const { registry } = setup()
    registry.registerHandler('tasks:list', () => Promise.resolve([]))
    expect(() => registry.registerHandler('tasks:list', () => Promise.resolve([]))).toThrow(/tasks:list/)
  })

  it('masks the secrets of error details and string params: the renderer shows them raw', async () => {
    const { registry, call } = setup()
    registry.registerHandler('session:get', () =>
      Promise.reject(
        new AppError(
          'SERVER_START_FAILED',
          { line: 'Hosting game at 1.2.3.4:38281 (Password: hunter2)', port: 38281 },
          { detail: "refused: {'cmd': 'Connect', 'password': 'hunter2'}", logPath: 'C:\\logs\\server.log' },
        ),
      ),
    )
    registry.registerHandler('tasks:list', () => {
      throw new Error('GET https://archipelago.gg/session/0f8fad5b-d9cb-469f-a165-70867728950e failed')
    })

    expect(await call('session:get', { id: 's1' })).toStrictEqual({
      ok: false,
      error: {
        code: 'SERVER_START_FAILED',
        params: { line: 'Hosting game at 1.2.3.4:38281 (Password: •••)', port: 38281 },
        detail: "refused: {'cmd': 'Connect', 'password': '•••'}",
        logPath: 'C:\\logs\\server.log',
      },
    })
    expect(await call('tasks:list')).toEqual({
      ok: false,
      error: { code: 'AP_UNKNOWN', detail: 'Error: GET https://archipelago.gg/session/••• failed' },
    })
  })
})
