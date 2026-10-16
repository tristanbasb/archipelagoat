import { z } from 'zod'
import type { CatalogSnapshot } from '../types'
import { channel } from './contract'

export const catalogChannels = {
  'catalog:list': channel(z.strictObject({ force: z.boolean().optional() }))<CatalogSnapshot>(),
}
