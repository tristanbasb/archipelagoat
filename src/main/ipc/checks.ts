// checks:* handlers: what is known of the size of a game before anything is generated, the exact
// checks of a session's players, and the proposals that balance them.
import type { ServiceContainer } from '@main/services/registry'
// The `checks` and `profiles` entries of Services (the service files are loaded by import.meta.glob at
// run time).
import type {} from '@main/services/checks.service'
import type {} from '@main/services/profiles.service'
import type { ProfileCounts } from '@shared/types'
import type { RegisterHandler } from './registry'

export default function registerCheckHandlers(register: RegisterHandler, services: ServiceContainer): void {
  // The first ask of a run starts the weekly refresh and answers at once with what is on disk:
  // `checks:changed` tells the renderer when the table changed. Later asks never start one, so that a
  // refresh that failed (offline) is not retried at every card.
  let refreshStarted = false
  register('checks:estimate', async ({ games }) => {
    const { estimates } = services.get('checks')
    if (!refreshStarted) {
      refreshStarted = true
      void estimates.refresh()
    }
    // The counts of the profiles refined so far, nothing measured. Without them (the worlds could not
    // be listed…) the estimate still gives each game's most checks (Ruling 24).
    const profiles = await Promise.resolve()
      .then(() => services.get('profiles').cachedCounts(games))
      .catch((error: unknown) => {
        services.ctx.log.warn('checks: no profile counts for the estimate', error)
        return new Map<string, ProfileCounts | null>()
      })
    return Object.fromEntries(
      games.map((game) => [game, { max: estimates.maxFor(game), profiles: profiles.get(game) ?? null }]),
    )
  })

  register('checks:measureSession', ({ sessionId }) => {
    const { measurer } = services.get('checks')
    return Promise.resolve(
      services.ctx.tasks.start('measure', (task) => measurer.measureSession(sessionId, task)),
    )
  })

  register('checks:lastSession', ({ sessionId }) => services.get('checks').measurer.lastSession(sessionId))

  // Its measures are test generations: a `measure` task, like the session's.
  register('checks:suggest', (input) => {
    const { balancer } = services.get('checks')
    return Promise.resolve(services.ctx.tasks.start('measure', (task) => balancer.suggest(input, task)))
  })

  register('checks:apply', (input) => services.get('checks').balancer.apply(input))
}
