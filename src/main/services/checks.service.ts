// The `checks` service: how many checks each game can have, from the datapackage of archipelago.gg and
// from the games the app generated itself, and the exact checks of players, from test generations.
import { createCheckEstimates, type CheckEstimates } from '@main/core/checks/datapackage'
import { createMeasurer, type Measurer } from '@main/core/checks/measure'
// The `locator`, `processes`, `sessions`, `settings` and `worlds` entries of Services, used below.
import type {} from './locator.service'
import type {} from './processes.service'
import { defineService } from './registry'
import type {} from './sessions.service'
import type {} from './settings.service'
import type {} from './worlds.service'

export interface Checks {
  estimates: CheckEstimates
  measurer: Measurer
}

declare module '@main/services/registry' {
  interface Services {
    checks: Checks
  }
}

defineService(
  'checks',
  (ctx, get) => {
    const estimates = createCheckEstimates(ctx)
    // Resolved on use: an estimate never starts the sessions, the worlds or the vault.
    const measurer = createMeasurer(ctx, {
      locator: {
        detect: () => get('locator').detect(),
        exe: (install, name) => get('locator').exe(install, name),
      },
      settings: { makeSessionSettings: (dir, entries) => get('settings').makeSessionSettings(dir, entries) },
      sessions: {
        get: (id) => get('sessions').get(id),
        getSecrets: (id) => get('sessions').getSecrets(id),
        loadPlayers: (id) => get('sessions').loadPlayers(id),
      },
      worlds: { installedGames: () => get('worlds').installedGames() },
      romNeeds: (games) => get('sessions').resolveRomNeeds(games),
      estimates,
      // An orphan test generation of the previous run holds its folder until it is killed.
      orphansStopped: get('processes').ready,
    })
    return { estimates, measurer }
  },
  // Eager: the measure folders a previous run left are removed at startup.
  { eager: true },
)
