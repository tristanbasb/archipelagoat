// The player's side, end to end: a room link resolved, the room read (and woken) on the mock site, the
// slot's patch downloaded and routed to the BizHawk Client, the checklist, then the fake client started
// with the patch.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApInstall, JoinPlan } from '@shared/types'
import { EMERALD_MD5, makePatchZip, makeSeedZip, patchManifest } from '../helpers/make-patch.mjs'
import { startMockWebhost, type MockWebhost } from '../mock-webhost/server'
import { createFakeApInstall, createTestCore, type TestCore } from './harness'

const ROOM_PORT = 50123

let tmp: string
let site: MockWebhost
let active: TestCore | undefined
let savedRecord: string | undefined

/** The organizer's side, as another identity: uploads a seed and opens its room (not started yet). */
async function openRoom(dir: string): Promise<string> {
  const zip = await makeSeedZip(join(dir, 'AP_123.zip'), {
    seed: '123',
    slots: [
      { name: 'Alice', game: 'Pokemon Emerald', patch: '.apemerald' },
      { name: 'Bob', game: 'A Hat in Time' },
    ],
  })
  const form = new FormData()
  form.set('file', new Blob([readFileSync(zip)]), 'AP_123.zip')
  const upload = await fetch(`${site.url}/uploads`, { method: 'POST', body: form, redirect: 'manual' })
  const seedId = upload.headers.get('location')?.split('/').pop()
  const created = await fetch(`${site.url}/new_room/${seedId}`, { redirect: 'manual' })
  const roomId = created.headers.get('location')?.split('/').pop()
  if (!roomId) throw new Error(`the mock site opened no room (${upload.status}, ${created.status})`)
  return roomId
}

beforeEach(async () => {
  savedRecord = process.env.FAKE_RECORD
  tmp = mkdtempSync(join(tmpdir(), 'goat-int-join-'))
  // The room has no port until it is woken up and polled once more.
  site = await startMockWebhost({ portDelayPolls: 1 })
  site.state.players = [
    ['Alice', 'Pokemon Emerald'],
    ['Bob', 'A Hat in Time'],
  ]
  // What the site serves for Alice: her patch, its `server` rewritten with the room's address.
  const patch = await makePatchZip(
    join(tmp, 'served', 'AP_123_P1_Alice.apemerald'),
    patchManifest({ server: `127.0.0.1:${ROOM_PORT}` }),
  )
  site.state.slotFiles.set(1, readFileSync(patch))
  const fakeApDir = await createFakeApInstall(join(tmp, 'fake-ap'), { games: ['Pokemon Emerald'] })
  active = await createTestCore({ tmp, fakeApDir, webhostUrl: site.url })
})

afterEach(async () => {
  if (savedRecord === undefined) delete process.env.FAKE_RECORD
  else process.env.FAKE_RECORD = savedRecord
  await active?.cleanup()
  active = undefined
  await site.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

it('player: resolve room url → prepare → patch routed to bizhawk → play spawns fake client with patch', async () => {
  const core = active
  if (!core) throw new Error('no test core')
  const roomId = await openRoom(tmp)

  // The link of the room on archipelago.gg; the room is read from the configured site (the mock).
  const target = await core.call('join:resolve', { input: ` https://archipelago.gg/room/${roomId}/ ` })
  expect(target).toEqual({ kind: 'room', roomId })

  // Without a slot: the room is woken up, its port read, its slots listed; nothing is downloaded.
  const choosing = await core.waitTask<JoinPlan>(await core.call('join:prepare', { target }))
  expect(choosing).toMatchObject({
    slots: [
      { name: 'Alice', game: 'Pokemon Emerald' },
      { name: 'Bob', game: 'A Hat in Time' },
    ],
    slot: null,
    patchPath: null,
    connect: { host: '127.0.0.1', port: ROOM_PORT, slot: null },
    ready: false,
  })
  expect(site.state.rooms.get(roomId)?.visits).toBe(1)

  // Alice's slot: her patch downloaded into the room's folder and routed to the BizHawk Client.
  const plan = await core.waitTask<JoinPlan>(await core.call('join:prepare', { target, slotName: 'Alice' }))
  const patchPath = join(core.ctx.platform.paths.dataRoot, 'rooms', roomId, 'P1_Alice.apemerald')
  expect(plan).toMatchObject({
    slot: { name: 'Alice', game: 'Pokemon Emerald' },
    patchPath,
    manifest: { game: 'Pokemon Emerald', playerName: 'Alice', baseChecksums: [EMERALD_MD5] },
    route: { suffix: '.apemerald', client: 'bizhawk', exe: 'ArchipelagoBizHawkClient', tier: 'full' },
    connect: { host: '127.0.0.1', port: ROOM_PORT, slot: 'Alice' },
    warnings: [],
    ready: false,
  })
  expect(existsSync(patchPath)).toBe(true)
  // Archipelago and the world are there; the ROM is not (a test never holds one), nor is BizHawk.
  expect(plan.checklist).toEqual({
    ap: { status: 'ok', code: 'ap-ok' },
    world: { status: 'ok', code: 'world-ok' },
    rom: { status: 'missing', code: 'rom-missing' },
    emulator: { status: 'missing', code: 'emulator-missing' },
  })

  // The emulator fixed: a BizHawk folder chosen, Archipelago's settings pointed at it.
  const bizhawkDir = join(tmp, 'BizHawk')
  const launcher = join(bizhawkDir, core.ctx.platform.os === 'win32' ? 'EmuHawk.exe' : 'EmuHawkMono.sh')
  mkdirSync(bizhawkDir, { recursive: true })
  writeFileSync(launcher, '')
  expect(await core.call('bizhawk:setPath', { path: bizhawkDir })).toMatchObject({
    installed: true,
    managed: false,
    configuredInAp: false,
  })
  expect(await core.call('bizhawk:configureAp')).toMatchObject({ installed: true, configuredInAp: true })
  const refreshed = await core.call('join:refresh', { planId: plan.planId })
  expect(refreshed.checklist.emulator).toEqual({ status: 'ok', code: 'emulator-ok' })

  // JOUER: the BizHawk Client of the install, a window of its own, opening the patch.
  const install = (await core.call('ap:detect')) as ApInstall
  const record = join(tmp, 'client-record.json')
  process.env.FAKE_RECORD = record
  const { pid } = await core.call('join:play', { planId: plan.planId })
  expect(pid).toBeGreaterThan(0)
  await vi.waitFor(() => expect(existsSync(record)).toBe(true), { timeout: 15_000, interval: 100 })
  await vi.waitFor(() => JSON.parse(readFileSync(record, 'utf8')) as unknown, { timeout: 5_000 })
  expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({
    program: 'ArchipelagoBizHawkClient',
    argv: [patchPath],
    cwd: install.paths.userPath,
    runtime: 'node',
  })
})
