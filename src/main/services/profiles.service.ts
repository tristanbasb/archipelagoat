// The `profiles` service: the Découverte, Standard and Complet profiles of each game (spec §3.6). A
// game's profiles are refined in the background, as a `profiles` task that nobody waits for, one game
// at a time: once a world is installed (a custom world that `worlds:changed` finds new, or at another
// version, since the window opened), the first time in a run that an installed game's profiles are
// asked for, and once the templates are generated for a game that had none. A « Jeu prêt » that
// waits for a game's refinement (Ruling 34) joins the one running, or starts it at once: its measures
// go to the foreground while the run waits, and back to the background if that run is cancelled.
import { throwIfCancelled } from '@main/core/ap/install-steps'
import { createLane, type MeasureLane } from '@main/core/checks/measure'
import type { CoreContext } from '@main/core/context'
import { createProfiles, type Profiles } from '@main/core/profiles/profiles'
import { startTracked, type TaskHandle } from '@main/core/tasks'
import { loadedWorldVersion } from '@main/core/worlds/world-version'
import { AppError } from '@shared/errors'
import type { GameProfiles } from '@shared/types'
// The `checks`, `locator` and `templates` entries of Services, used below.
import type {} from './checks.service'
import type {} from './locator.service'
import { defineService } from './registry'
import type {} from './templates.service'
import { installedGamesOf, type Worlds } from './worlds.service'

declare module '@main/services/registry' {
  interface Services {
    profiles: ProfilesService
  }
}

export interface ProfilesService extends Profiles {
  /**
   * Refines `game` for a « Jeu prêt » that waits for it, with the refinement's stages reported to
   * `task`: the game's refinement running is joined, else one starts at once (whatever game the
   * background refines), its measures in the foreground while a task waits for it. A joined one that
   * no longer holds once over (the world or the option schema changed meanwhile) is followed by one
   * for the game as it is now. Resolves with the game's profiles then, `measured` only when they
   * hold. Rejects as the refinement does, or with TASK_CANCELLED once `task` is cancelled: the
   * refinement then goes on in the background, at background priority, and keeps its profiles.
   */
  refineNow(game: string, task: TaskHandle): Promise<GameProfiles>
}

export interface ProfilesServiceDeps {
  profiles: Profiles
  worlds: Pick<Worlds, 'list'>
  /** As ProfilesDeps.worldVersion: null for a game Archipelago does not load. */
  worldVersion: (game: string) => Promise<string | null>
}

/** A game's refinement running, as a `profiles` task. */
interface Run {
  /** Refine the game again once done: its world changed meanwhile. */
  again: boolean
  /** The priority of its measures: foreground while a « Jeu prêt » waits for it. */
  lane: ReturnType<typeof createLane>
  /** The tasks of the « Jeu prêt » runs waiting for it: they get its progress. */
  waiters: Set<TaskHandle>
  /** Its last progress, which a task that joins it gets at once. */
  last: Parameters<TaskHandle['progress']> | null
  /**
   * Settles as it does, once it is over (out of `runs`, its game queued again if `again`);
   * TASK_CANCELLED when its task is cancelled before it starts.
   */
  done: Promise<GameProfiles>
}

/**
 * `deps.profiles`, whose `get` also starts refining an installed game that is not measured yet, and
 * whose `refineNow` refines a game for a « Jeu prêt ».
 */
