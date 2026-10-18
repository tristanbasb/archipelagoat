// The `checks` service: how many checks each game can have, from the datapackage of archipelago.gg
// and from the games the app generated itself.
import { createCheckEstimates, type CheckEstimates } from '@main/core/checks/datapackage'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    checks: CheckEstimates
  }
}

defineService('checks', (ctx) => createCheckEstimates(ctx), { eager: false })
