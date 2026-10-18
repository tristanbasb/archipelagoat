// The `worlds` service: inventory and installation of APWorlds (Task 10), from the catalog too (Task 11),
// and the games Archipelago loads, cached for the validations (Studio, sessions).
import { stat } from 'node:fs/promises'
import type { CoreContext } from '@main/core/context'
import { createWorldInstaller, type WorldInstaller, type WorldInstallerDeps } from '@main/core/worlds/install'
import { disabledWorldsDir, NOT_LOADED_STATES } from '@main/core/worlds/inventory'
import { resolveWikiRelease } from '@main/core/worlds/wiki-release'
import type { ValidationContext } from '@main/core/yaml/validate'
import type { ApInstall, WorldInfo } from '@shared/types'
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
  /**
   * The modules of the custom worlds Archipelago loads whose game cannot be read without running
   * them (no manifest game, none in their code): any game may be theirs. Same cache.
   */
  unknownWorlds(): Promise<string[]>
}

declare module '@main/services/registry' {
  interface Services {
    worlds: Worlds
  }
}

const isLoaded = (world: WorldInfo): boolean => !world.states.some((s) => NOT_LOADED_STATES.has(s))

/**
 * Game → version of the world Archipelago loads for it (a shadowed one only when it is alone), and the
 * file of a custom one.
 */
export function installedGamesOf(worlds: readonly WorldInfo[]): InstalledGames {
  const games: InstalledGames = new Map()
  const loaded = worlds.filter((world) => world.game !== null && isLoaded(world))
  const winnersFirst = [
    ...loaded.filter((world) => !world.states.includes('shadowed')),
    ...loaded.filter((world) => world.states.includes('shadowed')),
  ]
  for (const world of winnersFirst) {
    if (world.game !== null && !games.has(world.game)) {
      games.set(world.game, {
        worldVersion: world.manifest?.worldVersion ?? null,
        ...(world.location === 'custom' ? { file: world.path } : {}),
      })
    }
  }
  return games
}

/** The custom worlds Archipelago loads whose game nothing tells (see Worlds.unknownWorlds). */
export function unknownWorldsOf(worlds: readonly WorldInfo[]): string[] {
  return worlds.filter((w) => w.location === 'custom' && w.game === null && isLoaded(w)).map((w) => w.module)
}

export function createWorlds(ctx: CoreContext, deps: WorldInstallerDeps): Worlds {
  const installer = createWorldInstaller(ctx, deps)
  const disabledDir = disabledWorldsDir(ctx.platform.paths.dataRoot)
  let cache: { key: string; scan: Promise<{ games: InstalledGames; unknown: string[] }> } | null = null
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

  /** The cached scan of the current install; null without Archipelago. */
  async function scan(): Promise<{ games: InstalledGames; unknown: string[] } | null> {
    const install = await deps.locator.detect()
    if (!install) return null
    const key = await keyOf(install)
    let entry = cache
    if (entry?.key !== key) {
      const fresh = {
        key,
        scan: installer.list().then((worlds) => ({
          games: installedGamesOf(worlds),
          unknown: unknownWorldsOf(worlds),
        })),
      }
      entry = cache = fresh
      // A failed scan is asked again next time.
      void fresh.scan.catch(() => {
        if (cache === fresh) cache = null
      })
    }
    return entry.scan
  }

  return {
    ...installer,

    async installedGames() {
      return new Map((await scan())?.games)
    },

    async unknownWorlds() {
      return [...((await scan())?.unknown ?? [])]
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
      resolveWikiRelease: (repo, game, pageUrl) => resolveWikiRelease(ctx.http, repo, game, pageUrl),
      listProcesses: () => get('processes').list(),
    }),
  { eager: false },
)
