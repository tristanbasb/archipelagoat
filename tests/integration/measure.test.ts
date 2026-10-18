// The exact check counts of a session, end to end: the real services behind the IPC handlers, the fake
// ArchipelagoGenerate writing a real multidata for each player measured alone.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionChecks } from '@shared/types'
import { createFakeApInstall, createTestCore, type TestCore } from './harness'

const ASH = 'A Short Hike'
const HK = 'Hollow Knight'

let tmp: string
let active: TestCore | undefined
let savedChecks: string | undefined

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'goat-int-measure-'))
  const fakeApDir = await createFakeApInstall(join(tmp, 'fake-ap'), { games: [ASH, HK] })
  // The counts the fake Archipelago gives each game (AP 0.6.8's defaults).
  savedChecks = process.env.FAKE_CHECKS
  process.env.FAKE_CHECKS = JSON.stringify({ [ASH]: 131, [HK]: 203 })
  active = await createTestCore({ tmp, fakeApDir })
})

afterEach(async () => {
  await active?.cleanup()
  active = undefined
  if (savedChecks === undefined) delete process.env.FAKE_CHECKS
  else process.env.FAKE_CHECKS = savedChecks
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

it('measures a session of two players with the fake Archipelago', async () => {
  const core = active
  if (!core) throw new Error('no test core')
  const { id } = await core.call('session:create', { name: 'Mesure' })
  await core.call('session:addText', {
    id,
    fileName: 'Claire.yaml',
    text: `name: Claire\ngame: ${ASH}\n${ASH}: {}\n`,
  })
  const session = await core.call('session:addText', {
    id,
    fileName: 'Knight.yaml',
    text: `name: Knight\ngame: ${HK}\n${HK}: {}\n`,
  })
  const [claire, knight] = session.players

  const measured = await core.waitTask<SessionChecks>(
    await core.call('checks:measureSession', { sessionId: id }),
  )

  expect(measured.players).toEqual([
    {
      fileId: claire?.id,
      docIndex: 0,
      name: 'Claire',
      game: ASH,
      checks: 131,
      range: null,
      source: 'measure',
      error: null,
    },
    {
      fileId: knight?.id,
      docIndex: 0,
      name: 'Knight',
      game: HK,
      checks: 203,
      range: null,
      source: 'measure',
      error: null,
    },
  ])
  expect(await core.call('checks:lastSession', { sessionId: id })).toEqual(measured)
  // Each test generation ran in its own folder, gone now.
  const tmpRoot = join(core.ctx.platform.paths.dataRoot, 'tmp')
  expect(existsSync(tmpRoot) ? readdirSync(tmpRoot) : []).toEqual([])
  // The multidata of the measures fed the estimates.
  expect(await core.call('checks:estimate', { games: [ASH, HK] })).toEqual({
    [ASH]: { max: 131, profiles: null },
    [HK]: { max: 203, profiles: null },
  })
})
