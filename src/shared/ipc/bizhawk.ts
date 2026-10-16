import { z } from 'zod'
import type { BizhawkState, TaskRef } from '../types'
import { channel, nonEmpty, voidInput } from './contract'

export const bizhawkChannels = {
  'bizhawk:state': channel(voidInput)<BizhawkState>(),
  /** Task result: `BizhawkState`. */
  'bizhawk:install': channel(voidInput)<TaskRef>(),
  'bizhawk:setPath': channel(z.strictObject({ path: nonEmpty.nullable() }))<BizhawkState>(),
  'bizhawk:configureAp': channel(voidInput)<BizhawkState>(),
}
