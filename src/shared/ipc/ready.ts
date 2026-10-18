import { z } from 'zod'
import type { ReadyDestination, ReadyPlan, TaskRef } from '../types'
import { PLAYER_NAME_MAX } from './app'
import { channel, nonEmpty } from './contract'

const ReadyDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: nonEmpty }),
  z.strictObject({ kind: z.literal('new-session'), name: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('file'), path: nonEmpty }),
  z.strictObject({ kind: z.literal('studio') }),
]) satisfies z.ZodType<ReadyDestination>

export const ReadyRunSchema = z.strictObject({
  planId: nonEmpty,
  profile: z.enum(['discovery', 'standard', 'complete']),
  /** Empty: the YAML is named `Player{number}`. */
  playerName: z.string().trim().max(PLAYER_NAME_MAX),
  destination: ReadyDestinationSchema,
  /** Installs the catalog's later version of a world already installed. */
  update: z.boolean(),
  /** The full warning of a `wiki-release` or `unknown` world was accepted. */
  trustAccepted: z.boolean(),
})

export const readyChannels = {
  /**
   * What « Jeu prêt » would do for a catalog entry, without changing anything: the plan stays valid
   * for an hour. NOT_FOUND for an entry the catalog does not have.
   */
  'ready:prepare': channel(z.strictObject({ entryId: nonEmpty }))<ReadyPlan>(),
  /**
   * A `ready` task (result: ReadyOutcome) that installs the world when needed, makes the profile's YAML,
   * measures it, validates it and delivers it. A run that fails or is cancelled keeps what it did: the
   * same plan run again goes on from the first step not done. INVALID_INPUT for a world to install whose
   * trust needs a consent not given.
   */
  'ready:run': channel(ReadyRunSchema)<TaskRef>(),
}
