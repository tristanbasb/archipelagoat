// The `covers` service: the covers of the games, downloaded once and shown through `goat-cover://`.
import { createCovers, type Covers } from '@main/core/covers/covers'
import { defineService } from './registry'
// The `catalog` entry of Services, which the covers are looked up in.
import type {} from './catalog.service'

declare module '@main/services/registry' {
  interface Services {
    covers: Covers
  }
}

defineService(
  'covers',
  (ctx, get) =>
    createCovers(ctx, {
      // Asked when a cover is: the catalog is created on first use.
      lookupCover: (game) => get('catalog').lookupCover(game),
    }),
  { eager: false },
)
