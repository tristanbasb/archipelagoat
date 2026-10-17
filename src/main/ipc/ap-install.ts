// ap:latestRelease, ap:install and ap:uninstall: the official release of Archipelago and its install.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerApInstallHandlers(
  register: RegisterHandler,
  services: ServiceContainer,
): void {
  const installer = (): ReturnType<typeof services.get<'installer'>> => services.get('installer')

  register('ap:latestRelease', ({ force }) => installer().latest(force ?? false))

  // Tasks: the custom folder is checked by the task itself, before anything else runs.
  register('ap:install', ({ desktopIcons, customDir }) =>
    Promise.resolve(installer().install({ desktopIcons, customDir: customDir ?? null })),
  )

  register('ap:uninstall', ({ purgeUserData }) => Promise.resolve(installer().uninstall({ purgeUserData })))
}
