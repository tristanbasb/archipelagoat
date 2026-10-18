import { z } from 'zod'
import type { BalanceTarget, GameEstimate, Session, SessionChecks, TaskRef } from '../types'
import { channel, nonEmpty } from './contract'

/** A target given as a number of checks: no game has this many locations. */
const MAX_TARGET = 100_000

const BalanceTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('median') }),
  z.strictObject({ kind: z.literal('short') }),
  z.strictObject({ kind: z.literal('long') }),
  z.strictObject({ kind: z.literal('count'), value: z.number().int().min(1).max(MAX_TARGET) }),
]) satisfies z.ZodType<BalanceTarget>

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
  /**
   * Proposals that bring the checks of one player document toward the session's target, each
   * measured: a `measure` task whose result is the BalanceProposal[] (none when no option of the game
   * moves its count the right way). A proposal can be applied for an hour.
   */
  'checks:suggest': channel(
    z.strictObject({
      sessionId: nonEmpty,
      fileId: nonEmpty,
      docIndex: z.number().int().min(0),
      target: BalanceTargetSchema,
    }),
  )<TaskRef>(),
  /**
   * Writes a proposal's options in its player file (only those, comments and the other documents
   * kept) and validates the file again. NOT_FOUND for a proposal that is unknown, more than an hour
   * old, of another file, or made before the file last changed.
   */
  'checks:apply': channel(
    z.strictObject({ sessionId: nonEmpty, fileId: nonEmpty, proposalId: nonEmpty }),
  )<Session>(),
}
