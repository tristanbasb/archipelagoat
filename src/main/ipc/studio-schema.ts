// studio:games, studio:schema and ap:regenerateTemplates: the games the Studio can edit, their option
// schema, and the regeneration of Archipelago's templates.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerStudioSchemaHandlers(
  register: RegisterHandler,
  services: ServiceContainer,
): void {
  const templates = (): ReturnType<typeof services.get<'templates'>> => services.get('templates')

  register('studio:games', () => templates().listGames())

  register('studio:schema', ({ game }) => templates().getSchema(game))

  // A task: the Launcher imports every world before it writes the templates.
  register('ap:regenerateTemplates', () =>
    Promise.resolve(services.ctx.tasks.start('templates', (task) => templates().regenerate(task))),
  )
}
