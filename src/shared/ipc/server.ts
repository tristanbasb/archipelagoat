import { z } from 'zod'
import type { ServerHistory, ServerState } from '../types'
import { channel, nonEmpty } from './contract'

const sessionId = nonEmpty

export const serverChannels = {
  'server:start': channel(z.strictObject({ sessionId }))<ServerState>(),
  'server:stop': channel(z.strictObject({ sessionId, force: z.boolean().optional() }))<void>(),
  'server:command': channel(z.strictObject({ sessionId, command: nonEmpty }))<void>(),
  'server:get': channel(z.strictObject({ sessionId }))<ServerState | null>(),
  'server:history': channel(z.strictObject({ sessionId }))<ServerHistory>(),
}
