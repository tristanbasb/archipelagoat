// profiles:* handlers: the Découverte, Standard and Complet profiles of a game.
import type { ServiceContainer } from '@main/services/registry'
// The `profiles` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/profiles.service'
import type { RegisterHandler } from './registry'

export default function registerProfileHandlers(register: RegisterHandler, services: ServiceContainer): void {
  register('profiles:get', ({ game }) => services.get('profiles').get(game))
}
