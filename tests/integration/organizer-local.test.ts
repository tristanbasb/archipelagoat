// The organizer's local game, end to end: the real services behind the IPC handlers, the fake
// Archipelago (generation and server), from the player files to the save the server writes on stop.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFakeApInstall,
  createTestCore,
  FIXTURE_YAMLS,
  organizeFixtureSession,
  type TestCore,
} from './harness'

let tmp: string
let active: TestCore | undefined

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'goat-int-local-'))
  const fakeApDir = await createFakeApInstall(join(tmp, 'fake-ap'), { games: ['TUNIC'] })
  active = await createTestCore({ tmp, fakeApDir })
})

afterEach(async () => {
  await active?.cleanup()
  active = undefined
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

it('organizer local: create session → add fixture yamls → validate → generate → start server → /players → stop → .apsave exists', async () => {
  const core = active
  if (!core) throw new Error('no test core')
  const { session, added, validation, generation } = await organizeFixtureSession(core, 'Soirée locale')

  // Every fixture is a player file, one of them read as Windows-1252, and nothing blocks.
  expect(added.ignored).toEqual([])
  expect(added.session.players).toHaveLength(FIXTURE_YAMLS.length)
  expect(added.session.players.flatMap((file) => file.docs.map((doc) => doc.name)).sort()).toEqual([
    'Alice',
    'Bob',
    'Goat',
    'Héloïse',
    'Zoé',
  ])
  expect(validation).toMatchObject({ blocking: false, missingWorlds: [], romNeeds: [], sessionIssues: [] })
  const errors = validation.files.flatMap((file) =>
    file.docs.flatMap((doc) => doc.issues.filter((issue) => issue.severity === 'error')),
  )
  expect(errors).toEqual([])
  // The options were checked against the template of the install, and the Windows-1252 file noticed.
  const warnings = validation.files.flatMap((file) =>
    file.docs.flatMap((doc) => doc.issues.map((issue) => `${issue.code} ${issue.path ?? ''}`.trim())),
  )
  expect(warnings).toEqual(
    expect.arrayContaining(['option-unknown TUNIC.death_link_unknown_for_tunic', 'encoding-fallback']),
  )

  // The fake generation: a real AP_<seed>.zip in the session's output, its slots extracted.
  expect(generation.zipPath).toBe(join(session.workspace, 'output', `AP_${generation.seedName}.zip`))
  expect(existsSync(generation.zipPath)).toBe(true)
  expect(generation.slots.map(({ slot, name, game }) => ({ slot, name, game }))).toEqual([
    { slot: 1, name: 'Alice', game: 'Pokemon Emerald' },
    { slot: 2, name: 'Bob', game: 'A Hat in Time' },
  ])
  expect(existsSync(generation.slots[0]?.patchFile ?? '')).toBe(true)
  expect(existsSync(generation.logPath)).toBe(true)
  expect(await core.call('session:get', { id: session.id })).toMatchObject({ status: 'generated' })

  // The local server: ready on a free port of Archipelago's range, its console answering.
  const sessionId = session.id
  const started = await core.call('server:start', { sessionId })
  expect(started).toMatchObject({ sessionId, status: 'ready', resumedFromSave: false, error: null })
  expect(started.port).toBeGreaterThanOrEqual(38281)
  expect(started.addresses[0]).toEqual({ kind: 'localhost', host: 'localhost', port: started.port })
  expect(await core.call('session:get', { id: sessionId })).toMatchObject({
    status: 'hosting',
    hosting: { mode: 'local', port: started.port },
  })

  // The app's item tracker logs in as the first slot; the server then counts Alice as connected.
  await vi.waitFor(
    async () => expect(await core.call('server:get', { sessionId })).toMatchObject({ tracker: 'Alice' }),
    { timeout: 10_000, interval: 100 },
  )
  // The fake holds what it prints until its next log line, as the frozen ArchipelagoServer does: the
  // answer still comes at once.
  await core.call('server:command', { sessionId, command: '/players' })
  await vi.waitFor(
    async () => {
      const { log } = await core.call('server:history', { sessionId })
      expect(log).toContain('1 players of 2 connected :: Team #1: Alice (Bob)')
    },
    { timeout: 2000, interval: 50 },
  )

  // Each item event gets the class the tracker tells (progression, useful, trap, filler).
  await core.call('server:command', { sessionId, command: '/fake_items' })
  await vi.waitFor(
    async () => {
      const { events } = await core.call('server:history', { sessionId })
      expect(events.map(({ item, itemClass }) => `${item}: ${itemClass}`)).toEqual([
        'Umbrella: progression',
        'Rare Candy: useful',
        'Baby Trap: trap',
        '10 Pons: filler',
        'Stone Badge: progression',
      ])
    },
    { timeout: 10_000, interval: 100 },
  )

  // /exit saves the game: the save sits next to the seed, where the next start resumes from.
  await core.call('server:stop', { sessionId })
  expect(await core.call('server:get', { sessionId })).toMatchObject({ status: 'stopped', error: null })
  // MultiServer 0.6.8 names it after the multidata (AP_<seed>.zip → AP_<seed>.apsave).
  const savefile = join(session.workspace, 'output', `AP_${generation.seedName}.apsave`)
  expect(existsSync(savefile)).toBe(true)
  expect((await core.call('session:get', { id: sessionId })).hosting).toEqual({
    mode: 'local',
    port: started.port,
    savefile,
  })
})
