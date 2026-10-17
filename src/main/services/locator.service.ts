// The `locator` service: where Archipelago is installed (Task 6). Eager, so that the app:openPath
// roots it adds exist from startup, before anything else asks for it.
import { createLocator, fakeApFromEnv, type Locator } from '@main/core/ap/locator'
import { defineService } from './registry'

declare module '@main/services/registry' {
  interface Services {
    locator: Locator
  }
}

defineService(
  'locator',
  (ctx) => {
    const locator = createLocator(ctx, fakeApFromEnv(ctx) ?? {})
    // app:openPath may open the install folder and Archipelago's user folder.
    ctx.paths.addAllowedRoots(async () => {
      const install = await locator.detect()
      return install ? [install.root, install.paths.userPath] : []
    })
    return locator
  },
  { eager: true },
)
