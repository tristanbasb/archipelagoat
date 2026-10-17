// The `generator` service: a session's generation, run as a task (Task 15).
import { createGenerator, type Generator } from '@main/core/ap/generate'
// The `locator`, `servers`, `sessions` and `settings` entries of Services, used below.
import type {} from './locator.service'
import { defineService } from './registry'
import type {} from './servers.service'
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
    createGenerator(ctx, {
      sessions: get('sessions'),
      settings: get('settings'),
      locator: get('locator'),
      // The servers service also sees the orphan server a previous run of the app left running, as
      // the web hosting's check does (Task 17). Looked up at each check.
      isServing: (id) => get('servers').isBusy(id),
    }),
  { eager: false },
)
