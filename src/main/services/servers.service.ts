// The `servers` service (Task 16): the local servers of the sessions. Eager, so that from startup the
// servers are stopped with /exit on quit (early phase, before the late kill of what is left), a
// running server holds the window close, a session whose server runs cannot be deleted, and the
// servers a crash of the app left running are found again. A start waits for no generation: it is
// refused while one of its session runs.
import { createServerManager, type ServerManager } from '@main/core/ap/server'
// The `locator`, `sessions` and `settings` entries of Services, used below.
import type {} from './generator.service'
import type {} from './locator.service'
import { defineService } from './registry'
import type {} from './sessions.service'
import type {} from './settings.service'

declare module '@main/services/registry' {
  interface Services {
    servers: ServerManager
  }
}

defineService(
  'servers',
  (ctx, get) => {
    const sessions = get('sessions')
    const servers = createServerManager(ctx, {
      sessions,
      // Resolved on the first start: the settings service is not needed before.
      settings: { makeSessionSettings: (dir, entries) => get('settings').makeSessionSettings(dir, entries) },
      locator: get('locator'),
      // Looked up at each start: the generator is created on its first use (nothing generates before).
      isGenerating: (id) => get('generator').isGenerating(id),
    })
    sessions.addBusyCheck((id) => servers.isBusy(id))
    ctx.lifecycle.onBeforeQuit(() => servers.disposeAll(), { phase: 'early' })
    ctx.lifecycle.onCloseRequested(() => ({ servers: servers.running(), tasks: [] }))
    void servers.reconcile()
    return servers
  },
  { eager: true },
)
