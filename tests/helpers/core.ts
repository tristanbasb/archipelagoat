// Builds a real CoreContext for unit tests: real bus, tasks, config, secrets, lifecycle and allowed
// paths, rooted in a temporary folder, with a fake Platform (no Electron) and an Http stub.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createConfigStore } from '@main/core/config'
import type { CoreContext, Http, Platform, PlatformPaths } from '@main/core/context'
import { createEventBus } from '@main/core/events'
import { exec } from '@main/core/exec'
import type { Logger } from '@main/core/logger'
import { createSecretStore } from '@main/core/secrets'
import { createAllowedPaths } from '@main/core/system/user-path'
import { createTaskManager } from '@main/core/tasks'
import { createLifecycle, type LifecycleController } from '@main/lifecycle'
import { AppError } from '@shared/errors'
import type { OS } from '@shared/types'

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

export const hostOs: OS = process.platform === 'win32' ? 'win32' : 'linux'

const xor = (bytes: Uint8Array): Buffer => Buffer.from(bytes.map((b) => b ^ 0x5a))

export interface FakePlatform {
  platform: Platform
  openPath: ReturnType<typeof vi.fn<(p: string) => Promise<void>>>
  openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  showOpenDialog: ReturnType<typeof vi.fn<Platform['showOpenDialog']>>
  showSaveDialog: ReturnType<typeof vi.fn<Platform['showSaveDialog']>>
}

/** A Platform whose folders live under `root` and whose "encryption" never stores the plaintext. */
export function fakePlatform(root: string, overrides: Partial<Platform> = {}): FakePlatform {
  const paths: PlatformPaths = {
    userData: join(root, 'userData'),
    dataRoot: join(root, 'dataRoot'),
    temp: join(root, 'temp'),
    home: join(root, 'home'),
    downloads: join(root, 'downloads'),
    exe: join(root, 'app', 'ArchipelaGOAT.exe'),
  }
  for (const dir of [paths.userData, paths.dataRoot, paths.temp, paths.home, paths.downloads]) {
    mkdirSync(dir, { recursive: true })
  }
  const openPath = vi.fn<(p: string) => Promise<void>>(() => Promise.resolve())
  const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve())
  const showOpenDialog = vi.fn<Platform['showOpenDialog']>(() => Promise.resolve([]))
  const showSaveDialog = vi.fn<Platform['showSaveDialog']>(() => Promise.resolve(null))
  const platform: Platform = {
    os: hostOs,
    appVersion: '0.1.0-test',
    isPackaged: false,
    locale: 'fr-FR',
    paths,
    canEncrypt: () => true,
    encrypt: (s) => xor(Buffer.from(s, 'utf8')),
    decrypt: (b) => xor(b).toString('utf8'),
    openPath,
    openExternal,
    showOpenDialog,
    showSaveDialog,
    setProtocolClient: () => true,
    ...overrides,
  }
  return { platform, openPath, openExternal, showOpenDialog, showSaveDialog }
}

export const httpStub: Http = {
  getJson: () => Promise.reject(new AppError('NOT_IMPLEMENTED')),
  getText: () => Promise.reject(new AppError('NOT_IMPLEMENTED')),
  fetchRaw: () => Promise.reject(new AppError('NOT_IMPLEMENTED')),
}

export interface TestCore extends FakePlatform {
  ctx: CoreContext
  lifecycle: LifecycleController
  quit: ReturnType<typeof vi.fn<() => void>>
}

export function createTestContext(root: string, overrides: Partial<Platform> = {}): TestCore {
  const fake = fakePlatform(root, overrides)
  const { platform } = fake
  const log = silentLogger
  const bus = createEventBus(log)
  const quit = vi.fn<() => void>()
  const lifecycle = createLifecycle({ bus, log, quit })
  const config = createConfigStore(join(platform.paths.userData, 'config.json'), platform.os, { bus })
  const ctx: CoreContext = {
    platform,
    log,
    exec,
    http: httpStub,
    tasks: createTaskManager(bus, log),
    config,
    secrets: createSecretStore(join(platform.paths.userData, 'secrets.bin'), platform, config),
    bus,
    lifecycle,
    paths: createAllowedPaths(
      [platform.paths.dataRoot, platform.paths.userData, platform.paths.downloads],
      platform.os,
    ),
  }
  return { ...fake, ctx, lifecycle, quit }
}
