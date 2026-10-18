// ready:* handlers: « Jeu prêt », its plan and its run.
import type { ServiceContainer } from '@main/services/registry'
// The `ready` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/ready.service'
import type { RegisterHandler } from './registry'

export default function registerReadyHandlers(register: RegisterHandler, services: ServiceContainer): void {
  register('ready:prepare', ({ entryId }) => services.get('ready').prepare(entryId))

  // A task: the world may be downloaded and installed, the templates written, the YAML measured.
  register('ready:run', (input) =>
    Promise.resolve(services.ctx.tasks.start('ready', (task) => services.get('ready').run(input, task))),
  )
}
