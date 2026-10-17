// The `installer` service: the latest release of Archipelago, and its install, update and uninstall
// as tasks (spec §3.4-3.5). Task stages of an install: `download`, `verify`, `backup`, `quarantine`
// (Windows only: the Linux release has no settings step to block), `install`, `detect`. An install
// result is the `ApInstall`, announced by `ap:installed`; an uninstall result is null.
import path from 'node:path'
import type { CoreContext } from '@main/core/context'
import { assertUserPath } from '@main/core/system/user-path'
import type { TaskHandle } from '@main/core/tasks'
import { AppError } from '@shared/errors'
import type { ApInstall, ApRelease, TaskRef } from '@shared/types'
import { throwIfCancelled } from './install-steps'
import { installLinux, uninstallLinux } from './installer-linux'
import { installWindows, uninstallWindows } from './installer-win'
import type { Locator } from './locator'
import { listApProcesses, type ProcessInfo } from './processes'
import { fetchLatestApRelease } from './releases'

export interface InstallServiceDeps {
  locator: Pick<Locator, 'detect' | 'fromRoot' | 'invalidate'>
  /** The Archipelago programs running. Default: `listApProcesses`. */
  listProcesses?: () => Promise<ProcessInfo[]>
}

export interface InstallService {
  /** The latest release; `force` asks GitHub again instead of answering from memory. */
  latest(force?: boolean): Promise<ApRelease>
  /**
   * Installs or updates to the latest release. `customDir` (a path from the renderer) is where the
   * Windows installer puts Archipelago, or the folder that receives `Archipelago/` on Linux, which
   * detection then uses first. Without it, a Linux install the app made in such a folder
   * (`linux-targz`) is updated where it is. A release file without a SHA-256 is refused
   * (INSTALL_FAILED `no-digest`, before any download) unless `allowUnverified`: the installer runs
   * elevated, and the user must know that only its size is checked (spec §3.3).
   */
  install(opts: { desktopIcons: boolean; customDir: string | null; allowUnverified?: boolean }): TaskRef
  /** Uninstalls the copy the official installer or the app made; never a folder picked by hand. */
  uninstall(opts: { purgeUserData: boolean }): TaskRef
}

export function createInstallService(ctx: CoreContext, deps: InstallServiceDeps): InstallService {
  const { locator } = deps
  const { os } = ctx.platform
  const listProcesses = deps.listProcesses ?? (() => listApProcesses(ctx.exec, os))

  // One install or uninstall at a time: a second one waits for the first to end.
  let queue: Promise<unknown> = Promise.resolve()
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  /** AP_RUNNING when an Archipelago program runs; a listing that fails does not block. */
  async function refuseIfRunning(): Promise<void> {
    let running: ProcessInfo[]
    try {
      running = await listProcesses()
    } catch (error) {
      ctx.log.warn('installer: cannot list the archipelago programs', error)
      return
    }
    if (running.length > 0) {
      const names = [...new Set(running.map((p) => p.name))].join(', ')
      throw new AppError('AP_RUNNING', undefined, { detail: names })
    }
  }

  async function install(
    desktopIcons: boolean,
    customDir: string | null,
    allowUnverified: boolean,
    task: TaskHandle,
  ): Promise<ApInstall> {
    throwIfCancelled(task.signal)
    const dir =
      customDir === null
        ? null
        : await assertUserPath(customDir, { mustExist: false, kind: 'dir', access: 'write' })
    await refuseIfRunning()
    const release = await fetchLatestApRelease(ctx.http)
    const asset = os === 'win32' ? release.windows : release.linuxTarGz
    if (asset && asset.sha256 === null && !allowUnverified) {
      throw new AppError('INSTALL_FAILED', { reason: 'no-digest' }, { detail: asset.name })
    }

    if (os === 'win32') {
      const current = await locator.detect()
      await installWindows(
        ctx,
        { release, desktopIcons, customDir: dir, current, beforeInstall: refuseIfRunning },
        task,
      )
    } else {
      // An update of a copy the app installed in a folder of the user's choice stays in that folder.
      const current = dir === null ? await locator.detect() : null
      const targetRoot = dir ?? (current?.kind === 'linux-targz' ? path.dirname(current.root) : null)
      const installed = await installLinux(
        ctx,
        { release, ...(targetRoot === null ? {} : { targetRoot }), locator, beforeInstall: refuseIfRunning },
        task,
      )
      // A folder of the user's choice: detection must look there first.
      if (dir !== null) ctx.config.updateInternal({ apPathOverride: installed.root })
    }

    task.progress('detect', null)
    locator.invalidate()
    const detected = await locator.detect()
    if (!detected)
      throw new AppError('AP_NOT_INSTALLED', undefined, { detail: 'nothing found after the install' })
    ctx.bus.emit('worlds:changed', null)
    ctx.bus.emit('ap:installed', detected)
    return detected
  }

  async function uninstall(purgeUserData: boolean, task: TaskHandle): Promise<null> {
    throwIfCancelled(task.signal)
    const current = await locator.detect()
    if (!current) throw new AppError('AP_NOT_INSTALLED')
    const remove =
      os === 'win32' && current.kind === 'windows-installer'
        ? uninstallWindows
        : os === 'linux' && (current.kind === 'linux-managed' || current.kind === 'linux-targz')
          ? uninstallLinux
          : null
    if (!remove) {
      throw new AppError('INVALID_INPUT', undefined, {
        detail: `the app does not uninstall a ${current.kind} install`,
      })
    }
    await refuseIfRunning()
    task.progress('uninstall', null)
    await remove(ctx, current, { purgeUserData })
    // Detection no longer looks in a folder the app emptied.
    if (current.kind === 'linux-targz') ctx.config.updateInternal({ apPathOverride: null })
    locator.invalidate()
    ctx.bus.emit('worlds:changed', null)
    return null
  }

  return {
    latest: (force = false) => fetchLatestApRelease(ctx.http, { force }),

    install: ({ desktopIcons, customDir, allowUnverified = false }) =>
      ctx.tasks.start('ap-install', (task) =>
        exclusive(() => install(desktopIcons, customDir, allowUnverified, task)),
      ),

    uninstall: ({ purgeUserData }) =>
      ctx.tasks.start('ap-uninstall', (task) => exclusive(() => uninstall(purgeUserData, task))),
  }
}
