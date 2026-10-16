/// <reference types="vite/types/importMeta.d.ts" />
// Loads every src/main/services/*.service.ts: importing one runs its defineService. Adding a service
// therefore never edits a shared file.
import.meta.glob('./*.service.ts', { eager: true })

export { createServices, defineService } from './registry'
export type { ServiceContainer, Services } from './registry'
