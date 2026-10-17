// studio:parse, studio:render, studio:validate, studio:open and studio:save: the YAML Studio's documents
// and files (Task 13). The schema channels are in ./studio-schema.ts.
import type { ServiceContainer } from '@main/services/registry'
import type {} from '@main/services/studio.service'
import type { RegisterHandler } from './registry'

export default function registerStudioHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const studio = (): ReturnType<typeof services.get<'studio'>> => services.get('studio')

  register('studio:parse', ({ text }) => Promise.resolve(studio().parse(text)))

  register('studio:render', ({ doc }) => studio().render(doc))

  register('studio:validate', ({ text, fileName }) => studio().validate(text, fileName))

  register('studio:open', ({ path }) => studio().open(path))

  register('studio:save', ({ text, path, suggestedName }) => studio().save(text, path, suggestedName))
}
