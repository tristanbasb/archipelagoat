/// <reference types="vite/types/importMeta.d.ts" />
// Loads every handler module of this folder (one per domain, e.g. ./app.ts) and lets each one
// register its channels. Adding handlers therefore never edits a shared file.
import type { ServiceContainer } from '@main/services/registry'
import { registerHandler, type HandlerModule, type RegisterHandler } from './registry'

const modules = import.meta.glob<{ default: HandlerModule }>(['./*.ts', '!./index.ts', '!./registry.ts'], {
  eager: true,
})

export function registerHandlers(
  services: ServiceContainer,
  register: RegisterHandler = registerHandler,
): void {
  for (const [file, module] of Object.entries(modules)) {
    if (typeof module.default !== 'function')
      throw new Error(`${file} must export default (register, services)`)
    module.default(register, services)
  }
}
