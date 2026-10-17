// The `vault` service: the ROM vault (Task 18).
import { createVault, type Vault } from '@main/core/play/roms'
import { defineService } from './registry'
// The `locator` and `settings` entries of Services, used below.
import type {} from './locator.service'
import type {} from './settings.service'

declare module '@main/services/registry' {
  interface Services {
    vault: Vault
  }
}

defineService(
  'vault',
  (ctx, get) => createVault(ctx, { settings: get('settings'), locator: get('locator') }),
  { eager: false },
)
