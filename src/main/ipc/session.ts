// session:* handlers (Task 14): the organizer's games, their player files, passwords and validation.
// session:generate is the generator's (Task 15).
import type { ServiceContainer } from '@main/services/registry'
import type {} from '@main/services/sessions.service'
import type { RegisterHandler } from './registry'

export default function registerSessionHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const sessions = (): ReturnType<typeof services.get<'sessions'>> => services.get('sessions')

  register('session:list', () => sessions().list())

  register('session:create', ({ name }) => sessions().create(name))

  register('session:get', ({ id }) => sessions().get(id))

  register('session:update', ({ id, name, rules }) => sessions().update(id, { name, rules }))

  register('session:delete', ({ id }) => sessions().delete(id))

  register('session:addFiles', ({ id, paths }) => sessions().addFiles(id, paths))

  register('session:addText', ({ id, fileName, text }) => sessions().addText(id, fileName, text))

  register('session:removeFile', ({ id, fileId }) => sessions().removeFile(id, fileId))

  register('session:readFile', ({ id, fileId }) => sessions().readFile(id, fileId))

  register('session:replaceFile', ({ id, fileId, text }) => sessions().replaceFile(id, fileId, text))

  register('session:getSecrets', ({ id }) => sessions().getSecrets(id))

  register('session:setSecrets', ({ id, password, serverPassword }) =>
    sessions().setSecrets(id, { password, serverPassword }),
  )

  register('session:validate', ({ id }) => sessions().validateSession(id))
}
