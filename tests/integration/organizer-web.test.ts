// The organizer's game hosted on archipelago.gg, end to end: the real services behind the IPC handlers,
// the fake generation, then the mock site (upload, room, wake, port, console, log) as the app's
// identity, which owns what it uploaded.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { WebRoom } from '@shared/types'
import { startMockWebhost, type MockWebhost } from '../mock-webhost/server'
import { createFakeApInstall, createTestCore, organizeFixtureSession, type TestCore } from './harness'

let tmp: string
let site: MockWebhost
let active: TestCore | undefined

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'goat-int-web-'))
  site = await startMockWebhost()
  const fakeApDir = await createFakeApInstall(join(tmp, 'fake-ap'), { games: ['TUNIC'] })
  active = await createTestCore({ tmp, fakeApDir, webhostUrl: site.url })
})

afterEach(async () => {
  await active?.cleanup()
  active = undefined
  await site.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

it('organizer web: generate → host on mock → room port → command → log tail', async () => {
  const core = active
  if (!core) throw new Error('no test core')
  const { session, generation } = await organizeFixtureSession(core, 'Soirée web')

  // Hosting: the generation's zip uploaded once, one room opened, woken, then its port read.
  const ref = await core.call('webhost:host', { sessionId: session.id, consent: true })
  const room = await core.waitTask<WebRoom>(ref)
  const { roomId } = room
  expect(room).toMatchObject({
    roomUrl: `${site.url}/room/${roomId}`,
    host: '127.0.0.1',
    port: 50123,
    players: [
      { name: 'Alice', game: 'A Link to the Past' },
      { name: 'Bob', game: 'TUNIC' },
    ],
  })
  expect([...site.state.seeds.values()]).toEqual([
    expect.objectContaining({
      id: room.seedId,
      fileName: basename(generation.zipPath),
      size: statSync(generation.zipPath).size,
    }),
  ])
  expect(site.state.newRoomCalls).toBe(1)
  const mockRoom = site.state.rooms.get(roomId)
  if (!mockRoom) throw new Error(`the mock site has no room ${roomId}`)
  expect(mockRoom.visits).toBeGreaterThanOrEqual(1)

  // The session keeps its room and the port it got.
  expect(await core.call('session:get', { id: session.id })).toMatchObject({
    status: 'hosting',
    hosting: { mode: 'web', seedId: room.seedId, roomId, roomUrl: room.roomUrl, port: 50123 },
  })
  expect(await core.call('webhost:room', { roomId })).toMatchObject({
    roomId,
    seedId: room.seedId,
    port: 50123,
  })

  // The console: the site keeps only the commands of the room's owner, which the app is.
  await core.call('webhost:command', { roomId, command: '/players' })
  expect(mockRoom.commands).toEqual(['/players'])
  expect(await core.call('webhost:myRooms')).toEqual([
    expect.objectContaining({ roomId, seedId: room.seedId }),
  ])

  // The log, read from the start, then only what was appended since.
  const head = await core.call('webhost:log', { roomId, fromByte: 0 })
  expect(head.text).toBe('Hosting game at 127.0.0.1:50123 (No password)\n')
  expect(head.nextByte).toBe(Buffer.byteLength(head.text))
  const joined = "Notice (all): Zoé (Team #1) playing TUNIC has joined. Client(0.6.8), ['AP'].\n"
  mockRoom.log += joined
  const tail = await core.call('webhost:log', { roomId, fromByte: head.nextByte })
  expect(tail).toEqual({ text: joined, nextByte: Buffer.byteLength(mockRoom.log) })
  expect(await core.call('webhost:log', { roomId, fromByte: tail.nextByte })).toEqual({
    text: '',
    nextByte: tail.nextByte,
  })
})
