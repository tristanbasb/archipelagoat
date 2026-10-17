import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskHandle } from '@main/core/tasks'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import { apUserAgent, createHttp } from '@main/core/system/http'
import { createWebhostClient, type WebhostClient } from '@main/core/webhost/client'
import { createCookieJar } from '@main/core/webhost/cookies'
import { createWebhostService, hostOnWeb, type HostOnWebDeps } from '@main/core/webhost/rooms'
import { AppError } from '@shared/errors'
import type { Generation, TaskDone, TaskFailed } from '@shared/types'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { startMockWebhost, type MockWebhost, type MockWebhostOptions } from '../../mock-webhost/server'
import { makeZip } from '../sessions/helpers'

let root: string
let core: TestCore
let mock: MockWebhost
let sessions: SessionStore
let sessionId: string
let zipPath: string
let clock: number
let sleeps: number[]

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat webhost rooms é-'))
  core = createTestContext(join(root, 'core'))
  core.ctx.http = createHttp({
    userAgent: apUserAgent('0.1.0-test'),
    cacheDir: join(root, 'cache'),
    log: silentLogger,
    githubToken: () => null,
  })
  sessions = createSessionStore(core.ctx, {
    validationContext: () => Promise.reject(new Error('no validation in these tests')),
  })
  const session = await sessions.create('Soirée web')
  sessionId = session.id
  zipPath = await makeZip(join(session.workspace, 'output', 'AP_12345678901234567890.zip'), {
    'AP_12345678901234567890.archipelago': 'multidata',
  })
  const generation: Generation = {
    seedName: '12345678901234567890',
    zipPath,
    spoilerName: null,
    slots: [],
    durationS: 3,
    logPath: join(session.workspace, 'output', 'generate.log'),
  }
  await sessions.setGeneration(sessionId, generation)
  clock = 0
  sleeps = []
  await startMock()
})

afterEach(async () => {
  await mock.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

async function startMock(opts?: MockWebhostOptions): Promise<void> {
  if (mock) await mock.close()
  mock = await startMockWebhost(opts)
}

function makeClient(): WebhostClient {
  return createWebhostClient(core.ctx, { baseUrl: mock.url, jar: createCookieJar(core.ctx.secrets) })
}

/** A fake clock that the sleeps move forward: the 60 s of polling pass at once. */
function deps(extra: Partial<HostOnWebDeps> = {}): HostOnWebDeps {
  return {
    sessions,
    client: makeClient(),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms)
      clock += ms
      return Promise.resolve()
    },
    ...extra,
  }
}

