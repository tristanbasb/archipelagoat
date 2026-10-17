import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreContext } from '@main/core/context'
import type { Logger } from '@main/core/logger'
import { createServices } from '@main/services'
import { initUpdater, type AutoUpdaterLike, type UpdaterOptions } from '@main/services/updater.service'
import type { OS } from '@shared/types'
import { createTestContext } from '../../helpers/core'

interface Recorded {
  level: keyof Logger
  message: string
  data?: unknown
}

type CheckForUpdates = AutoUpdaterLike['checkForUpdates']

/** electron-updater's autoUpdater as the service sees it; `check` is its checkForUpdates. */
function fakeAutoUpdater(answer: CheckForUpdates = () => Promise.resolve(null)): {
  updater: AutoUpdaterLike
  check: ReturnType<typeof vi.fn<CheckForUpdates>>
} {
  const check = vi.fn(answer)
  return {
    updater: { logger: null, autoDownload: false, autoInstallOnAppQuit: false, checkForUpdates: check },
    check,
  }
}

describe('updater service', () => {
  let dir: string
  let resources: string
  let logged: Recorded[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goat-updater-'))
    resources = join(dir, 'resources')
    mkdirSync(resources)
    logged = []
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** A packaged app on `os`, logging into `logged`. */
  function context(os: OS = 'win32', isPackaged = true): CoreContext {
    const { ctx } = createTestContext(join(dir, 'ctx'), { os, isPackaged })
    const record =
      (level: keyof Logger) =>
      (message: string, data?: unknown): void =>
        void logged.push(data === undefined ? { level, message } : { level, message, data })
    const log: Logger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    }
    return { ...ctx, log }
  }

  const configure = (): void => writeFileSync(join(resources, 'app-update.yml'), 'provider: github\n')

  function start(
    ctx: CoreContext,
    opts: Partial<UpdaterOptions> & { fake?: ReturnType<typeof fakeAutoUpdater> } = {},
  ) {
    const { fake, ...options } = opts
    const { updater, check } = fake ?? fakeAutoUpdater()
    const loadAutoUpdater = vi.fn(() => Promise.resolve(updater))
    const service = initUpdater(ctx, { resourcesPath: resources, env: {}, loadAutoUpdater, ...options })
    return { service, updater, check, loadAutoUpdater }
  }

  it('does nothing in a local build, which has no app-update.yml', async () => {
    const { service, loadAutoUpdater } = start(context())
    await service.ready
    expect(service.state).toBe('not-configured')
    expect(loadAutoUpdater).not.toHaveBeenCalled()
    expect(logged).toEqual([{ level: 'info', message: 'updater: not configured (no app-update.yml)' }])
  })

  it('does nothing in development, even with an app-update.yml', async () => {
    configure()
    const { service, loadAutoUpdater } = start(context('win32', false))
    await service.ready
    expect(service.state).toBe('development')
    expect(loadAutoUpdater).not.toHaveBeenCalled()
  })

  it('leaves the portable exe alone: it cannot replace itself', async () => {
    configure()
    const { service, loadAutoUpdater } = start(context('win32'), { env: { PORTABLE_EXECUTABLE_DIR: 'D:\\' } })
    await service.ready
    expect(service.state).toBe('unsupported')
    expect(loadAutoUpdater).not.toHaveBeenCalled()
  })

  it('updates on Linux only as an AppImage: the deb would need root, the tar.gz has no updater', async () => {
    configure()
    const deb = start(context('linux'))
    await deb.service.ready
    expect(deb.service.state).toBe('unsupported')
    expect(deb.loadAutoUpdater).not.toHaveBeenCalled()

    const appImage = start(context('linux'), { env: { APPIMAGE: '/home/me/ArchipelaGOAT.AppImage' } })
    await appImage.service.ready
    expect(appImage.service.state).toBe('active')
    expect(appImage.check).toHaveBeenCalledOnce()
  })

  it('in a configured build, checks once at startup, downloads in the background and installs on quit', async () => {
    configure()
    const ctx = context('win32')
    const { service, updater, check } = start(ctx)
    expect(service.state).toBe('active')
    await service.ready
    expect(check).toHaveBeenCalledOnce()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    // electron-updater writes to the app's log, which masks secrets.
    expect(updater.logger).toBe(ctx.log)
  })

  it('logs a failed check and carries on', async () => {
    configure()
    const fake = fakeAutoUpdater(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')))
    const { service } = start(context('win32'), { fake })
    await expect(service.ready).resolves.toBeUndefined()
    expect(logged).toContainEqual({
      level: 'warn',
      message: 'updater: check failed',
      data: expect.objectContaining({ message: 'net::ERR_INTERNET_DISCONNECTED' }) as unknown,
    })
  })

  it('logs a failed background download and carries on, without waiting for it at startup', async () => {
    configure()
    // electron-updater starts the download inside checkForUpdates and hands back its promise, which
    // rejects on any failure (network drop, 404, sha512 mismatch): unhandled, it would reach the
    // app's unhandledRejection handler and its "unexpected error" dialog.
    let failDownload: (error: Error) => void = () => undefined
    const downloadPromise = new Promise<string[]>((_resolve, reject) => (failDownload = reject))
    const fake = fakeAutoUpdater(() => Promise.resolve({ downloadPromise }))
    const { service } = start(context('win32'), { fake })
    await expect(service.ready).resolves.toBeUndefined()
    failDownload(new Error('sha512 checksum mismatch'))
    await vi.waitFor(() =>
      expect(logged).toContainEqual({
        level: 'warn',
        message: 'updater: download failed',
        data: expect.objectContaining({ message: 'sha512 checksum mismatch' }) as unknown,
      }),
    )
  })

  it('is the `updater` service, inactive in an unpackaged app', async () => {
    const services = createServices(context('win32', false))
    const service = services.get('updater')
    await service.ready
    expect(service.state).toBe('development')
  })

  it('logs an updater that cannot load and carries on', async () => {
    configure()
    const loadAutoUpdater = vi.fn(() => Promise.reject(new Error('cannot load')))
    const service = initUpdater(context('win32'), { resourcesPath: resources, env: {}, loadAutoUpdater })
    await expect(service.ready).resolves.toBeUndefined()
    expect(logged).toContainEqual({
      level: 'warn',
      message: 'updater: check failed',
      data: expect.objectContaining({ message: 'cannot load' }) as unknown,
    })
  })
})
