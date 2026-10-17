// session:generate (Task 15): answers the TaskRef of the session's generation at once; the task then
// reports its stages and ends with the Generation (task:done) or an error code (task:failed).
import type {} from '@main/services/generator.service'
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerSessionGenerateHandler(
  register: RegisterHandler,
  services: ServiceContainer,
): void {
  register('session:generate', ({ id }) => Promise.resolve(services.get('generator').generate(id)))
}
