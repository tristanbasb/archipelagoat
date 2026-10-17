// system:* handlers (the integration with the desktop), and app:pendingOpenRequests: the links and
// files opened with the app before the renderer could take them.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerSystemHandlers(register: RegisterHandler, services: ServiceContainer): void {
  register('system:integration', () => services.get('integration').state())

  register('system:setIntegration', (patch) => services.get('integration').set(patch))

  register('app:pendingOpenRequests', () => Promise.resolve(services.get('openRequests').drain()))
}
