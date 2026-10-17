import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apUserAgent, createHttp } from '@main/core/system/http'
import type { WebhostService } from '@main/core/webhost/rooms'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import registerWebhostHandlers from '@main/ipc/webhost'
import { createServices } from '@main/services'
import type { ServiceContainer } from '@main/services/registry'
// The `servers`, `sessions` and `webhost` entries of Services (the service files are loaded by import.meta.glob).
import type {} from '@main/services/servers.service'
import type {} from '@main/services/sessions.service'
import type {} from '@main/services/webhost.service'
import type { IpcResult } from '@shared/ipc/contract'
import type { Session, TaskDone, TaskFailed, WebRoom, WebRoomRef } from '@shared/types'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { startMockWebhost, type MockWebhost } from '../../mock-webhost/server'
import { makeZip } from '../sessions/helpers'

let root: string
let core: TestCore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat webhost ipc é-'))
  core = createTestContext(join(root, 'core'))
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

const ROOM: WebRoom = {
  roomId: 'AAAAAAAAAAAAAAAAAAAAAA',
  seedId: 'BBBBBBBBBBBBBBBBBBBBBB',
  roomUrl: 'https://archipelago.gg/room/AAAAAAAAAAAAAAAAAAAAAA',
  host: 'archipelago.gg',
  port: 38281,
  lastActivity: null,
  timeoutS: 7200,
  players: [],
  downloads: [],
  trackerUrl: null,
}

describe('webhost handlers', () => {
  it('route every webhost channel to the webhost service', async () => {
    const refs: WebRoomRef[] = [
      { roomId: ROOM.roomId, seedId: null, roomUrl: ROOM.roomUrl, lastActivity: null },
    ]
    const service = {
      host: vi.fn<WebhostService['host']>(() => ({ taskId: 'task-1' })),
      room: vi.fn<WebhostService['room']>(() => Promise.resolve(ROOM)),
      wake: vi.fn<WebhostService['wake']>(() => Promise.resolve({ ...ROOM, port: 40000 })),
      command: vi.fn<WebhostService['command']>(() => Promise.resolve()),
      readLog: vi.fn<WebhostService['readLog']>(() => Promise.resolve({ text: 'hi\n', nextByte: 3 })),
      myRooms: vi.fn<WebhostService['myRooms']>(() => Promise.resolve(refs)),
      openAsOwner: vi.fn<WebhostService['openAsOwner']>(() => Promise.resolve()),
    } satisfies WebhostService
    const services = {
      ctx: core.ctx,
      get: (name: string) => {
        expect(name).toBe('webhost')
        return service
      },
      startEager: () => undefined,
    } as unknown as ServiceContainer
    const ipc = createIpcRegistry()
    registerWebhostHandlers(ipc.registerHandler, services)
    const call = (name: string, input?: unknown): Promise<IpcResult<unknown>> =>
      ipc.dispatch(name, input, { senderId: 1 })
    const roomId = ROOM.roomId

    expect(await call('webhost:host', { sessionId: 's1', consent: true })).toEqual({
      ok: true,
      value: { taskId: 'task-1' },
    })
    expect(service.host).toHaveBeenCalledWith('s1')
    // No hosting without the explicit consent of the dialog.
    expect(await call('webhost:host', { sessionId: 's1', consent: false })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    expect(service.host).toHaveBeenCalledOnce()

    expect(await call('webhost:room', { roomId })).toEqual({ ok: true, value: ROOM })
    expect(await call('webhost:wake', { roomId })).toEqual({ ok: true, value: { ...ROOM, port: 40000 } })
    expect(await call('webhost:command', { roomId, command: '/help' })).toEqual({
      ok: true,
      value: undefined,
    })
    expect(service.command).toHaveBeenCalledWith(roomId, '/help')
    expect(await call('webhost:log', { roomId, fromByte: 7 })).toEqual({
      ok: true,
      value: { text: 'hi\n', nextByte: 3 },
    })
    expect(service.readLog).toHaveBeenCalledWith(roomId, 7)
    expect(await call('webhost:myRooms')).toEqual({ ok: true, value: refs })
    expect(await call('webhost:openAsOwner', { roomId })).toEqual({ ok: true, value: undefined })
    expect(service.openAsOwner).toHaveBeenCalledWith(roomId)
  })

  describe('with the real services', () => {
    let mock: MockWebhost

    beforeEach(async () => {
      mock = await startMockWebhost()
    })

    afterEach(() => mock.close())

    /** The real services against the mock site, and a generated session. */
    async function generatedSession() {
      core.ctx.http = createHttp({
        userAgent: apUserAgent('0.1.0-test'),
        cacheDir: join(root, 'cache'),
        log: silentLogger,
        githubToken: () => null,
      })
      core.ctx.config.updateInternal({ webhostUrl: mock.url })
      const services = createServices(core.ctx)
      const ipc = createIpcRegistry()
      registerHandlers(services, ipc.registerHandler)
      const call = async <T>(name: string, input?: unknown): Promise<T> => {
        const result = await ipc.dispatch(name, input, { senderId: 1 })
        if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
        return result.value as T
      }

      const sessions = services.get('sessions')
      const session = await sessions.create('Web')
      const zipPath = await makeZip(join(session.workspace, 'output', 'AP_1.zip'), {
        'AP_1.archipelago': 'x',
      })
      await sessions.setGeneration(session.id, {
        seedName: '1',
        zipPath,
        spoilerName: null,
        slots: [],
        durationS: 1,
        logPath: join(session.workspace, 'output', 'generate.log'),
      })
      return { services, call, session }
    }

    /** The end of a task: its done event, or its failed one. */
    function taskEnd(taskId: string): Promise<TaskDone | TaskFailed> {
      return new Promise((resolve) => {
        core.ctx.bus.on('task:done', (event) => {
          if (event.taskId === taskId) resolve(event)
        })
        core.ctx.bus.on('task:failed', (event) => {
          if (event.taskId === taskId) resolve(event)
        })
      })
    }

    it('host a generated session on the site set by the config, then read its room', async () => {
      const { call, session } = await generatedSession()

      const { taskId } = await call<{ taskId: string }>('webhost:host', {
        sessionId: session.id,
        consent: true,
      })
      const done = await taskEnd(taskId)
      expect(done).toHaveProperty('result')
      const room = (done as TaskDone).result as WebRoom
      expect(room).toMatchObject({ host: '127.0.0.1', port: 50123 })
      expect((await call<Session>('session:get', { id: session.id })).hosting).toMatchObject({
        mode: 'web',
        roomId: room.roomId,
      })
      expect(await call<WebRoom>('webhost:room', { roomId: room.roomId })).toMatchObject({
        roomId: room.roomId,
        seedId: room.seedId,
        port: 50123,
      })
    })

    it('refuse to host a session whose local server the servers service reports', async () => {
      const { services, call, session } = await generatedSession()
      const isBusy = vi.spyOn(services.get('servers'), 'isBusy').mockReturnValue(true)

      const { taskId } = await call<{ taskId: string }>('webhost:host', {
        sessionId: session.id,
        consent: true,
      })

      expect(await taskEnd(taskId)).toMatchObject({
        error: { code: 'AP_RUNNING', params: { reason: 'local-server' } },
      })
      expect(isBusy).toHaveBeenCalledWith(session.id)
      expect(mock.state.requests).toEqual([])
    })
  })
})
