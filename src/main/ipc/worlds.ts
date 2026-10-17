// worlds:* handlers: the installed APWorlds, their installation, switching them off and removing them.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerWorldHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const worlds = (): ReturnType<typeof services.get<'worlds'>> => services.get('worlds')

  register('worlds:list', () => worlds().list())

  // A task: the world may have to be downloaded before it is inspected.
  register('worlds:prepareInstall', ({ source }) =>
    Promise.resolve(services.ctx.tasks.start('world-prepare', (task) => worlds().prepare(source, task))),
  )

  register('worlds:confirmInstall', ({ planId }) => worlds().confirm(planId))

  register('worlds:setEnabled', ({ worldId, enabled }) => worlds().setEnabled(worldId, enabled))

  register('worlds:remove', ({ worldId }) => worlds().remove(worldId))
}
