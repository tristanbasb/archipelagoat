import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore } from '@main/core/secrets'
import { apUserAgent, createHttp } from '@main/core/system/http'
import { createWebhostClient, type WebhostClient } from '@main/core/webhost/client'
import { createCookieJar } from '@main/core/webhost/cookies'
import { AppError } from '@shared/errors'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { reply, startTestServer, type RequestHandler } from '../../helpers/http-server'
import { startMockWebhost, type MockWebhost } from '../../mock-webhost/server'
import { makeZip } from '../sessions/helpers'

const USER_AGENT = apUserAgent('0.1.0-test')
const UNKNOWN_ID = 'AAAAAAAAAAAAAAAAAAAAAA'

let root: string
let core: TestCore
let mock: MockWebhost
let zipPath: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat webhost client é-'))
  core = createTestContext(join(root, 'core'))
  core.ctx.http = createHttp({
    userAgent: USER_AGENT,
    cacheDir: join(root, 'cache'),
    log: silentLogger,
    githubToken: () => null,
  })
  mock = await startMockWebhost()
  zipPath = await makeZip(join(root, 'session é', 'output', 'AP_12345678901234567890.zip'), {
    'AP_12345678901234567890.archipelago': 'multidata',
  })
})

afterEach(async () => {
  await mock.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function makeClient(
  opts: { baseUrl?: string; core?: TestCore; timeoutMs?: number; uploadTimeoutMs?: number } = {},
): WebhostClient {
  const owner = opts.core ?? core
  return createWebhostClient(owner.ctx, {
    baseUrl: opts.baseUrl ?? mock.url,
    jar: createCookieJar(owner.ctx.secrets),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs: opts.uploadTimeoutMs }),
  })
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

async function hostedRoom(client: WebhostClient): Promise<{ seedId: string; roomId: string }> {
  const seedId = await client.uploadSeed(zipPath)
  return { seedId, roomId: await client.createRoom(seedId) }
}

const requestsTo = (path: string): MockWebhost['state']['requests'] =>
  mock.state.requests.filter((request) => request.url.split('?')[0] === path)

describe('createWebhostClient against the fake site', () => {
  it('uploads the zip and opens one room through the 302s, as an identified client', async () => {
    const client = makeClient()
    const seedId = await client.uploadSeed(zipPath)
    expect(mock.state.seeds.get(seedId)).toMatchObject({ fileName: 'AP_12345678901234567890.zip' })
    const roomId = await client.createRoom(seedId)
    const room = mock.state.rooms.get(roomId)
    expect(room).toMatchObject({ seedId })
    expect(mock.state.newRoomCalls).toBe(1)
    // Same identity for the seed and the room: the cookie of the upload answer was sent back.
    expect(room?.owner).toBe(mock.state.seeds.get(seedId)?.owner)
    // The redirects are not followed: no visit to /seed or /room.
    expect(requestsTo(`/seed/${seedId}`)).toEqual([])
    expect(room?.visits).toBe(0)
    for (const request of mock.state.requests) {
      expect(request.headers['user-agent']).toBe(USER_AGENT)
      expect(request.headers['accept-encoding']).toBe('gzip, br')
    }
  })

  it('maps upload HTML user-message to WEBHOST_UPLOAD_FAILED', async () => {
    await mock.close()
    const message = 'Could not load multidata. File may be corrupted or incompatible. (bad <zip>)'
    mock = await startMockWebhost({ failUpload: message })
    const error = await failure(makeClient().uploadSeed(zipPath))
    expect(error.code).toBe('WEBHOST_UPLOAD_FAILED')
    expect(error.params).toEqual({ message })
    expect(error.detail).toBe(message)
    expect(mock.state.seeds.size).toBe(0)
  })

  it('passes on the message of a file the site does not take', async () => {
    const notes = join(root, 'notes.txt')
    writeFileSync(notes, 'not a game')
    const error = await failure(makeClient().uploadSeed(notes))
    expect(error.code).toBe('WEBHOST_UPLOAD_FAILED')
    expect(error.params).toEqual({
      message: 'Not recognized file format. Awaiting a .archipelago file or .zip containing one.',
    })
  })

  it('room_status 404 HTML gives NOT_FOUND without JSON crash', async () => {
    const client = makeClient()
    const error = await failure(client.roomStatus(UNKNOWN_ID))
    expect(error.code).toBe('NOT_FOUND')
    expect(requestsTo(`/api/room_status/${UNKNOWN_ID}`)).toHaveLength(1)
  })

  it('reads the status of a room: port, players, relative downloads', async () => {
    const client = makeClient()
    const { roomId } = await hostedRoom(client)
    const status = await client.roomStatus(roomId)
    expect(status).toMatchObject({
      lastPort: 50123,
      timeoutS: 7200,
      players: [
        { name: 'Alice', game: 'A Link to the Past' },
        { name: 'Bob', game: 'TUNIC' },
      ],
      downloads: [
        { slot: 1, download: `/dl_patch/${roomId}/1` },
        { slot: 2, download: `/dl_patch/${roomId}/2` },
      ],
    })
    expect(status.tracker).toBe(mock.state.rooms.get(roomId)?.tracker)
    expect(Date.parse(status.lastActivity ?? '')).not.toBeNaN()
  })

  it('readLog uses Range and returns nextByte', async () => {
    const client = makeClient()
    const { roomId } = await hostedRoom(client)
    const room = mock.state.rooms.get(roomId)!
    // No log file yet: the site answers 200 with an explanation, which is not log text.
    expect(await client.readLog(roomId, 0)).toEqual({ text: '', nextByte: 0 })

    room.log = 'Héllo\nwörld\n'
    const first = await client.readLog(roomId, 0)
    expect(first).toEqual({ text: 'Héllo\nwörld\n', nextByte: Buffer.byteLength('Héllo\nwörld\n') })
    room.log += 'Notice (all): Alice has joined.\n'
    expect(await client.readLog(roomId, first.nextByte)).toEqual({
      text: 'Notice (all): Alice has joined.\n',
      nextByte: Buffer.byteLength(room.log),
    })
    expect(requestsTo(`/log/${roomId}`).map((request) => request.headers.range)).toEqual([
      'bytes=0-',
      'bytes=0-',
      `bytes=${first.nextByte}-`,
    ])
  })

  it('sends commands as the cmd form field, without following the redirect', async () => {
    const client = makeClient()
    const { roomId } = await hostedRoom(client)
    await client.sendCommand(roomId, '/countdown 10')
    const room = mock.state.rooms.get(roomId)!
    expect(room.commands).toEqual(['/countdown 10'])
    expect(room.visits).toBe(0)
    const [post] = mock.state.requests.filter(
      (request) => request.method === 'POST' && request.url === `/room/${roomId}`,
    )
    expect(post?.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/)
  })

  it('wakes a room with a light visit (?update)', async () => {
    const client = makeClient()
    const { roomId } = await hostedRoom(client)
    await client.wake(roomId)
    expect(mock.state.rooms.get(roomId)?.visits).toBe(1)
    expect(mock.state.requests.at(-1)?.url).toBe(`/room/${roomId}?update`)
    expect((await failure(client.wake(UNKNOWN_ID))).code).toBe('NOT_FOUND')
  })

  it('lists the rooms of the session cookie', async () => {
    const client = makeClient()
    const { seedId, roomId } = await hostedRoom(client)
    expect(await client.myRooms()).toEqual([
      {
        roomId,
        seedId,
        roomUrl: `${mock.url}/room/${roomId}`,
        lastActivity: mock.state.rooms
          .get(roomId)!
          .lastActivity.toISOString()
          .replace(/\.\d{3}Z$/, '.000Z'),
      },
    ])
  })

  it('gives the /session/<uuid> URL of its identity', async () => {
    const client = makeClient()
    const { roomId } = await hostedRoom(client)
    const owner = mock.state.rooms.get(roomId)!.owner
    expect(await client.ownerUrl(roomId)).toBe(`${mock.url}/session/${owner}`)
  })

  it('cookie persists across client instances (owner kept)', async () => {
    const { roomId } = await hostedRoom(makeClient())
    mock.state.rooms.get(roomId)!.log = 'Server started\n'

    // The next start of the app: a new vault on the same file, a new jar, a new client.
    const secrets = createSecretStore(
      join(core.platform.paths.userData, 'secrets.bin'),
      core.platform,
      core.ctx.config,
    )
    const restarted = createWebhostClient(core.ctx, { baseUrl: mock.url, jar: createCookieJar(secrets) })
    expect(await restarted.readLog(roomId, 0)).toEqual({ text: 'Server started\n', nextByte: 15 })
    expect((await restarted.myRooms()).map((room) => room.roomId)).toEqual([roomId])

    // Another app (another vault) is not the owner: the log is refused.
    const other = createTestContext(join(root, 'stranger'))
    other.ctx.http = core.ctx.http
    const stranger = makeClient({ core: other })
    expect((await failure(stranger.readLog(roomId, 0))).code).toBe('HTTP_ERROR')
    expect(await stranger.myRooms()).toEqual([])
  })

  it('refuses ids that are not suuids, before any request', async () => {
    const client = makeClient()
    for (const call of [
      () => client.roomStatus('../disown_room/AAAAAAAAAAAAAAAAAAAAAA'),
      () => client.createRoom('..'),
      () => client.sendCommand('a/b', '/help'),
    ]) {
      expect((await failure(call())).code).toBe('INVALID_INPUT')
    }
    expect(mock.state.requests).toEqual([])
  })

  it('gives WEBHOST_ROOM_FAILED when the site opens no room', async () => {
    expect((await failure(makeClient().createRoom(UNKNOWN_ID))).code).toBe('WEBHOST_ROOM_FAILED')
  })

  it('gives NOT_FOUND for a zip that is not there', async () => {
    expect((await failure(makeClient().uploadSeed(join(root, 'missing', 'AP_1.zip')))).code).toBe('NOT_FOUND')
    expect(mock.state.requests).toEqual([])
  })
})

describe('createWebhostClient failures', () => {
  it('network failure gives WEBHOST_UNAVAILABLE within timeout', async () => {
    const hang: RequestHandler = () => undefined
    const server = await startTestServer(hang)
    try {
      const started = Date.now()
      const error = await failure(makeClient({ baseUrl: server.url, timeoutMs: 300 }).roomStatus(UNKNOWN_ID))
      expect(error.code).toBe('WEBHOST_UNAVAILABLE')
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await server.close()
    }

    // Nothing listens there any more: the connection is refused.
    const refused = await failure(makeClient({ baseUrl: server.url }).myRooms())
    expect(refused.code).toBe('WEBHOST_UNAVAILABLE')
  })

  it('a body that stalls after its headers also times out', async () => {
    const server = await startTestServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 100 })
      res.write('{"last_port":')
    })
    try {
      const error = await failure(makeClient({ baseUrl: server.url, timeoutMs: 300 }).roomStatus(UNKNOWN_ID))
      expect(error.code).toBe('WEBHOST_UNAVAILABLE')
    } finally {
      await server.close()
    }
  })

  it('maps 5xx to WEBHOST_UNAVAILABLE, except the upload errors of the site', async () => {
    let status = 502
    const server = await startTestServer((_req, res) => reply(res, status, '<html>Bad Gateway</html>'))
    try {
      const client = makeClient({ baseUrl: server.url })
      expect((await failure(client.roomStatus(UNKNOWN_ID))).code).toBe('WEBHOST_UNAVAILABLE')
      expect((await failure(client.uploadSeed(zipPath))).code).toBe('WEBHOST_UNAVAILABLE')
      // A ROM in the zip makes the real site fail with a 500 (research brief §1.8).
      status = 500
      expect((await failure(client.uploadSeed(zipPath))).code).toBe('WEBHOST_UPLOAD_FAILED')
      status = 413
      const tooLarge = await failure(client.uploadSeed(zipPath))
      expect(tooLarge.code).toBe('WEBHOST_UPLOAD_FAILED')
      expect(tooLarge.params).toEqual({ reason: 'too-large' })
    } finally {
      await server.close()
    }
  })

  it('gives WEBHOST_UNAVAILABLE for a status that is not JSON, and HTTP_ERROR for other refusals', async () => {
    let answer: [number, string] = [200, '<html>captive portal</html>']
    const server = await startTestServer((_req, res) => reply(res, ...answer))
    try {
      const client = makeClient({ baseUrl: server.url })
      expect((await failure(client.roomStatus(UNKNOWN_ID))).code).toBe('WEBHOST_UNAVAILABLE')
      answer = [200, '{"players": "nope"}']
      expect((await failure(client.roomStatus(UNKNOWN_ID))).code).toBe('WEBHOST_UNAVAILABLE')
      answer = [403, 'Forbidden']
      const refused = await failure(client.roomStatus(UNKNOWN_ID))
      expect(refused.code).toBe('HTTP_ERROR')
      expect(refused.params).toMatchObject({ status: 403 })
    } finally {
      await server.close()
    }
  })

  it('keeps an unfinished UTF-8 character for the next log read', async () => {
    const server = await startTestServer((_req, res) => reply(res, 206, Buffer.from([0x61, 0x0a, 0xc3])))
    try {
      expect(await makeClient({ baseUrl: server.url }).readLog(UNKNOWN_ID, 10)).toEqual({
        text: 'a\n',
        nextByte: 12,
      })
    } finally {
      await server.close()
    }
  })

  it('reads a whole log answered without Range support from the requested byte', async () => {
    const server = await startTestServer((_req, res) => reply(res, 200, 'line 1\nline 2\n'))
    try {
      expect(await makeClient({ baseUrl: server.url }).readLog(UNKNOWN_ID, 7)).toEqual({
        text: 'line 2\n',
        nextByte: 14,
      })
    } finally {
      await server.close()
    }
  })

  it('stops at once when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await failure(makeClient().uploadSeed(zipPath, controller.signal))
    expect(error.code).toBe('TASK_CANCELLED')
  })

  it('gives INVALID_INPUT for a site URL that is not one', async () => {
    expect((await failure(makeClient({ baseUrl: 'archipelago dot gg' }).myRooms())).code).toBe(
      'INVALID_INPUT',
    )
  })

  it('skips the room rows it cannot read, and needs an identity link on /session', async () => {
    let session: [number, string] = [200, '<html><p>No identity here</p></html>']
    const rows = [
      { room_id: UNKNOWN_ID, seed_id: null, last_activity: 'Sat, 17 Oct 2026 12:00:00 GMT' },
      { room_id: '../disown_room/x' },
      5,
    ]
    const server = await startTestServer((req, res) =>
      req.url === '/api/get_rooms' ? reply(res, 200, JSON.stringify(rows)) : reply(res, ...session),
    )
    try {
      const client = makeClient({ baseUrl: server.url })
      expect(await client.myRooms()).toEqual([
        {
          roomId: UNKNOWN_ID,
          seedId: null,
          roomUrl: `${server.url}/room/${UNKNOWN_ID}`,
          lastActivity: '2026-10-17T12:00:00.000Z',
        },
      ])
      expect((await failure(client.ownerUrl(UNKNOWN_ID))).code).toBe('WEBHOST_UNAVAILABLE')
      session = [403, 'Forbidden']
      expect((await failure(client.ownerUrl(UNKNOWN_ID))).code).toBe('HTTP_ERROR')
    } finally {
      await server.close()
    }
  })
})
