// bizhawk:* handlers: BizHawk's state, its installation (a task), the folder the user chose for it,
// and Archipelago's settings pointed at it.
import type { ServiceContainer } from '@main/services/registry'
import type { RegisterHandler } from './registry'

export default function registerBizhawkHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const bizhawk = (): ReturnType<typeof services.get<'bizhawk'>> => services.get('bizhawk')

  register('bizhawk:state', () => bizhawk().state())

  // A task: the release is downloaded and extracted. Its result is the new BizhawkState.
  register('bizhawk:install', () =>
    Promise.resolve(services.ctx.tasks.start('bizhawk-install', (task) => bizhawk().install(task))),
  )

  // null forgets the folder.
  register('bizhawk:setPath', ({ path }) => bizhawk().setPath(path))

  register('bizhawk:configureAp', () => bizhawk().configureAp())
}
