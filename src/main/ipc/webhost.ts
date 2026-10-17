// webhost:* handlers (Task 17): hosting on archipelago.gg (a task, only with the consent the contract
// requires) and the room it opened: status, wake, console, log, owner's view in the browser.
import type { ServiceContainer } from '@main/services/registry'
import type {} from '@main/services/webhost.service'
import type { RegisterHandler } from './registry'

export default function registerWebhostHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const webhost = (): ReturnType<typeof services.get<'webhost'>> => services.get('webhost')

  register('webhost:host', ({ sessionId, newRoom }) =>
    Promise.resolve(webhost().host(sessionId, { newRoom: newRoom === true })),
  )

  register('webhost:room', ({ roomId }) => webhost().room(roomId))

  register('webhost:wake', ({ roomId }) => webhost().wake(roomId))

  register('webhost:command', ({ roomId, command }) => webhost().command(roomId, command))

  register('webhost:log', ({ roomId, fromByte }) => webhost().readLog(roomId, fromByte))

  register('webhost:myRooms', () => webhost().myRooms())

  register('webhost:openAsOwner', ({ roomId }) => webhost().openAsOwner(roomId))
}
