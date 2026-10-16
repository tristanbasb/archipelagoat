import { z } from 'zod'
import type { RomRecord, RomTableEntry, TaskRef, VaultApplyResult } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

export const vaultChannels = {
  'vault:list': channel(voidInput)<RomRecord[]>(),
  /** Task result: `RomRecord[]`. */
  'vault:scan': channel(z.strictObject({ paths: z.array(nonEmpty) }))<TaskRef>(),
  'vault:remove': channel(z.strictObject({ path: nonEmpty }))<void>(),
  'vault:apply': channel(voidInput)<VaultApplyResult>(),
  'vault:table': channel(voidInput)<RomTableEntry[]>(),
}
