// The `worlds` service: inventory and installation of APWorlds (Task 10), from the catalog too (Task 11),
// and the games Archipelago loads, cached for the validations (Studio, sessions).
import { stat } from 'node:fs/promises'
import type { CoreContext } from '@main/core/context'
import { createWorldInstaller, type WorldInstaller, type WorldInstallerDeps } from '@main/core/worlds/install'
import { disabledWorldsDir } from '@main/core/worlds/inventory'
import type { ValidationContext } from '@main/core/yaml/validate'
import type { ApInstall, WorldInfo, WorldState } from '@shared/types'
import { defineService } from './registry'
// The `catalog`, `locator` and `processes` entries of Services, used below.
import type {} from './catalog.service'
import type {} from './locator.service'
import type {} from './processes.service'

export type InstalledGames = ValidationContext['installedGames']

export interface Worlds extends WorldInstaller {
  /**
   * Game → world_version of the world Archipelago loads for it, core games included (from the table
   * of the version for an AppImage). Empty without Archipelago. A copy of a cache dropped on
   * `worlds:changed` and `ap:installed`, and when the install or its world folders change.
   */
  installedGames(): Promise<InstalledGames>
}

declare module '@main/services/registry' {
  interface Services {
    worlds: Worlds
  }
}

/** The states of a world Archipelago does not load: its game is not installed. */
const NOT_LOADED: ReadonlySet<WorldState> = new Set(['disabled', 'corrupt', 'incompatible'])

/** Game → version of the world Archipelago loads for it (a shadowed one only when it is alone). */
export function installedGamesOf(worlds: readonly WorldInfo[]): InstalledGames {
  const games: InstalledGames = new Map()
  const loaded = worlds.filter((world) => world.game !== null && !world.states.some((s) => NOT_LOADED.has(s)))
  const winnersFirst = [
    ...loaded.filter((world) => !world.states.includes('shadowed')),
    ...loaded.filter((world) => world.states.includes('shadowed')),
  ]
  for (const world of winnersFirst) {
    if (world.game !== null && !games.has(world.game)) {
      games.set(world.game, { worldVersion: world.manifest?.worldVersion ?? null })
    }
  }
  return games
}

export function createWorlds(ctx: CoreContext, deps: WorldInstallerDeps): Worlds {
  const installer = createWorldInstaller(ctx, deps)
  const disabledDir = disabledWorldsDir(ctx.platform.paths.dataRoot)
  let cache: { key: string; games: Promise<InstalledGames> } | null = null
  const drop = (): void => {
    cache = null
  }
  ctx.bus.on('worlds:changed', drop)
  ctx.bus.on('ap:installed', drop)

  /**
   * What the cached answer depends on: the install, and the modification times of the folders
   * Archipelago scans, which move when a world is added or removed outside the app.
   */
  async function keyOf(install: ApInstall): Promise<string> {
    const folders = [install.paths.customWorlds, install.paths.coreWorlds, disabledDir].filter(Boolean)
    const times = await Promise.all(
      folders.map((dir) =>
        stat(dir).then(
          (info) => String(info.mtimeMs),
          () => 'none',
        ),
      ),
    )
    return JSON.stringify([install.root, install.version, install.paths.customWorlds, ...times])
  }

  return {
    ...installer,

    async installedGames() {
      const install = await deps.locator.detect()
      if (!install) return new Map()
      const key = await keyOf(install)
      let entry = cache
      if (entry?.key !== key) {
        const fresh = { key, games: installer.list().then(installedGamesOf) }
        entry = cache = fresh
        // A failed scan is asked again next time.
        void fresh.games.catch(() => {
          if (cache === fresh) cache = null
        })
      }
      return new Map(await entry.games)
    },
  }
}

defineService(
  'worlds',
  (ctx, get) =>
    createWorlds(ctx, {
      locator: get('locator'),
      // Asked when a catalog source is prepared: the catalog is created on first use.
      lookupCatalog: (id) => get('catalog').lookup(id),
      listProcesses: () => get('processes').list(),
    }),
  { eager: false },
)
