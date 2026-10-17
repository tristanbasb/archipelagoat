// The `catalog` service: the APWorld catalog, from the ionium index and the wiki (Task 11).
import { createCatalog, type Catalog } from '@main/core/worlds/catalog'
// The `locator` entry of Services, which this service uses.
import type {} from './locator.service'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    catalog: Catalog
  }
}

defineService('catalog', (ctx, get) => createCatalog(ctx, { locator: get('locator') }), { eager: false })
