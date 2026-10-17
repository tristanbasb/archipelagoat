// The `sessions` service (Task 14): the organizer's games, their player files, rules, passwords and
// validation.
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import {
  buildValidationContext,
  createSessionValidator,
  resolveRomNeeds,
  type RomNeedDeps,
  type SessionValidator,
  type ValidationContextDeps,
} from '@main/core/sessions/validate-session'
import type { RomNeed } from '@shared/types'
// The `catalog`, `locator`, `settings`, `templates`, `vault` and `worlds` entries of Services, used below.
import type {} from './catalog.service'
import type {} from './locator.service'
import { defineService } from './registry'
import type {} from './settings.service'
import type {} from './templates.service'
import type {} from './vault.service'
import type {} from './worlds.service'

export interface Sessions extends SessionStore, SessionValidator {
  /** The ROMs the generation of these games needs, resolved by the vault (Task 16 asks before a start). */
  resolveRomNeeds(games: readonly string[]): Promise<RomNeed[]>
  /**
   * Adds a check `delete` asks first: a session one check calls busy is refused with AP_RUNNING (the
   * servers service: a local server of that session runs).
   */
  addBusyCheck(check: (id: string) => boolean): void
}

declare module '@main/services/registry' {
  interface Services {
    sessions: Sessions
  }
}

defineService(
  'sessions',
  (ctx, get) => {
    // Resolved on use: listing or renaming a session never starts the locator, the worlds or the vault.
    const validation: ValidationContextDeps = {
      locator: { detect: () => get('locator').detect() },
      worlds: {
        installedGames: () => get('worlds').installedGames(),
        unknownWorlds: () => get('worlds').unknownWorlds(),
      },
      templates: { getSchema: (game) => get('templates').getSchema(game) },
      settings: { get: (path) => get('settings').get(path) },
      log: ctx.log,
    }
    const vault: RomNeedDeps['vault'] = {
      resolveRomForEntry: (entry, md5s) => get('vault').resolveRomForEntry(entry, md5s),
    }
    const busyChecks: ((id: string) => boolean)[] = []
    const store = createSessionStore(ctx, {
      validationContext: (games, plando) => buildValidationContext(validation, games, plando),
      isBusy: (id) => busyChecks.some((check) => check(id)),
    })
    const validator = createSessionValidator(store, {
      ...validation,
      catalog: { lookupByGame: (game) => get('catalog').lookupByGame(game) },
      vault,
    })
    return {
      ...store,
      ...validator,
      resolveRomNeeds: (games) => resolveRomNeeds(games, { vault }),
      addBusyCheck: (check) => void busyChecks.push(check),
    }
  },
  { eager: false },
)
