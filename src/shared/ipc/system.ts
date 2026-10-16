import { z } from 'zod'
import type { IntegrationState } from '../types'
import { channel, voidInput } from './contract'

export const systemChannels = {
  'system:integration': channel(voidInput)<IntegrationState>(),
  'system:setIntegration': channel(
    z.strictObject({
      linuxDesktop: z.boolean().optional(),
      winProtocol: z.boolean().optional(),
      winAssociations: z.boolean().optional(),
    }),
  )<IntegrationState>(),
}
