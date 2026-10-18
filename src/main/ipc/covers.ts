// covers:* handlers: the cover of a game, as a link the renderer can show.
import type { ServiceContainer } from '@main/services/registry'
// The `covers` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/covers.service'
import type { RegisterHandler } from './registry'

export default function registerCoverHandlers(register: RegisterHandler, services: ServiceContainer): void {
  register('covers:get', async ({ game }) => ({ url: await services.get('covers').urlFor(game) }))
}
