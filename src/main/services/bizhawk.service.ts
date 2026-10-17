// The `bizhawk` service: the emulator behind the one-click games (Task 19).
import { createBizhawk, type Bizhawk } from '@main/core/play/bizhawk'
// The `settings` entry of Services, which this service uses.
import type {} from './settings.service'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    bizhawk: Bizhawk
  }
}

defineService('bizhawk', (ctx, get) => createBizhawk(ctx, { settings: get('settings') }), { eager: false })
