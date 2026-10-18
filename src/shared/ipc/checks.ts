import { z } from 'zod'
import type { GameEstimate, SessionChecks, TaskRef } from '../types'
import { channel, nonEmpty } from './contract'

export const checksChannels = {
  /**
   * What is known of the size of each game asked, from the tables on disk and without any wait:
   * `max` is the most checks the game can have, null for a game no table knows. Keyed by the names asked.
   */
  'checks:estimate': channel(z.strictObject({ games: z.array(nonEmpty).max(2000) }))<
    Record<string, GameEstimate>
  >(),
  /**
   * Measures every player document of the session, each alone in a test generation: a `measure`
   * task whose result is the SessionChecks (also kept as the session's last checks).
   */
  'checks:measureSession': channel(z.strictObject({ sessionId: nonEmpty }))<TaskRef>(),
  /** The session's last checks, measured or read from its generation; null before any. */
  'checks:lastSession': channel(z.strictObject({ sessionId: nonEmpty }))<SessionChecks | null>(),
}
