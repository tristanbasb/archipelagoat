import { z } from 'zod'
import type { ServerHistory, ServerState } from '../types'
import { channel, nonEmpty } from './contract'

const sessionId = nonEmpty

export const serverChannels = {
  /**
   * `replaceWeb` confirms that the local server replaces the session's archipelago.gg room as its
   * hosting (the room stays on the site): without it, a session hosted on the web is refused.
   */
  'server:start': channel(z.strictObject({ sessionId, replaceWeb: z.boolean().optional() }))<ServerState>(),
  'server:stop': channel(z.strictObject({ sessionId, force: z.boolean().optional() }))<void>(),
  'server:command': channel(z.strictObject({ sessionId, command: nonEmpty }))<void>(),
  'server:get': channel(z.strictObject({ sessionId }))<ServerState | null>(),
  'server:history': channel(z.strictObject({ sessionId }))<ServerHistory>(),
}
