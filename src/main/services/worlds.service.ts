// The `worlds` service: inventory and installation of APWorlds (Task 10). Task 11 injects the catalog.
import { createWorldInstaller, type WorldInstaller } from '@main/core/worlds/install'
import { defineService } from './registry'
// The `locator` and `processes` entries of Services, used below.
import type {} from './locator.service'
import type {} from './processes.service'

declare module '@main/services/registry' {
  interface Services {
    worlds: WorldInstaller
  }
}

defineService(
  'worlds',
  (ctx, get) =>
    createWorldInstaller(ctx, {
      locator: get('locator'),
      // No catalog yet: a catalog source answers NOT_FOUND.
      lookupCatalog: () => null,
      listProcesses: () => get('processes').list(),
    }),
  { eager: false },
)
