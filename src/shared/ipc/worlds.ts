import { z } from 'zod'
import type { TaskRef, WorldInfo } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

export const WorldSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: nonEmpty }),
  z.strictObject({ kind: z.literal('url'), url: nonEmpty }),
  z.strictObject({ kind: z.literal('catalog'), id: nonEmpty }),
])

export const worldsChannels = {
  'worlds:list': channel(voidInput)<WorldInfo[]>(),
  /** Task result: `WorldInstallPlan`. */
  'worlds:prepareInstall': channel(z.strictObject({ source: WorldSourceSchema }))<TaskRef>(),
  'worlds:confirmInstall': channel(z.strictObject({ planId: nonEmpty }))<{
    world: WorldInfo
    restartNeeded: boolean
  }>(),
  'worlds:setEnabled': channel(z.strictObject({ worldId: nonEmpty, enabled: z.boolean() }))<WorldInfo>(),
  'worlds:remove': channel(z.strictObject({ worldId: nonEmpty }))<void>(),
}