function fakeTask(signal: AbortSignal = new AbortController().signal): TaskHandle & { stages: string[] } {
  const stages: string[] = []
  return {
    id: 'task-1',
    signal,
    stages,
    progress: (stage) => {
      if (stages.at(-1) !== stage) stages.push(stage)
    },
    log: () => undefined,
  }
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

const onlyRoom = (): MockWebhost['state']['rooms'] extends Map<string, infer R> ? R : never => {
  const rooms = [...mock.state.rooms.values()]
  expect(rooms).toHaveLength(1)
  return rooms[0]!
}

describe('hostOnWeb', () => {
  it('hosts end-to-end against mock and returns WebRoom with port', async () => {
    const task = fakeTask()
    const room = await hostOnWeb(core.ctx, deps(), sessionId, task)

    const created = onlyRoom()
    expect(room).toEqual({
      roomId: created.id,
      seedId: created.seedId,
      roomUrl: `${mock.url}/room/${created.id}`,
      host: '127.0.0.1',
      port: 50123,
      lastActivity: expect.any(String) as string,
      timeoutS: 7200,
      players: [
        { name: 'Alice', game: 'A Link to the Past' },
        { name: 'Bob', game: 'TUNIC' },
      ],
      downloads: [
        { slot: 1, url: `${mock.url}/dl_patch/${created.id}/1` },
        { slot: 2, url: `${mock.url}/dl_patch/${created.id}/2` },
      ],
      trackerUrl: `${mock.url}/tracker/${created.tracker}`,
    })
    expect(task.stages).toEqual(['upload', 'room', 'wake', 'port'])
    expect(mock.state.seeds.get(created.seedId)?.fileName).toBe('AP_12345678901234567890.zip')
    expect(created.visits).toBe(1)

    const session = await sessions.get(sessionId)
    expect(session.status).toBe('hosting')
    expect(session.hosting).toEqual({
      mode: 'web',
      seedId: created.seedId,
      roomId: created.id,
      roomUrl: room.roomUrl,
      port: 50123,
    })
  })

  it('calls /new_room exactly once even when port takes 3 polls', async () => {
    await startMock({ portDelayPolls: 3 })
    const room = await hostOnWeb(core.ctx, deps(), sessionId, fakeTask())
    expect(mock.state.newRoomCalls).toBe(1)
    expect(onlyRoom().statusPolls).toBe(4)
    expect(room.port).toBe(50123)
    // Backoff from 1 s, doubling, capped at 5 s.
    expect(sleeps).toEqual([1000, 2000, 4000])
  })

  it('last_port -1 gives WEBHOST_ROOM_FAILED', async () => {
    mock.state.assignPort = -1
    const error = await failure(hostOnWeb(core.ctx, deps(), sessionId, fakeTask()))
    expect(error.code).toBe('WEBHOST_ROOM_FAILED')
    expect(mock.state.newRoomCalls).toBe(1)
    // The room exists on the site: the session keeps it, without a port, so it can be woken later.
    const created = onlyRoom()
    expect((await sessions.get(sessionId)).hosting).toEqual({
      mode: 'web',
      seedId: created.seedId,
      roomId: created.id,
      roomUrl: `${mock.url}/room/${created.id}`,
      port: null,
    })
  })

  it('gives up with WEBHOST_ROOM_FAILED when no port came within 60 s', async () => {
    await startMock({ portDelayPolls: 1000 })
    const error = await failure(hostOnWeb(core.ctx, deps(), sessionId, fakeTask()))
    expect(error.code).toBe('WEBHOST_ROOM_FAILED')
    expect(mock.state.newRoomCalls).toBe(1)
    expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 5000])
    expect(Math.max(...sleeps)).toBe(5000)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(60_000)
  })

  it('keeps polling through a failed status read, without a second room', async () => {
    const client = makeClient()
    let failures = 1
    const flaky: WebhostClient = {
      ...client,
      roomStatus: (roomId) =>
        failures-- > 0 ? Promise.reject(new AppError('WEBHOST_UNAVAILABLE')) : client.roomStatus(roomId),
    }
    const room = await hostOnWeb(core.ctx, deps({ client: flaky }), sessionId, fakeTask())
    expect(room.port).toBe(50123)
    expect(mock.state.newRoomCalls).toBe(1)
    expect(sleeps).toEqual([1000])
  })

  it('fails with NOT_FOUND before any request when the session has no generation', async () => {
    await sessions.setGeneration(sessionId, null)
    expect((await failure(hostOnWeb(core.ctx, deps(), sessionId, fakeTask()))).code).toBe('NOT_FOUND')
    expect(mock.state.requests).toEqual([])
  })

  it('a task cancelled during the upload opens no room', async () => {
    const controller = new AbortController()
    const client = makeClient()
    const watched: WebhostClient = {
      ...client,
      uploadSeed: async (path, signal) => {
        const seedId = await client.uploadSeed(path, signal)
        controller.abort()
        return seedId
      },
    }
    const error = await failure(
      hostOnWeb(core.ctx, deps({ client: watched }), sessionId, fakeTask(controller.signal)),
    )
    expect(error.code).toBe('TASK_CANCELLED')
    expect(mock.state.seeds.size).toBe(1)
    expect(mock.state.newRoomCalls).toBe(0)
    expect((await sessions.get(sessionId)).hosting).toBeNull()
  })

  it('a cancelled task stops waiting for the port at once (real timers)', async () => {
    await startMock({ portDelayPolls: 1000 })
    const controller = new AbortController()
    const client = makeClient()
    let abortedAt = 0
    // Cancelled 20 ms after the first status read, during the 1 s wait that follows it.
    const watched: WebhostClient = {
      ...client,
      roomStatus: async (roomId, signal) => {
        const status = await client.roomStatus(roomId, signal)
        setTimeout(() => {
          abortedAt = Date.now()
          controller.abort()
        }, 20)
        return status
      },
    }
    const error = await failure(
      hostOnWeb(core.ctx, { sessions, client: watched }, sessionId, fakeTask(controller.signal)),
    )
    expect(error.code).toBe('TASK_CANCELLED')
    expect(Date.now() - abortedAt).toBeLessThan(500)
    expect(onlyRoom().statusPolls).toBe(1)
  })
})

