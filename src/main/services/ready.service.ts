// The `ready` service: « Jeu prêt », from a catalog entry to a player YAML delivered (spec §3.7).
import { createReady, type Ready } from '@main/core/ready/ready'
import { buildValidationContext } from '@main/core/sessions/validate-session'
// The `catalog`, `checks`, `locator`, `pickedPaths`, `processes`, `profiles`, `sessions`, `settings`,
// `templates` and `worlds` entries of Services, used below.
import type {} from './catalog.service'
import type {} from './checks.service'
import type {} from './locator.service'
import type {} from './picked-paths.service'
import type {} from './processes.service'
import type {} from './profiles.service'
import { defineService } from './registry'
import type {} from './sessions.service'
import type {} from './settings.service'
import type {} from './templates.service'
import type {} from './worlds.service'

declare module '@main/services/registry' {
  interface Services {
    ready: Ready
  }
}

defineService(
  'ready',
  (ctx, get) =>
    // Resolved on use: a plan starts nothing it does not need.
    createReady(ctx, {
      catalog: { lookup: (id) => get('catalog').lookup(id) },
      locator: { detect: () => get('locator').detect() },
      worlds: {
        prepare: (source, task) => get('worlds').prepare(source, task),
        confirm: (planId) => get('worlds').confirm(planId),
        installedGames: () => get('worlds').installedGames(),
      },
      templates: {
        getSchema: (game) => get('templates').getSchema(game),
        regenerate: (task) => get('templates').regenerate(task),
      },
      // The service's own `get`: asking for an installed game's profiles refines them in the background.
      profiles: {
        get: (game) => get('profiles').get(game),
        yamlFor: (game, profile, playerName) => get('profiles').yamlFor(game, profile, playerName),
      },
      // With the measurer's cache, in the foreground.
      measurer: { measureDoc: (input) => get('checks').measurer.measureDoc(input) },
      sessions: {
        list: () => get('sessions').list(),
        create: (name) => get('sessions').create(name),
        addText: (id, fileName, text) => get('sessions').addText(id, fileName, text),
      },
      // The files app:savePath gave.
      pickedPaths: { has: (path) => get('pickedPaths').has(path) },
      // The Studio's validation.
      validationContext: (games) =>
        buildValidationContext(
          {
            locator: { detect: () => get('locator').detect() },
            worlds: {
              installedGames: () => get('worlds').installedGames(),
              unknownWorlds: () => get('worlds').unknownWorlds(),
            },
            templates: { getSchema: (game) => get('templates').getSchema(game) },
            settings: { get: (path) => get('settings').get(path) },
            log: ctx.log,
          },
          games,
          null,
        ),
      listProcesses: () => get('processes').list(),
    }),
  { eager: false },
)