export function createProfilesService(ctx: CoreContext, deps: ProfilesServiceDeps): ProfilesService {
  const { profiles } = deps
  /** The games refined, waiting or being refined in this run: asking for them again refines nothing. */
  const asked = new Set<string>()
  /** The games whose refinement found no option schema: tried again once the templates are generated. */
  const noSchema = new Set<string>()
  /** The games waiting to be refined, in order. */
  const waiting: string[] = []
  /**
   * The refinements running, by game: one at a time in the background, besides those a « Jeu prêt »
   * started meanwhile.
   */
  const runs = new Map<string, Run>()

  async function refineLogged(game: string, task: TaskHandle, lane: MeasureLane): Promise<GameProfiles> {
    try {
      const refined = await profiles.refine(game, task, lane)
      noSchema.delete(game)
      return refined
    } catch (error) {
      if (error instanceof AppError && error.code === 'CHECKS_NO_SCHEMA') {
        // A world just installed has no template yet (installing writes none): no reason to give up.
        asked.delete(game)
        noSchema.add(game)
      }
      // Ruling 23: a failure is logged and never toasted; the profiles stay heuristic (« non mesuré »),
      // which a « Jeu prêt » waiting for them says on its end screen.
      if (!(error instanceof AppError && error.code === 'TASK_CANCELLED')) {
        ctx.log.warn('profiles: refinement failed', { game, error: String(error) })
      }
      throw error
    }
  }

  /** Starts refining `game` as a `profiles` task, at background priority. */
  function start(game: string): Run {
    const done = Promise.withResolvers<GameProfiles>()
    // Nobody may wait for it: its waiters handle its failure.
    done.promise.catch(() => undefined)
    const run: Run = {
      again: false,
      lane: createLane('background'),
      waiters: new Set(),
      last: null,
      done: done.promise,
    }
    runs.set(game, run)
    /** How its refinement ended; null for a task cancelled before it started. */
    let ended: PromiseSettledResult<GameProfiles> | null = null
    startTracked(
      ctx.tasks,
      ctx.bus,
      'profiles',
      (task) => {
        const relay: TaskHandle = {
          id: task.id,
          signal: task.signal,
          progress: (...report) => {
            task.progress(...report)
            run.last = report
            for (const waiter of run.waiters) waiter.progress(...report)
          },
          log: (stream, line) => task.log(stream, line),
        }
        return refineLogged(game, relay, run.lane).then(
          (value) => {
            ended = { status: 'fulfilled', value }
            return value
          },
          (reason: unknown) => {
            ended = { status: 'rejected', reason }
            throw reason
          },
        )
      },
      () => {
        runs.delete(game)
        if (run.again && !waiting.includes(game)) waiting.push(game)
        startNext()
        // Its waiters go on only now: the refinement that follows it, if any, is known.
        if (ended?.status === 'fulfilled') done.resolve(ended.value)
        else done.reject(ended === null ? new AppError('TASK_CANCELLED') : ended.reason)
      },
    )
    return run
  }

  /** Starts refining the next game waiting, unless a game is being refined. */
  function startNext(): void {
    const game = runs.size === 0 ? waiting.shift() : undefined
    if (game !== undefined) start(game)
  }

  function refineInBackground(game: string): void {
    asked.add(game)
    const run = runs.get(game)
    if (run) run.again = true
    else if (!waiting.includes(game)) waiting.push(game)
    startNext()
  }

  /** `run`'s profiles, for `task` that waits for them: its measures go to the foreground meanwhile. */
  function join(run: Run, task: TaskHandle): Promise<GameProfiles> {
    run.waiters.add(task)
    run.lane.set('foreground')
    if (run.last) task.progress(...run.last)
    const cancelled = Promise.withResolvers<never>()
    const cancel = (): void => cancelled.reject(new AppError('TASK_CANCELLED'))
    task.signal.addEventListener('abort', cancel, { once: true })
    return Promise.race([run.done, cancelled.promise]).finally(() => {
      task.signal.removeEventListener('abort', cancel)
      run.waiters.delete(task)
      // Nobody waits for it any more: it goes on in the background.
      if (run.waiters.size === 0) run.lane.set('background')
    })
  }

  // --- the worlds installed ---

  /**
   * The custom worlds Archipelago loads: game → version (its file's for one without world_version,
   * read now: the file may be replaced later); null when they could not be listed.
   */
  const customGames = (): Promise<Map<string, string | null> | null> =>
    deps.worlds.list().then(
      async (worlds) => {
        const games = installedGamesOf(worlds.filter((world) => world.location === 'custom'))
        const versions = [...games.keys()].map(
          async (game) => [game, await loadedWorldVersion(games, game, null)] as const,
        )
        return new Map(await Promise.all(versions))
      },
      (error: unknown) => {
        ctx.log.warn('profiles: cannot list the worlds', error)
        return null
      },
    )
  /** The custom worlds as they were at the last look; null before the window opens. */
  let known: Promise<Map<string, string | null> | null> | null = null
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
      for (const [game, version] of now) {
        if (!was.has(game) || was.get(game) !== version) refineInBackground(game)
      }
    })
  })
  // Archipelago installed anew: its own worlds may be at another version.
  ctx.bus.on('ap:installed', () => asked.clear())
  // The templates generated (a « Jeu prêt » generates them within its own task): the games that had
  // none may have one now.
  ctx.bus.on('task:done', ({ kind }) => {
    if (kind !== 'templates' && kind !== 'ready') return
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

    async refineNow(game, task) {
      throwIfCancelled(task.signal)
      asked.add(game)
      const joined = runs.get(game)
      if (joined) {
        try {
          await join(joined, task)
        } catch (error) {
          throwIfCancelled(task.signal)
          // Failed on a world replaced meanwhile: the one installed now may refine.
          if (!joined.again) throw error
        }
        const now = await profiles.get(game)
        if (now.measured) return now
        // Refined for a world version or an option schema that changed since: refined again below.
      }
      // Refined now rather than in its turn (the refinement a world change queued included).
      const queued = waiting.indexOf(game)
      if (queued !== -1) waiting.splice(queued, 1)
      await join(runs.get(game) ?? start(game), task)
      return profiles.get(game)
    },
  }
}

defineService(
  'profiles',
  (ctx, get) => {
    // Resolved on use: nothing is detected nor scanned before a profile is asked for or a world changes.
    // A core world has no version of its own: Archipelago's.
    const worldVersion = async (game: string): Promise<string | null> =>
      loadedWorldVersion(
        await get('worlds').installedGames(),
        game,
        (await get('locator').detect())?.version ?? null,
      )
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
