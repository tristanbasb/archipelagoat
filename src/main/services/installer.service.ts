// The `installer` service: install, update and uninstall of Archipelago (Task 9).
import { createInstallService, type InstallService } from '@main/core/ap/install-service'
import { defineService } from './registry'
// The `locator` and `processes` entries of Services, used below.
import type {} from './locator.service'
import type {} from './processes.service'

declare module '@main/services/registry' {
  interface Services {
    installer: InstallService
  }
}

defineService(
  'installer',
  (ctx, get) =>
    createInstallService(ctx, {
      locator: get('locator'),
      listProcesses: () => get('processes').list(),
    }),
  { eager: false },
)
