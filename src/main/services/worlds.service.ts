// The `worlds` service: inventory and installation of APWorlds (Task 10), from the catalog too (Task 11).
import { createWorldInstaller, type WorldInstaller } from '@main/core/worlds/install'
import { defineService } from './registry'
// The `catalog`, `locator` and `processes` entries of Services, used below.
import type {} from './catalog.service'
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
      // Asked when a catalog source is prepared: the catalog is created on first use.
      lookupCatalog: (id) => get('catalog').lookup(id),
      listProcesses: () => get('processes').list(),
    }),
  { eager: false },
)
