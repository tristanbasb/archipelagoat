// The `settings` service: Archipelago's settings file, read and edited safely (Task 8).
import { createApSettings, type ApSettings } from '@main/core/ap/settings'
// The `locator` entry of Services, which this service uses.
import type {} from './locator.service'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    settings: ApSettings
  }
}

defineService('settings', (ctx, get) => createApSettings(ctx, get('locator')), { eager: false })
