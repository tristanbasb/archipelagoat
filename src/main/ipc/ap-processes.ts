// ap:processes: the Archipelago programs running on the machine.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerApProcessHandlers(
  register: RegisterHandler,
  services: ServiceContainer,
): void {
  register('ap:processes', () => services.get('processes').list())
}
