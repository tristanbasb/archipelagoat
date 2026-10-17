// The `join` service (Task 20): joining a room, an address or a patch, and launching its client.
import { createJoin, type Join } from '@main/core/play/join'
import { defineService } from './registry'
// The `bizhawk`, `locator`, `settings`, `vault` and `worlds` entries of Services, used below.
import type {} from './bizhawk.service'
import type {} from './locator.service'
import type {} from './settings.service'
import type {} from './vault.service'
import type {} from './worlds.service'

declare module '@main/services/registry' {
  interface Services {
    join: Join
  }
}

defineService(
  'join',
  (ctx, get) =>
    createJoin(ctx, {
      locator: get('locator'),
      settings: get('settings'),
      vault: get('vault'),
      bizhawk: get('bizhawk'),
      // Resolved on use: the worlds service is created when a checklist first needs it.
      installedGames: () => get('worlds').installedGames(),
    }),
  { eager: false },
)
