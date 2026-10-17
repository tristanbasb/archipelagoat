// server:* handlers (Task 16): the local server of a session, its console and its history. server:get
// and server:history answer from memory without waiting, so the history the renderer reads holds every
// event sent before its answer (it ignores the events that come before that answer).
import type { ServiceContainer } from '@main/services/registry'
import type {} from '@main/services/servers.service'
import type { RegisterHandler } from './registry'

export default function registerServerHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const servers = (): ReturnType<typeof services.get<'servers'>> => services.get('servers')

  register('server:start', ({ sessionId, replaceWeb }) =>
    servers().start(sessionId, { replaceWeb: replaceWeb === true }),
  )

  register('server:stop', ({ sessionId, force }) => servers().stop(sessionId, { force }))

  register('server:command', ({ sessionId, command }) => {
    servers().command(sessionId, command)
    return Promise.resolve()
  })

  register('server:get', ({ sessionId }) => Promise.resolve(servers().get(sessionId)))

  register('server:history', ({ sessionId }) => Promise.resolve(servers().history(sessionId)))
}
