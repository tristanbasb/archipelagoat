// The `webhost` service (Task 17): hosting on archipelago.gg and the rooms it opened.
import { createWebhostService, type WebhostService } from '@main/core/webhost/rooms'
import { defineService } from './registry'
// The `servers` and `sessions` entries of Services, used below.
import type {} from './servers.service'
import type {} from './sessions.service'

declare module '@main/services/registry' {
  interface Services {
    webhost: WebhostService
  }
}

defineService(
  'webhost',
  (ctx, get) => createWebhostService(ctx, { sessions: () => get('sessions'), servers: () => get('servers') }),
  { eager: false },
)
