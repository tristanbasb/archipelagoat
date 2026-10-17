// The `processes` service, eager so that its hooks exist from startup: the children still running are
// killed on quit (late phase, after the servers' /exit), and the orphans of a previous run that are
// not servers are killed at startup (the server manager offers to stop orphaned servers).
import { createProcesses, type ProcessesService } from '@main/core/ap/processes'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    processes: ProcessesService
  }
}

defineService('processes', (ctx) => createProcesses(ctx), { eager: true })
