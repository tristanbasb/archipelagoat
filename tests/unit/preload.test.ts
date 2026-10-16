import { GoatError } from '@shared/errors'
import type { GoatApi } from '@shared/goat-api'

const electron = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {}
  return {
    exposed,
    contextBridge: { exposeInMainWorld: vi.fn((key: string, api: unknown) => void (exposed[key] = api)) },
    ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
    webUtils: { getPathForFile: vi.fn(() => 'C:\\Users\\Jérôme\\Player.yaml') },
  }
})

vi.mock('electron', () => electron)

let goat: GoatApi

beforeAll(async () => {
  await import('../../src/preload/index')
  goat = electron.exposed.goat as GoatApi
})

beforeEach(() => vi.clearAllMocks())

describe('preload bridge', () => {
  it('exposes window.goat once, with the os', () => {
    expect(Object.keys(electron.exposed)).toEqual(['goat'])
    expect(goat.os).toBe(process.platform === 'win32' ? 'win32' : 'linux')
  })

  it('invoke resolves with the value of a successful result', async () => {
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: [] })
    await expect(goat.invoke('tasks:list')).resolves.toEqual([])
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('tasks:list', undefined)

    electron.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, value: { text: 'name: P1' } })
    await expect(goat.invoke('session:readFile', { id: 's', fileId: 'f' })).resolves.toEqual({
      text: 'name: P1',
    })
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('session:readFile', { id: 's', fileId: 'f' })
  })

  it('invoke rejects with a GoatError that survives the context bridge', async () => {
    electron.ipcRenderer.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', params: { id: 's' }, detail: 'gone' },
    })
    const error: unknown = await goat.invoke('session:get', { id: 's' }).catch((e: unknown) => e)
    // contextBridge copies only the message of an Error, so the rejection is a plain object.
    expect(Object.getPrototypeOf(error)).toBe(Object.prototype)
    expect(error).toEqual({
      name: 'GoatError',
      message: 'NOT_FOUND: gone',
      code: 'NOT_FOUND',
      params: { id: 's' },
      detail: 'gone',
    })
    expect(error instanceof GoatError).toBe(true)
  })

  it('invoke turns a transport failure into a GoatError too', async () => {
    electron.ipcRenderer.invoke.mockRejectedValueOnce(new Error("No handler registered for 'x'"))
    const error: unknown = await goat.invoke('tasks:list').catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'GoatError', code: 'AP_UNKNOWN' })
    expect(error instanceof GoatError).toBe(true)
  })

  it('on subscribes to contract events only and passes the payload alone', () => {
    const cb = vi.fn()
    const off = goat.on('task:done', cb)
    const [[name, listener]] = electron.ipcRenderer.on.mock.calls as [[string, (...args: unknown[]) => void]]
    expect(name).toBe('task:done')

    listener({ sender: 'ipc event' }, { taskId: 't', kind: 'generate', result: 1 })
    expect(cb).toHaveBeenCalledExactlyOnceWith({ taskId: 't', kind: 'generate', result: 1 })

    off()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith('task:done', listener)
    expect(() => goat.on('ELECTRON_BROWSER_REQUIRE' as never, cb)).toThrow(/unknown event/)
  })

  it('pathForFile delegates to webUtils', () => {
    const file = {} as Parameters<GoatApi['pathForFile']>[0]
    expect(goat.pathForFile(file)).toBe('C:\\Users\\Jérôme\\Player.yaml')
    expect(electron.webUtils.getPathForFile).toHaveBeenCalledWith(file)
  })
})
