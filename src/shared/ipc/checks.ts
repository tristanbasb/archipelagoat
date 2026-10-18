import { z } from 'zod'
import type { GameEstimate } from '../types'
import { channel, nonEmpty } from './contract'

export const checksChannels = {
  /**
   * What is known of the size of each game asked, from the tables on disk and without any wait:
   * `max` is the most checks the game can have, null for a game no table knows. Keyed by the names asked.
   */
  'checks:estimate': channel(z.strictObject({ games: z.array(nonEmpty).max(2000) }))<
    Record<string, GameEstimate>
  >(),
}
