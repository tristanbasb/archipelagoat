// join:* handlers (Task 20): what the player gave, the plan of a room, an address or a patch (a task),
// the plan checked again after a fix, and the launch of its client or of the Text Client.
import type { ServiceContainer } from '@main/services/registry'
import type {} from '@main/services/join.service'
import type { RegisterHandler } from './registry'

export default function registerJoinHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const join = (): ReturnType<typeof services.get<'join'>> => services.get('join')

  register('join:resolve', ({ input }) => Promise.resolve(join().resolve(input)))

  // A task: a room may have to wake up and the slot's file to download. Its result is the JoinPlan.
  register('join:prepare', ({ target, slotName }) =>
    Promise.resolve(
      services.ctx.tasks.start('join-prepare', (task) => join().prepare(target, slotName ?? null, task)),
    ),
  )

  register('join:refresh', ({ planId }) => join().refresh(planId))

  register('join:play', ({ planId }) => join().play(planId))

  register('join:textClient', ({ host, port, slot, password }) =>
    join().textClient({ host, port, slot, password: password ?? null }),
  )
}
