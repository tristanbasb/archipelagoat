// ap:detect and ap:setCustomPath: where Archipelago is installed.
import { assertUserPath } from '@main/core/system/user-path'
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerApDetectHandlers(
  register: RegisterHandler,
  services: ServiceContainer,
): void {
  const { config } = services.ctx

  register('ap:detect', () => services.get('locator').detect())

  // A folder chosen by the user; null goes back to automatic detection.
  register('ap:setCustomPath', async ({ path }) => {
    const locator = services.get('locator')
    if (path === null) {
      config.updateInternal({ apPathOverride: null })
    } else {
      const dir = await assertUserPath(path, { kind: 'dir' })
      // Throws AP_NOT_INSTALLED, and saves nothing, when the folder holds no Archipelago.
      await locator.fromRoot(dir, 'custom')
      config.updateInternal({ apPathOverride: dir })
    }
    locator.invalidate()
    return locator.detect()
  })
}
