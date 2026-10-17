// The `openRequests` service (Task 21): archipelago:// links and files opened with the app. Eager, so
// that it reads the launch argv and listens to second launches from startup.
import { createOpenRequests, type OpenRequests } from '@main/core/system/open-requests'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    openRequests: OpenRequests
  }
}

defineService(
  'openRequests',
  (ctx) =>
    createOpenRequests({
      bus: ctx.bus,
      lifecycle: ctx.lifecycle,
      // Outside Electron (the unit tests run the services under Node) there is no launch argv to honour.
      argv: process.versions.electron ? process.argv : [],
      defaultApp: process.defaultApp === true,
    }),
  { eager: true },
)
