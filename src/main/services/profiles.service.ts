// The `profiles` service: the Découverte, Standard and Complet profiles of each game (spec §3.6). A
// game's profiles are refined in the background, as a `profiles` task that nobody waits for, one game
// at a time: once a world is installed (a custom world that `worlds:changed` finds new, or at another
// version, since the window opened), the first time in a run that an installed game's profiles are
// asked for, and once the templates are generated for a game that had none.
import type { CoreContext } from '@main/core/context'
import { createProfiles, type Profiles } from '@main/core/profiles/profiles'
import { startTracked, type TaskHandle } from '@main/core/tasks'
import { AppError } from '@shared/errors'
import type { GameProfiles } from '@shared/types'
// The `checks`, `locator` and `templates` entries of Services, used below.
import type {} from './checks.service'
import type {} from './locator.service'
import { defineService } from './registry'
import type {} from './templates.service'
import { installedGamesOf, type InstalledGames, type Worlds } from './worlds.service'

declare module '@main/services/registry' {
  interface Services {
    profiles: Profiles
  }
}

export interface ProfilesServiceDeps {
  profiles: Profiles
  worlds: Pick<Worlds, 'list'>
  /** As ProfilesDeps.worldVersion: null for a game Archipelago does not load. */
  worldVersion: (game: string) => Promise<string | null>
}

/** `deps.profiles`, whose `get` also starts refining an installed game that is not measured yet. */
export function createProfilesService(ctx: CoreContext, deps: ProfilesServiceDeps): Profiles {
  const { profiles } = deps
  /** The games refined, waiting or being refined in this run: asking for them again refines nothing. */
  const asked = new Set<string>()
  /** The games whose refinement found no option schema: tried again once the templates are generated. */
  const noSchema = new Set<string>()
  /** The games waiting to be refined, in order. */
  const waiting: string[] = []
  /** The game being refined, and whether to refine it again once done (its world changed meanwhile). */
  let current: { game: string; again: boolean } | null = null

  async function refineLogged(game: string, task: TaskHandle): Promise<GameProfiles> {
    try {
      const refined = await profiles.refine(game, task)
      noSchema.delete(game)
      return refined
    } catch (error) {
      if (error instanceof AppError && error.code === 'CHECKS_NO_SCHEMA') {
        // A world just installed has no template yet (installing writes none): no reason to give up.
        asked.delete(game)
        noSchema.add(game)
      }
      // Ruling 23: nobody waits for it, so a failure is logged and never shown; the profiles stay
      // heuristic (« non mesuré »).
      if (!(error instanceof AppError && error.code === 'TASK_CANCELLED')) {
        ctx.log.warn('profiles: refinement failed', { game, error: String(error) })
      }
      throw error
    }
  }

  /** Starts refining the next game waiting, unless one is being refined. */
  function startNext(): void {
    const game = current === null ? waiting.shift() : undefined
    if (game === undefined) return
    const run = { game, again: false }
    current = run
    startTracked(
      ctx.tasks,
      ctx.bus,
      'profiles',
      (task) => refineLogged(game, task),
      () => {
        current = null
        if (run.again && !waiting.includes(game)) waiting.push(game)
        startNext()
      },
    )
  }

  function refineInBackground(game: string): void {
    asked.add(game)
    if (current?.game === game) current.again = true
    else if (!waiting.includes(game)) waiting.push(game)
    startNext()
  }

  // --- the worlds installed ---

  /** The custom worlds Archipelago loads, by game; null when they could not be listed. */
  const customGames = (): Promise<InstalledGames | null> =>
    deps.worlds.list().then(
      (worlds) => installedGamesOf(worlds.filter((world) => world.location === 'custom')),
      (error: unknown) => {
        ctx.log.warn('profiles: cannot list the worlds', error)
        return null
      },
    )
  /** The custom worlds as they were at the last look; null before the window opens. */
  let known: Promise<InstalledGames | null> | null = null
  ctx.lifecycle.onWindowReady(() => {
    known ??= customGames()
  })
  ctx.bus.on('worlds:changed', () => {
    const before = known
    const after = customGames()
    known = after
    if (before === null) return
    void Promise.all([before, after]).then(([was, now]) => {
      if (was === null || now === null) return
      for (const [game, { worldVersion }] of now) {
        if (!was.has(game) || was.get(game)?.worldVersion !== worldVersion) refineInBackground(game)
      }
    })
  })
  // Archipelago installed anew: its own worlds may be at another version.
  ctx.bus.on('ap:installed', () => asked.clear())
  // The templates generated: the games that had none may have one now.
  ctx.bus.on('task:done', ({ kind }) => {
    if (kind !== 'templates') return
    const games = [...noSchema]
    noSchema.clear()
    for (const game of games) refineInBackground(game)
  })

  return {
    ...profiles,
    async get(game) {
      const found = await profiles.get(game)
      if (!found.measured && !asked.has(game)) {
        // Only a game Archipelago loads can be measured: it counts as asked once that is known.
        void deps.worldVersion(game).then(
          (version) => {
            if (version !== null && !asked.has(game)) refineInBackground(game)
          },
          (error: unknown) => ctx.log.warn('profiles: cannot tell the world version', { game, error }),
        )
      }
      return found
    },
  }
}

defineService(
  'profiles',
  (ctx, get) => {
    // Resolved on use: nothing is detected nor scanned before a profile is asked for or a world changes.
    const worldVersion = async (game: string): Promise<string | null> => {
      const installed = await get('worlds').installedGames()
      if (!installed.has(game)) return null
      // A core world has no version of its own: Archipelago's.
      return installed.get(game)?.worldVersion ?? (await get('locator').detect())?.version ?? null
    }
    return createProfilesService(ctx, {
      profiles: createProfiles(ctx, {
        templates: { getSchema: (game) => get('templates').getSchema(game) },
        // With the measurer's cache and its limit of two test generations at once.
        measurer: { measureDoc: (input) => get('checks').measurer.measureDoc(input) },
        worldVersion,
      }),
      worlds: { list: () => get('worlds').list() },
      worldVersion,
    })
  },
  // Eager: a world installed before any profile is asked for is refined too.
  { eager: true },
)
