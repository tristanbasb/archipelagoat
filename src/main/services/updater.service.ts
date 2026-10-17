// The `updater` service (Task 35): electron-updater against the GitHub releases (spec §8), eager so that
// it checks once at startup. electron-builder writes resources/app-update.yml only when it knows the
// repository to publish to, which a release built by .github/workflows/release.yml does; a local build
// has none, and initUpdater then does nothing at all. About shows the state (app:getInfo).
//
// When active, an update downloads in the background and installs when the app quits: no dialog and no
// notification, since the main process shows no text of its own. Only the builds that can replace
// themselves update: the NSIS install and the AppImage. The portable exe would be replaced by an
// installed copy, the deb needs root (electron-updater asks for it with pkexec) and the tar.gz has no
// updater.
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { CoreContext } from '@main/core/context'
import type { UpdaterState } from '@shared/types'
import { defineService } from './registry'

export type { UpdaterState }

/** What the service sets and calls on electron-updater's `autoUpdater`. */
export interface AutoUpdaterLike {
  logger: unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  /**
   * With autoDownload, an available update starts downloading at once and the result carries that
   * download, which rejects on any failure (UpdateCheckResult in electron-updater).
   */
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
}

export interface UpdaterOptions {
  /** Where app-update.yml would be. Default: process.resourcesPath. */
  resourcesPath?: string
  /** PORTABLE_EXECUTABLE_DIR (the portable exe), APPIMAGE (an AppImage). Default: process.env. */
  env?: NodeJS.ProcessEnv
  /** Default: electron-updater's autoUpdater, loaded only when the updater is active. */
  loadAutoUpdater?: () => Promise<AutoUpdaterLike>
}

export interface Updater {
  readonly state: UpdaterState
  /** Settles once the startup check is over (at once when inactive); never rejects. */
  readonly ready: Promise<void>
}

declare module '@main/services/registry' {
  interface Services {
    updater: Updater
  }
}

type ElectronUpdater = typeof import('electron-updater')

/**
 * electron-updater's autoUpdater. The package is CommonJS, and Node's import() does not see its
 * `autoUpdater` (a getter) as a named export: it is read from the module itself, the namespace's
 * `default` (tests/e2e/packaged-win.spec.ts loads it in a packaged build).
 */
async function electronUpdater(): Promise<AutoUpdaterLike> {
  const loaded = (await import('electron-updater')) as ElectronUpdater & { default?: ElectronUpdater }
  return (loaded.default ?? loaded).autoUpdater
}

function stateOf(ctx: CoreContext, resourcesPath: string, env: NodeJS.ProcessEnv): UpdaterState {
  if (!ctx.platform.isPackaged) return 'development'
  if (!existsSync(path.join(resourcesPath, 'app-update.yml'))) return 'not-configured'
  if (ctx.platform.os === 'win32' && env.PORTABLE_EXECUTABLE_DIR) return 'unsupported'
  if (ctx.platform.os === 'linux' && !env.APPIMAGE) return 'unsupported'
  return 'active'
}

export function initUpdater(ctx: CoreContext, opts: UpdaterOptions = {}): Updater {
  const { log } = ctx
  const state = stateOf(ctx, opts.resourcesPath ?? process.resourcesPath, opts.env ?? process.env)
  if (state !== 'active') {
    log.info(state === 'not-configured' ? 'updater: not configured (no app-update.yml)' : `updater: ${state}`)
    return { state, ready: Promise.resolve() }
  }

  const check = async (): Promise<void> => {
    const updater = await (opts.loadAutoUpdater ?? electronUpdater)()
    updater.logger = log
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    const result = await updater.checkForUpdates()
    // The download goes on in the background, past `ready`. electron-updater re-throws its failures
    // (network drop, sleep, 404, sha512 mismatch) from this promise: unhandled, one would reach the
    // app's unhandledRejection handler and its "unexpected error" dialog.
    void result?.downloadPromise?.catch((error: unknown) => log.warn('updater: download failed', error))
  }
  const ready = check().catch((error: unknown) => log.warn('updater: check failed', error))
  return { state, ready }
}

defineService('updater', (ctx) => initUpdater(ctx), { eager: true })
