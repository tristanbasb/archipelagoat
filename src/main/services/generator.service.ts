// The `generator` service: a session's generation, run as a task (Task 15).
import { createGenerator, type Generator } from '@main/core/ap/generate'
// The `locator`, `sessions` and `settings` entries of Services, used below.
import type {} from './locator.service'
import { defineService } from './registry'
import type {} from './sessions.service'
import type {} from './settings.service'

declare module '@main/services/registry' {
  interface Services {
    generator: Generator
  }
}

defineService(
  'generator',
  (ctx, get) =>
    createGenerator(ctx, { sessions: get('sessions'), settings: get('settings'), locator: get('locator') }),
  { eager: false },
)
