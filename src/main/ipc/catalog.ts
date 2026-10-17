// catalog:* handlers: the APWorld catalog (the ionium index joined with the Archipelago wiki).
import type { ServiceContainer } from '@main/services/registry'
// The `catalog` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/catalog.service'
import type { RegisterHandler } from './registry'

export default function registerCatalogHandlers(register: RegisterHandler, services: ServiceContainer): void {
  register('catalog:list', ({ force }) => services.get('catalog').snapshot(force ?? false))
}
