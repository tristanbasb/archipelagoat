// The `integration` service (Task 21): the Linux desktop entry, and on Windows the archipelago:// handler
// and the .apsml2 association. Eager, so that it hears `ap:installed`: the first install of Archipelago
// the app makes under Linux also installs the desktop entry, when the setting (on by default) says so.
import path from 'node:path'
import type { CoreContext } from '@main/core/context'
import {
  installLinuxIntegration,
  isLinuxIntegrationInstalled,
  linuxDataHome,
  removeLinuxIntegration,
  type ToolsReport,
} from '@main/core/system/integration-linux'
import { setWinAssociations, setWinProtocol, type WinCommand } from '@main/core/system/integration-win'
import { AppError } from '@shared/errors'
import type { AppConfig, IntegrationState } from '@shared/types'
import { defineService } from './registry'

type Flags = AppConfig['integration']
type Feature = keyof Flags

export interface Integration {
  /** Linux: the entry is there (and the setting on); Windows: the settings, which follow each change. */
  state(): Promise<IntegrationState>
  /**
   * Applies each switch given, then saves it. UNSUPPORTED_PLATFORM (nothing applied) for a switch of
   * the other system; INSTALL_FAILED when Windows refuses a change, which then stays unsaved.
   */
  set(patch: Partial<Flags>): Promise<IntegrationState>
}

declare module '@main/services/registry' {
  interface Services {
    integration: Integration
  }
}

export interface IntegrationOptions {
  /** APPIMAGE, APPDIR, XDG_DATA_HOME. Default: process.env. */
  env?: NodeJS.ProcessEnv
  /** Default: process.execPath. */
  execPath?: string
  /** In development, the entry point Electron runs (argv[1]), which every command repeats. */
  entryPoint?: string | null
}

const FEATURES: readonly Feature[] = ['linuxDesktop', 'winProtocol', 'winAssociations']

export function createIntegration(ctx: CoreContext, opts: IntegrationOptions = {}): Integration {
  const { platform, config, log } = ctx
  const { os } = platform
  const env = opts.env ?? process.env
  const execPath = opts.execPath ?? process.execPath
  const args = opts.entryPoint ? [opts.entryPoint] : []
  const dataHome = linuxDataHome(env, platform.paths.home)
  const available: Flags = {
    linuxDesktop: os === 'linux',
    winProtocol: os === 'win32',
    winAssociations: os === 'win32',
  }
  const winCommand: WinCommand = { exe: execPath, args }

  // One change at a time; a read waits for the change before it, so it reports what is on disk.
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  const report = ({ failed }: ToolsReport): void => {
    if (failed.length > 0) log.warn('integration: desktop tools failed', { failed })
  }

  async function installLinux(): Promise<void> {
    report(
      await installLinuxIntegration(ctx.exec, {
        dataHome,
        // In an AppImage, execPath is inside a mount that changes on every launch.
        execPath: env.APPIMAGE || execPath,
        args,
        iconSource: env.APPDIR ? path.join(env.APPDIR, '.DirIcon') : null,
      }),
    )
  }

  async function apply(feature: Feature, on: boolean): Promise<void> {
    if (feature === 'linuxDesktop') {
      if (on) await installLinux()
      else report(await removeLinuxIntegration(ctx.exec, { dataHome }))
    } else if (feature === 'winProtocol') {
      setWinProtocol(platform, on)
    } else {
      await setWinAssociations(ctx.exec, on, winCommand)
    }
    config.updateInternal({ integration: { ...config.get().integration, [feature]: on } })
  }

  async function readState(): Promise<IntegrationState> {
    const flags = config.get().integration
    return {
      linuxDesktop:
        available.linuxDesktop && flags.linuxDesktop && (await isLinuxIntegrationInstalled(dataHome)),
      winProtocol: available.winProtocol && flags.winProtocol,
      winAssociations: available.winAssociations && flags.winAssociations,
      available: { ...available },
    }
  }

  ctx.bus.on('ap:installed', (install) => {
    if (os !== 'linux' || install.kind !== 'linux-managed') return
    void serial(async () => {
      if (!config.get().integration.linuxDesktop || (await isLinuxIntegrationInstalled(dataHome))) return
      await installLinux()
    }).catch((error: unknown) => log.error('integration: cannot install the desktop entry', error))
  })

  return {
    state: () => serial(readState),

    set(patch) {
      return serial(async () => {
        const changes = FEATURES.flatMap((feature) => {
          const on = patch[feature]
          return on === undefined ? [] : [[feature, on] as const]
        })
        const refused = changes.find(([feature]) => !available[feature])
        if (refused) throw new AppError('UNSUPPORTED_PLATFORM', { feature: refused[0] })
        for (const [feature, on] of changes) await apply(feature, on)
        return readState()
      })
    },
  }
}

defineService(
  'integration',
  (ctx) =>
    createIntegration(ctx, {
      entryPoint: process.defaultApp && process.argv[1] ? path.resolve(process.argv[1]) : null,
    }),
  { eager: true },
)