describe('createWebhostService', () => {
  function makeService(): ReturnType<typeof createWebhostService> {
    core.ctx.config.updateInternal({ webhostUrl: mock.url })
    return createWebhostService(core.ctx, {
      sessions: () => sessions,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms)
        clock += ms
        return Promise.resolve()
      },
      ownerDelayMs: 0,
    })
  }

  function waitForTask(taskId: string): Promise<TaskDone | TaskFailed> {
    return new Promise((resolve) => {
      core.ctx.bus.on('task:done', (done) => {
        if (done.taskId === taskId) resolve(done)
      })
      core.ctx.bus.on('task:failed', (failed) => {
        if (failed.taskId === taskId) resolve(failed)
      })
    })
  }

  async function hosted(service: ReturnType<typeof makeService>): Promise<string> {
    const { taskId } = service.host(sessionId)
    const end = await waitForTask(taskId)
    expect(end).toMatchObject({
      kind: 'webhost-host',
      result: expect.objectContaining({ port: 50123 }) as unknown,
    })
    return onlyRoom().id
  }

  it('hosts as a webhost-host task on the configured site', async () => {
    const service = makeService()
    const roomId = await hosted(service)
    expect((await sessions.get(sessionId)).hosting).toMatchObject({ mode: 'web', roomId, port: 50123 })
  })

  it('reads a room with the seed of its session, and follows a port that changed', async () => {
    const service = makeService()
    const roomId = await hosted(service)
    onlyRoom().port = 50777
    const room = await service.room(roomId)
    expect(room).toMatchObject({ roomId, seedId: onlyRoom().seedId, port: 50777, host: '127.0.0.1' })
    expect((await sessions.get(sessionId)).hosting).toMatchObject({ roomId, port: 50777 })
  })

  it('reads a room no session knows, with an empty seed', async () => {
    const service = makeService()
    const roomId = await hosted(service)
    await sessions.setHosting(sessionId, null)
    expect(await service.room(roomId)).toMatchObject({ roomId, seedId: '', port: 50123 })
    expect((await sessions.get(sessionId)).hosting).toBeNull()
  })

  it('wakes a room and reads its port again', async () => {
    const service = makeService()
    const roomId = await hosted(service)
    const visits = onlyRoom().visits
    const room = await service.wake(roomId)
    expect(onlyRoom().visits).toBe(visits + 1)
    expect(room.port).toBe(50123)
  })

  it('passes commands, log reads and the room list through the client', async () => {
    const service = makeService()
    const roomId = await hosted(service)
    await service.command(roomId, '/countdown 5')
    expect(onlyRoom().commands).toEqual(['/countdown 5'])
    const log = await service.readLog(roomId, 0)
    expect(log.text).toContain('Hosting game at 127.0.0.1:50123')
    expect((await service.myRooms()).map((ref) => ref.roomId)).toEqual([roomId])
  })

  it('opens the room as owner: the identity page first, then the room', async () => {
    const service = makeService()
    const roomId = await hosted(service)
    await service.openAsOwner(roomId)
    expect(core.openExternal.mock.calls).toEqual([
      [`${mock.url}/session/${onlyRoom().owner}`],
      [`${mock.url}/room/${roomId}`],
    ])
  })
})
