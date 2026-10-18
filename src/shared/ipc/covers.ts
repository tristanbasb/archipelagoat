import { z } from 'zod'
import { channel, nonEmpty } from './contract'

export const coversChannels = {
  /** `goat-cover://…` once the cover is cached (downloaded on the first ask); null when the game has none. */
  'covers:get': channel(z.strictObject({ game: nonEmpty }))<{ url: string | null }>(),
}
