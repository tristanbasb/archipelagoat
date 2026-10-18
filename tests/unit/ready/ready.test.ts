import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessInfo } from '@main/core/ap/processes'
import type { MeasureInput } from '@main/core/checks/measure'
import {
  createReady,
  READY_PLAN_TTL_MS,
  type Ready,
  type ReadyDeps,
  type ReadyRun,
} from '@main/core/ready/ready'
import { createPickedPaths, type PickedPaths } from '@main/core/system/picked-paths'
import type { TaskHandle } from '@main/core/tasks'
import type { ValidationContext } from '@main/core/yaml/validate'
import { createIpcRegistry } from '@main/ipc/registry'
import registerReadyHandlers from '@main/ipc/ready'
import type { ServiceContainer } from '@main/services/registry'
import { AppError } from '@shared/errors'
import type {
  ApInstall,
  CatalogEntry,
  GameProfiles,
  GameSchema,
  OptionChange,
  PlayerFile,
  PlayerMeasure,
  ProfileId,
  Session,
  SessionSummary,
  TaskDone,
  TaskFailed,
  WorldInfo,
  WorldInstallPlan,
} from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'

const ASH = 'A Short Hike'
const HK = 'Hollow Knight'
const OOT = 'Ocarina of Time'
const NAMES: Record<ProfileId, string> = {
  discovery: 'Découverte',
  standard: 'Standard',
  complete: 'Complet',
}

function entryOf(id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id,
    source: 'index',
    game: ASH,
    displayName: ASH,
    homepage: null,
    tags: [],
    supported: true,
    afterDark: false,
    requiresRomAtGeneration: false,
    hasPopTracker: false,
    cover: null,
    wiki: null,
    latest: {
      version: '1.2.0',
      url: `https://github.com/goat/${id}/releases/download/v1.2.0/${id}.apworld`,
      sha256: 'a'.repeat(64),
    },
    download: null,
    installedVersion: null,
    trust: 'indexed-verified',
    ...overrides,
  }
}

const INDEX_ASH = entryOf('ash')
const coreEntry = (game: string): CatalogEntry =>
  entryOf(game.toLowerCase().replace(/\W/g, '_'), {
    game,
    displayName: game,
    latest: null,
    installedVersion: '0.6.8',
    trust: 'core',
  })

const worldInfo = (game: string, worldVersion: string | null): WorldInfo => ({
  id: `custom:${game}`,
  fileName: 'world.apworld',
  path: '/worlds/world.apworld',
  location: 'custom',
  module: 'world',
  game,
  manifest: {
    game,
    worldVersion,
    minimumApVersion: null,
    maximumApVersion: null,
    authors: [],
    version: null,
    compatibleVersion: null,
  },
  states: ['ok'],
  sizeBytes: 1,
})

const schemaOf = (game: string, source: GameSchema['source']): GameSchema => ({
  game,
  source,
  apVersion: '0.6.8',
  groups: [],
  presets: {},
})

/** The heuristic profiles of a game: its Complet is Standard's twin. */
const profilesOf = (game: string): GameProfiles => ({
  game,
  measured: false,
  profiles: [
    { id: 'discovery', changes: [{ key: 'goal', from: 'nap', to: 'races' }], checks: null, range: null },
    { id: 'standard', changes: [], checks: null, range: null },
  ],
})

/** The refined profiles of a game: other changes, and their checks. */
const refinedOf = (game: string): GameProfiles => ({
  game,
  measured: true,
  profiles: [
    { id: 'discovery', changes: [{ key: 'golden_feathers', from: 20, to: 10 }], checks: 111, range: null },
    { id: 'standard', changes: [], checks: 203, range: null },
    { id: 'complete', changes: [{ key: 'golden_feathers', from: 20, to: 30 }], checks: 217, range: null },
  ],
})

/** The changes of a profile among `profiles`; Standard's for one left out. */
const changesOf = (profiles: GameProfiles, id: ProfileId): OptionChange[] =>
  (profiles.profiles.find((one) => one.id === id) ?? profiles.profiles.find((one) => one.id === 'standard'))
    ?.changes ?? []

/** The YAML the fake profiles write: what Profiles.yamlFor writes, only the profile's changes as options. */
const yamlOf = (game: string, profile: ProfileId, playerName: string, changes: OptionChange[] = []): string =>
  [
    `name: ${playerName === '' ? 'Player{number}' : playerName}`,
    `description: ArchipelaGOAT · ${NAMES[profile]}`,
    `game: ${game}`,
    `${game}:`,
    '  progression_balancing: 50',
    ...changes.map(({ key, to }) => `  ${key}: ${String(to)}`),
    '',
  ].join('\n')

/** A player file of a session, with one player of that name. */
const playerFile = (storedName: string, name: string | null): PlayerFile => ({
  id: storedName,
  originalName: storedName,
  storedName,
  docs: [{ index: 0, name, games: [], issues: [] }],
  addedAt: '2026-10-18T20:00:00.000Z',
})

const session = (id: string, name: string, status: SessionSummary['status']): SessionSummary => ({
  id,
  name,
  status,
  playerCount: 0,
  updatedAt: '2026-10-18T20:00:00.000Z',
  hostingMode: null,
})

function taskHandle(): {
  handle: TaskHandle
  stages: string[]
  /** Every progress, with its percent and detail. */
  reports: Parameters<TaskHandle['progress']>[]
  controller: AbortController
} {
  const stages: string[] = []
  const reports: Parameters<TaskHandle['progress']>[] = []
  const controller = new AbortController()
  return {
    stages,
    reports,
    controller,
    handle: {
      id: 't',
      signal: controller.signal,
      progress: (...report) => {
        stages.push(report[0])
        reports.push(report)
      },
      log: () => undefined,
    },
  }
}

/** The stages a task went through, each once in a row. */
const stagesOf = (task: { stages: string[] }): string[] =>
  task.stages.filter((stage, i) => stage !== task.stages[i - 1])

let root: string
let core: TestCore
let install: ApInstall | null
let entries: Map<string, CatalogEntry>
/** Game → world version, as Worlds.installedGames answers. */
let games: Map<string, { worldVersion: string | null }>
/** The game each catalog id's world declares in its manifest, when not the catalog's. */
let manifestGames: Map<string, string>
let localTemplates: Set<string>
let siteTemplates: Set<string>
let processes: ProcessInfo[]
let sessions: SessionSummary[]
let measure: (input: MeasureInput) => Promise<PlayerMeasure>
/** The games refined: their profiles as kept. */
let kept: Map<string, GameProfiles>
/** What refining a game gives (kept then). */
let refine: (game: string, task: TaskHandle) => Promise<GameProfiles>
let yaml: (game: string, profile: ProfileId, playerName: string, changes: OptionChange[]) => string
/** Each install, regeneration, YAML, measure and delivery, in order. */
let calls: string[]
let measured: MeasureInput[]
let added: { id: string; fileName: string; text: string }[]
/** The player files each session had before the test's deliveries. */
let players: Map<string, PlayerFile[]>
let clock: number
/** Called after a world is installed (a cancellation at that moment). */
let afterConfirm: () => void
/** The files the save dialog gave. */
let picked: PickedPaths
let ready: Ready

function makeDeps(): ReadyDeps {
  const staged = new Map<string, CatalogEntry>()
  return {
    catalog: { lookup: (id) => entries.get(id) ?? null },
    locator: { detect: () => Promise.resolve(install) },
    worlds: {
      installedGames: () => Promise.resolve(new Map(games)),
      prepare: (source, task) => {
        const entry = source.kind === 'catalog' ? entries.get(source.id) : undefined
        if (!entry) return Promise.reject(new AppError('NOT_FOUND'))
        const planId = `w${staged.size + 1}`
        calls.push(`prepare ${entry.id}`)
        task.progress('download', 0)
        task.progress('inspect', null)
        staged.set(planId, entry)
        const plan: WorldInstallPlan = {
          planId,
          source,
          module: entry.id,
          targetFileName: `${entry.id}.apworld`,
          manifest: null,
          sha256: 'a'.repeat(64),
          trust: entry.trust,
          homepage: null,
          origin: entry.latest?.url ?? null,
          conflicts: [],
          warnings: [],
        }
        return Promise.resolve(plan)
      },
      confirm: (planId) => {
        const entry = staged.get(planId)
        if (!entry) return Promise.reject(new AppError('NOT_FOUND'))
        calls.push(`confirm ${planId}`)
        const game = manifestGames.get(entry.id) ?? entry.game
        const version = entry.latest?.version ?? null
        games.set(game, { worldVersion: version })
        afterConfirm()
        return Promise.resolve({ world: worldInfo(game, version), restartNeeded: processes.length > 0 })
      },
    },
    templates: {
      getSchema: (game) => {
        if (localTemplates.has(game)) return Promise.resolve(schemaOf(game, 'local'))
        if (siteTemplates.has(game)) return Promise.resolve(schemaOf(game, 'site'))
        return Promise.reject(new AppError('NOT_FOUND', { game }))
      },
      regenerate: (task) => {
        calls.push('regenerate')
        task.progress('scan')
        task.progress('generate')
        for (const game of games.keys()) localTemplates.add(game)
        task.progress('done', 100)
        return Promise.resolve({ count: localTemplates.size })
      },
    },
    profiles: {
      get: (game) =>
        localTemplates.has(game) || siteTemplates.has(game)
          ? Promise.resolve(kept.get(game) ?? profilesOf(game))
          : Promise.reject(new AppError('CHECKS_NO_SCHEMA', { game })),
      refineNow: async (game, task) => {
        calls.push(`refine ${game}`)
        const refined = await refine(game, task)
        kept.set(game, refined)
        return refined
      },
      yamlFor: (game, profile, playerName) => {
        calls.push(`yamlFor ${game} ${profile} ${playerName}`)
        const changes = changesOf(kept.get(game) ?? profilesOf(game), profile)
        return Promise.resolve(yaml(game, profile, playerName, changes))
      },
    },
    measurer: {
      measureDoc: (input) => {
        calls.push(`measure ${input.game}`)
        measured.push(input)
        return measure(input)
      },
    },
    sessions: {
      list: () => Promise.resolve([...sessions]),
      create: (name) => {
        calls.push(`create ${name}`)
        const id = `s_new${sessions.length}`
        sessions.unshift(session(id, name, 'draft'))
        return Promise.resolve({ id, name } as Session)
      },
      get: (id) => {
        if (!sessions.some((s) => s.id === id)) return Promise.reject(new AppError('NOT_FOUND'))
        const delivered = added.filter((file) => file.id === id)
        const files = delivered.map(({ fileName, text }) =>
          playerFile(fileName, /^name: (.*)$/m.exec(text)?.[1] ?? null),
        )
        return Promise.resolve({ id, players: [...(players.get(id) ?? []), ...files] } as Session)
      },
      addText: (id, fileName, text) => {
        calls.push(`addText ${id} ${fileName}`)
        if (!sessions.some((s) => s.id === id)) return Promise.reject(new AppError('NOT_FOUND'))
        added.push({ id, fileName, text })
        return Promise.resolve({ id } as Session)
      },
    },
    pickedPaths: { has: (path) => picked.has(path) },
    validationContext: (): Promise<ValidationContext> =>
      Promise.resolve({
        installedGames: new Map(games),
        apVersion: '0.6.8',
        schemaFor: () => undefined,
        allowQuantity: false,
        plandoEnabled: [],
      }),
    listProcesses: () => Promise.resolve([...processes]),
    now: () => clock,
  }
}

const runOf = (planId: string, overrides: Partial<ReadyRun> = {}): ReadyRun => ({
  planId,
  profile: 'standard',
  playerName: 'Tristan',
  destination: { kind: 'session', sessionId: 's1' },
  update: false,
  trustAccepted: false,
  ...overrides,
})

/** Prepares `entryId` and runs its plan to the end. */
async function readyFor(entryId: string, overrides: Partial<ReadyRun> = {}) {
  const plan = await ready.prepare(entryId)
  const task = taskHandle()
  const outcome = await ready.run(runOf(plan.planId, overrides), task.handle)
  return { plan, outcome, stages: stagesOf(task) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat ready é-'))
  core = createTestContext(root)
  install = {
    kind: 'custom',
    version: '0.6.8',
    root: join(root, 'Archipelago'),
    appImagePath: null,
    paths: {} as ApInstall['paths'],
  }
  entries = new Map([
    [INDEX_ASH.id, INDEX_ASH],
    ['hollow_knight', coreEntry(HK)],
    ['ocarina_of_time', coreEntry(OOT)],
  ])
  games = new Map([
    [HK, { worldVersion: null }],
    [OOT, { worldVersion: null }],
  ])
  manifestGames = new Map()
  localTemplates = new Set([HK])
  siteTemplates = new Set()
  processes = []
  sessions = [session('s1', 'Vendredi', 'draft'), session('s2', 'Hier', 'generated')]
  measure = () => Promise.resolve({ checks: 131, range: null, error: null })
  kept = new Map()
  refine = (game, task) => {
    // The measures of a refinement, as Profiles.refine reports them.
    task.progress('generate', 50, { done: 2, total: 4 })
    return Promise.resolve(refinedOf(game))
  }
  yaml = yamlOf
  calls = []
  measured = []
  added = []
  players = new Map()
  clock = 1_000_000
  afterConfirm = () => undefined
  picked = createPickedPaths(core.platform.os)
  ready = createReady(core.ctx, makeDeps())
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ready', () => {
  it('prepare reports a missing Archipelago without changing anything', async () => {
    install = null
    games.clear()
    const plan = await ready.prepare(INDEX_ASH.id)
    expect(plan).toEqual({
      planId: expect.any(String) as string,
      entryId: INDEX_ASH.id,
      game: ASH,
      apInstalled: false,
      installed: false,
      updateAvailable: false,
      trust: 'indexed-verified',
      needsTrustConsent: false,
      // No option schema before the world is installed: no profile yet.
      profiles: { game: ASH, profiles: [], measured: false },
      // The sessions being prepared only.
      sessions: [{ id: 's1', name: 'Vendredi' }],
      notes: { romRequired: false, popTracker: false, setupUrl: null, apRunning: false },
    })
    expect(calls).toEqual([])

    // Running it installs nothing either.
    await expect(ready.run(runOf(plan.planId), taskHandle().handle)).rejects.toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
    expect(calls).toEqual([])
    await expect(ready.prepare('nowhere')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('an index world runs download, inspect, install, templates, profile, validate, deliver in order', async () => {
    entries.set(
      INDEX_ASH.id,
      entryOf(INDEX_ASH.id, {
        requiresRomAtGeneration: true,
        hasPopTracker: true,
        wiki: {
          title: ASH,
          url: 'https://archipelago.miraheze.org/wiki/A_Short_Hike',
          status: 'Stable',
          maintainer: null,
          setupUrl: 'https://archipelago.miraheze.org/wiki/A_Short_Hike/Setup',
        },
      }),
    )
    const { plan, outcome, stages } = await readyFor(INDEX_ASH.id, {
      profile: 'discovery',
      destination: { kind: 'session', sessionId: 's1' },
    })
    expect(plan).toMatchObject({
      apInstalled: true,
      installed: false,
      updateAvailable: false,
      notes: {
        romRequired: true,
        popTracker: true,
        setupUrl: 'https://archipelago.miraheze.org/wiki/A_Short_Hike/Setup',
        apRunning: false,
      },
    })
    expect(stages).toEqual([
      'download',
      'inspect',
      'install',
      'templates',
      'profile',
      'validate',
      'deliver',
      'done',
    ])
    expect(calls).toEqual([
      'prepare ash',
      'confirm w1',
      'regenerate',
      `refine ${ASH}`,
      `yamlFor ${ASH} discovery Tristan`,
      `measure ${ASH}`,
      `addText s1 Tristan - ${ASH}.yaml`,
    ])
    const text = yamlOf(ASH, 'discovery', 'Tristan', changesOf(refinedOf(ASH), 'discovery'))
    expect(added).toEqual([{ id: 's1', fileName: `Tristan - ${ASH}.yaml`, text }])
    expect(outcome).toEqual({
      game: ASH,
      profile: 'discovery',
      checks: 131,
      text,
      delivered: { kind: 'session', sessionId: 's1' },
      playerName: 'Tristan',
      restartNeeded: false,
      refinementFailed: false,
    })
  })

  it('a core or installed world skips the install steps; update installs the newer one', async () => {
    const official = await readyFor('hollow_knight')
    expect(official.plan).toMatchObject({ game: HK, installed: true, updateAvailable: false, trust: 'core' })
    expect(official.plan.profiles).toEqual(profilesOf(HK))
    expect(official.stages).toEqual(['templates', 'profile', 'validate', 'deliver', 'done'])
    expect(calls).toEqual([
      `yamlFor ${HK} standard Tristan`,
      `measure ${HK}`,
      `addText s1 Tristan - ${HK}.yaml`,
    ])

    // A world installed at an older version than the catalog's: installed again only on request.
    games.set(ASH, { worldVersion: '1.0.0' })
    localTemplates.add(ASH)
    calls = []
    const kept = await readyFor(INDEX_ASH.id, { update: false })
    expect(kept.plan).toMatchObject({ installed: true, updateAvailable: true })
    expect(kept.stages[0]).toBe('templates')
    expect(calls.filter((call) => /^(prepare|confirm)/.test(call))).toEqual([])
    expect(games.get(ASH)).toEqual({ worldVersion: '1.0.0' })

    const updated = await readyFor(INDEX_ASH.id, { update: true })
    expect(updated.stages.slice(0, 3)).toEqual(['download', 'inspect', 'install'])
    expect(calls.filter((call) => /^(prepare|confirm)/.test(call))).toEqual(['prepare ash', 'confirm w1'])
    expect(games.get(ASH)).toEqual({ worldVersion: '1.2.0' })

    // Up to date: nothing to update, whatever is asked.
    calls = []
    const current = await readyFor(INDEX_ASH.id, { update: true })
    expect(current.plan.updateAvailable).toBe(false)
    expect(calls.filter((call) => /^(prepare|confirm)/.test(call))).toEqual([])
  })

  it('wiki-release and unknown worlds require trustAccepted (INVALID_INPUT otherwise); indexed-verified and core do not', async () => {
    // A world only the wiki lists, whose manifest names its game otherwise than the wiki page does.
    const wiki = entryOf('wiki:Pokemon Emerald', {
      source: 'wiki',
      game: 'Pokemon Emerald',
      displayName: 'Pokemon Emerald',
      latest: null,
      download: {
        kind: 'github-latest',
        repo: 'goat/emerald',
        pageUrl: 'https://archipelago.miraheze.org/wiki/Pokemon_Emerald',
      },
      trust: 'wiki-release',
    })
    manifestGames.set(wiki.id, 'Pokémon Emerald')
    entries.set(wiki.id, wiki)
    entries.set('stranger', entryOf('stranger', { game: 'Stranger', trust: 'unknown' }))

    const yamlGames: string[] = []
    for (const id of [wiki.id, 'stranger']) {
      const plan = await ready.prepare(id)
      expect(plan.needsTrustConsent, id).toBe(true)
      calls = []
      await expect(ready.run(runOf(plan.planId), taskHandle().handle)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
      expect(calls, id).toEqual([])
      // The same plan, once the warning is accepted.
      const outcome = await ready.run(runOf(plan.planId, { trustAccepted: true }), taskHandle().handle)
      expect(
        calls.filter((call) => /^(prepare|confirm)/.test(call)),
        id,
      ).toHaveLength(2)
      yamlGames.push(outcome.game)
    }
    // The YAML is for the game the installed world declares.
    expect(yamlGames).toEqual(['Pokémon Emerald', 'Stranger'])
    expect(added.map((file) => file.fileName)).toContain('Tristan - Pokémon Emerald.yaml')

    // Installed already and not updated: nothing to install, nothing to accept.
    const again = await ready.prepare(wiki.id)
    expect(again).toMatchObject({ game: 'Pokémon Emerald', installed: true, needsTrustConsent: true })
    await expect(ready.run(runOf(again.planId), taskHandle().handle)).resolves.toMatchObject({
      game: 'Pokémon Emerald',
    })

    for (const id of [INDEX_ASH.id, 'hollow_knight']) {
      const plan = await ready.prepare(id)
      expect(plan.needsTrustConsent, id).toBe(false)
      await expect(ready.run(runOf(plan.planId), taskHandle().handle)).resolves.toMatchObject({
        delivered: { kind: 'session', sessionId: 's1' },
      })
    }

    // The trust the catalog tells when the world is downloaded counts, not the plan's: a release
    // without a checksum since the plan was made is an unknown world.
    games.delete(ASH)
    const stale = await ready.prepare(INDEX_ASH.id)
    expect(stale.needsTrustConsent).toBe(false)
    entries.set(INDEX_ASH.id, entryOf(INDEX_ASH.id, { trust: 'unknown' }))
    calls = []
    await expect(ready.run(runOf(stale.planId), taskHandle().handle)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      params: { reason: 'trust' },
    })
    expect(calls.filter((call) => call.startsWith('confirm'))).toEqual([])
    expect(games.has(ASH)).toBe(false)
    await ready.run(runOf(stale.planId, { trustAccepted: true }), taskHandle().handle)
    expect(games.has(ASH)).toBe(true)
  })

  it('regenerates the templates only when the game has none', async () => {
    await readyFor('hollow_knight')
    expect(calls).not.toContain('regenerate')

    // Only the site's template: Archipelago writes its own.
    siteTemplates.add(OOT)
    const { outcome, stages } = await readyFor('ocarina_of_time')
    expect(calls.filter((call) => call === 'regenerate')).toHaveLength(1)
    expect(localTemplates.has(OOT)).toBe(true)
    // The regeneration's own stages stay within the templates step.
    expect(stages).toEqual(['templates', 'profile', 'validate', 'deliver', 'done'])
    expect(outcome.game).toBe(OOT)
  })

  it('the profile step measures once and a failed measure leaves checks null without failing', async () => {
    const { outcome } = await readyFor('hollow_knight', { playerName: '' })
    const text = yamlOf(HK, 'standard', '')
    expect(measured).toEqual([
      { sessionId: null, game: HK, yamlText: text, task: expect.anything() as unknown },
    ])
    expect(outcome.checks).toBe(131)

    measured = []
    measure = () =>
      Promise.resolve({ checks: null, range: null, error: { code: 'AP_ROM_MISSING', params: { game: HK } } })
    const failed = await readyFor('hollow_knight', { playerName: '' })
    expect(measured).toHaveLength(1)
    expect(failed.outcome).toMatchObject({ checks: null, text, delivered: { kind: 'session' } })
    // Without a player name the YAML is Player{number}'s, the file plain "Player".
    expect(added.at(-1)?.fileName).toBe(`Player - ${HK}.yaml`)
  })

  it('a profile left out as equal to Standard delivers Standard and says so', async () => {
    // Refined, the game has no Complet profile: it is Standard's twin.
    refine = (game) => Promise.resolve({ ...refinedOf(game), profiles: refinedOf(game).profiles.slice(0, 2) })
    const { outcome } = await readyFor('hollow_knight', { profile: 'complete' })
    expect(calls).toEqual([
      `refine ${HK}`,
      `yamlFor ${HK} standard Tristan`,
      `measure ${HK}`,
      `addText s1 Tristan - ${HK}.yaml`,
    ])
    expect(outcome).toMatchObject({
      profile: 'standard',
      text: yamlOf(HK, 'standard', 'Tristan'),
      refinementFailed: false,
    })
    expect(outcome.text).toContain('description: ArchipelaGOAT · Standard')
  })

  it('Découverte or Complet not refined yet waits for the refinement and delivers the refined profile', async () => {
    measure = () => Promise.resolve({ checks: 111, range: null, error: null })
    const plan = await ready.prepare('hollow_knight')
    const task = taskHandle()
    const outcome = await ready.run(runOf(plan.planId, { profile: 'discovery' }), task.handle)
    expect(calls).toEqual([
      `refine ${HK}`,
      `yamlFor ${HK} discovery Tristan`,
      `measure ${HK}`,
      `addText s1 Tristan - ${HK}.yaml`,
    ])
    // The refinement's measures move the bar of the profile step, which then writes and measures the YAML.
    expect(task.reports).toContainEqual(['profile', 50, { done: 2, total: 4 }])
    expect(task.reports.at(task.reports.findIndex(([stage]) => stage === 'validate') - 1)).toEqual([
      'profile',
      null,
    ])
    const text = yamlOf(HK, 'discovery', 'Tristan', changesOf(refinedOf(HK), 'discovery'))
    expect(text).toContain('golden_feathers: 10')
    expect(outcome).toMatchObject({ profile: 'discovery', checks: 111, text, refinementFailed: false })
    expect(added.at(-1)?.text).toBe(text)

    // Refined now: Complet is made at once, and Standard never waits for anything.
    calls = []
    const complete = await readyFor('hollow_knight', { profile: 'complete' })
    expect(complete.outcome.text).toContain('golden_feathers: 30')
    kept.clear()
    await readyFor('hollow_knight', { profile: 'standard' })
    expect(calls.filter((call) => call.startsWith('refine'))).toEqual([])
  })

  it('a refinement that fails delivers the heuristic profile and says so', async () => {
    refine = () => Promise.reject(new AppError('AP_ROM_MISSING', { game: HK }))
    const failed = await readyFor('hollow_knight', { profile: 'discovery' })
    expect(failed.stages).toEqual(['templates', 'profile', 'validate', 'deliver', 'done'])
    expect(failed.outcome).toMatchObject({
      profile: 'discovery',
      text: yamlOf(HK, 'discovery', 'Tristan', changesOf(profilesOf(HK), 'discovery')),
      delivered: { kind: 'session', sessionId: 's1' },
      refinementFailed: true,
    })

    // Its background task cancelled (the app quitting) while the run goes on: as failed.
    refine = () => Promise.reject(new AppError('TASK_CANCELLED'))
    expect((await readyFor('hollow_knight', { profile: 'discovery' })).outcome.refinementFailed).toBe(true)

    // Standard delivered for a heuristic Complet that is its twin: nothing unrefined to tell.
    const twin = await readyFor('hollow_knight', { profile: 'complete' })
    expect(twin.outcome).toMatchObject({ profile: 'standard', refinementFailed: false })
  })

  it('cancelled while it waits for the refinement, the run delivers nothing; a retry waits again', async () => {
    let waiting: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      waiting = resolve
    })
    // Profiles.refineNow stops waiting once the task is cancelled.
    refine = (_game, task) =>
      new Promise((_, reject) => {
        task.signal.addEventListener('abort', () => reject(new AppError('TASK_CANCELLED')))
        waiting()
      })
    const plan = await ready.prepare('hollow_knight')
    const first = taskHandle()
    const run = ready.run(runOf(plan.planId, { profile: 'discovery' }), first.handle)
    await started
    first.controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    expect(calls).toEqual([`refine ${HK}`])
    expect(added).toEqual([])

    refine = (game) => Promise.resolve(refinedOf(game))
    const retry = taskHandle()
    const outcome = await ready.run(runOf(plan.planId, { profile: 'discovery' }), retry.handle)
    expect(stagesOf(retry)).toEqual(['profile', 'validate', 'deliver', 'done'])
    expect(calls.filter((call) => call.startsWith('refine'))).toHaveLength(2)
    expect(outcome).toMatchObject({ profile: 'discovery', refinementFailed: false })
    expect(outcome.text).toContain('golden_feathers: 10')
  })

  it('an invalid YAML stops at validate', async () => {
    yaml = (game, profile, playerName) => yamlOf(game, profile, playerName).split(`${game}:`)[0] ?? ''
    const plan = await ready.prepare('hollow_knight')
    const task = taskHandle()
    await expect(ready.run(runOf(plan.planId), task.handle)).rejects.toMatchObject({
      code: 'AP_YAML_INVALID',
      detail: expect.stringContaining('game-section-missing') as string,
    })
    expect(stagesOf(task).at(-1)).toBe('validate')
    expect(calls.some((call) => call.startsWith('addText'))).toBe(false)
  })

  it('delivers to an existing session, a new session, a file (path checked with assertUserPath) and the Studio (text only)', async () => {
    const text = yamlOf(HK, 'standard', 'Tristan')
    const existing = await readyFor('hollow_knight', { destination: { kind: 'session', sessionId: 's1' } })
    expect(existing.outcome.delivered).toEqual({ kind: 'session', sessionId: 's1' })

    calls = []
    const created = await readyFor('hollow_knight', { destination: { kind: 'new-session', name: 'Samedi' } })
    expect(calls.slice(-2)).toEqual(['create Samedi', `addText s_new2 Tristan - ${HK}.yaml`])
    expect(created.outcome.delivered).toEqual({ kind: 'session', sessionId: 's_new2' })

    // A file: the path the save dialog gave, checked again before anything is written.
    const dir = join(root, 'mes yaml é')
    mkdirSync(dir)
    const plan = await ready.prepare('hollow_knight')
    await expect(
      ready.run(
        runOf(plan.planId, { destination: { kind: 'file', path: join(dir, 'joueur.txt') } }),
        taskHandle().handle,
      ),
    ).rejects.toMatchObject({ code: 'PATH_FORBIDDEN' })
    // A YAML path no save dialog gave: refused, nothing written (Ruling 27).
    const file = join(dir, `Tristan - ${HK}.yaml`)
    await expect(
      ready.run(runOf(plan.planId, { destination: { kind: 'file', path: file } }), taskHandle().handle),
    ).rejects.toMatchObject({ code: 'PATH_FORBIDDEN', params: { reason: 'not-picked' } })
    expect(existsSync(file)).toBe(false)
    picked.add(file)
    calls = []
    const task = taskHandle()
    const saved = await ready.run(
      runOf(plan.planId, { destination: { kind: 'file', path: file } }),
      task.handle,
    )
    expect(saved.delivered).toEqual({ kind: 'file', path: file })
    expect(readFileSync(file, 'utf8')).toBe(text)
    // Only the delivery was left to do.
    expect(stagesOf(task)).toEqual(['deliver', 'done'])
    expect(calls).toEqual([])

    calls = []
    const studio = await readyFor('hollow_knight', { destination: { kind: 'studio' } })
    expect(studio.outcome).toMatchObject({ text, delivered: { kind: 'studio' } })
    expect(calls.some((call) => /^(addText|create)/.test(call))).toBe(false)

    // A plan delivered answers its outcome again, delivering nothing twice.
    calls = []
    const twice = await ready.run(
      runOf(plan.planId, { destination: { kind: 'studio' } }),
      taskHandle().handle,
    )
    expect(twice).toEqual(saved)
    expect(calls).toEqual([])
  })

  it('delivers into a session under the next free name when one of its players has that name', async () => {
    // Two games for one player: the session has a Tristan already, and Archipelago ignores case.
    players.set('s1', [playerFile('tristan.yaml', 'tristan')])
    const first = await readyFor('hollow_knight')
    const renamed = yamlOf(HK, 'standard', 'Tristan2')
    expect(first.outcome).toMatchObject({
      playerName: 'Tristan2',
      text: renamed,
      delivered: { kind: 'session', sessionId: 's1' },
    })
    expect(added).toEqual([{ id: 's1', fileName: `Tristan2 - ${HK}.yaml`, text: renamed }])
    // Only the name changes: the YAML measured and validated is the one asked for.
    expect(calls.filter((call) => call.startsWith('yamlFor'))).toEqual([`yamlFor ${HK} standard Tristan`])

    // Tristan2 is taken now too.
    expect((await readyFor('hollow_knight')).outcome.playerName).toBe('Tristan3')

    // Sixteen characters at most: the name is cut to make room for the number.
    players.set('s1', [playerFile('chevalier.yaml', 'Chevalier Errant')])
    const long = await readyFor('hollow_knight', { playerName: 'Chevalier Errant' })
    expect(long.outcome.playerName).toBe('Chevalier Erran2')
    expect(added.at(-1)?.text).toBe(yamlOf(HK, 'standard', 'Chevalier Erran2'))

    // A new session, a name nobody has, Player{number}, or no session at all: the name asked for.
    const fresh = await readyFor('hollow_knight', { destination: { kind: 'new-session', name: 'Samedi' } })
    expect(fresh.outcome.playerName).toBe('Tristan')
    expect((await readyFor('hollow_knight', { playerName: 'Lucie' })).outcome.playerName).toBe('Lucie')
    const numbered = await readyFor('hollow_knight', { playerName: '' })
    expect(numbered.outcome).toMatchObject({ playerName: '', text: yamlOf(HK, 'standard', '') })
    players.set('s1', [playerFile('tristan.yaml', 'Tristan')])
    const studio = await readyFor('hollow_knight', { destination: { kind: 'studio' } })
    expect(studio.outcome).toMatchObject({ playerName: 'Tristan', text: yamlOf(HK, 'standard', 'Tristan') })
  })

  it('cancel after install keeps the world and delivers nothing; retry resumes at the profile step', async () => {
    const plan = await ready.prepare(INDEX_ASH.id)
    let measuring: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      measuring = resolve
    })
    // A measure stops with the task, as the measurer does.
    measure = (input) =>
      new Promise((_, reject) => {
        input.task.signal.addEventListener('abort', () => reject(new AppError('TASK_CANCELLED')))
        measuring()
      })
    const failed = new Promise<TaskFailed>((resolve) => core.ctx.bus.on('task:failed', resolve))
    const ref = core.ctx.tasks.start('ready', (task) => ready.run(runOf(plan.planId), task))
    await started
    core.ctx.tasks.cancel(ref.taskId)
    expect(await failed).toMatchObject({ kind: 'ready', error: { code: 'TASK_CANCELLED' } })
    // The world stays installed; nothing was delivered.
    expect(games.get(ASH)).toEqual({ worldVersion: '1.2.0' })
    expect(added).toEqual([])

    // Réessayer: the same plan goes on where it stopped (right away: the first run is still settling).
    measure = () => Promise.resolve({ checks: 131, range: null, error: null })
    const retry = taskHandle()
    const outcome = await ready.run(runOf(plan.planId), retry.handle)
    expect(stagesOf(retry)).toEqual(['profile', 'validate', 'deliver', 'done'])
    expect(calls.filter((call) => /^(prepare|confirm|regenerate)/.test(call))).toEqual([
      'prepare ash',
      'confirm w1',
      'regenerate',
    ])
    expect(added).toHaveLength(1)
    expect(outcome.checks).toBe(131)

    // Cancelled the moment the world is installed: it stays, and the retry starts after it.
    games.delete(ASH)
    localTemplates.delete(ASH)
    calls = []
    const next = await ready.prepare(INDEX_ASH.id)
    const first = taskHandle()
    afterConfirm = () => first.controller.abort()
    await expect(ready.run(runOf(next.planId), first.handle)).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
    })
    afterConfirm = () => undefined
    expect(games.has(ASH)).toBe(true)
    const second = taskHandle()
    await ready.run(runOf(next.planId), second.handle)
    expect(stagesOf(second)[0]).toBe('templates')
    expect(calls.filter((call) => /^(prepare|confirm)/.test(call))).toEqual(['prepare ash', 'confirm w2'])
  })

  it('restartNeeded is true when Archipelago programs run', async () => {
    processes = [{ pid: 4242, name: 'ArchipelagoLauncher.exe' }]
    const installed = await readyFor(INDEX_ASH.id)
    expect(installed.plan.notes.apRunning).toBe(true)
    expect(installed.outcome.restartNeeded).toBe(true)

    // Nothing installed: nothing to restart for.
    const coreWorld = await readyFor('hollow_knight')
    expect(coreWorld.outcome.restartNeeded).toBe(false)

    processes = []
    games.delete(ASH)
    const quiet = await readyFor(INDEX_ASH.id)
    expect(quiet.plan.notes.apRunning).toBe(false)
    expect(quiet.outcome.restartNeeded).toBe(false)
  })

  it('keeps a plan for an hour', async () => {
    const plan = await ready.prepare('hollow_knight')
    clock += READY_PLAN_TTL_MS
    await expect(ready.run(runOf(plan.planId), taskHandle().handle)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(calls).toEqual([])
  })

  it('ready:prepare and ready:run go through the contract, as a ready task', async () => {
    const meta = { senderId: 1 }
    const ipc = createIpcRegistry()
    const container = {
      ctx: core.ctx,
      get: (name: string) => (name === 'ready' ? ready : undefined),
      startEager: () => undefined,
    } as unknown as ServiceContainer
    registerReadyHandlers(ipc.registerHandler, container)

    expect(await ipc.dispatch('ready:prepare', { entryId: '' }, meta)).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    const prepared = await ipc.dispatch('ready:prepare', { entryId: 'hollow_knight' }, meta)
    if (!prepared.ok) throw new Error('ready:prepare failed')
    const { planId } = prepared.value as { planId: string }
    const input = runOf(planId)
    expect(await ipc.dispatch('ready:run', { ...input, playerName: 'x'.repeat(17) }, meta)).toMatchObject({
      error: { code: 'INVALID_INPUT' },
    })
    expect(
      await ipc.dispatch('ready:run', { ...input, destination: { kind: 'new-session', name: '  ' } }, meta),
    ).toMatchObject({ error: { code: 'INVALID_INPUT' } })

    const done = new Promise<TaskDone>((resolve) => core.ctx.bus.on('task:done', resolve))
    expect(await ipc.dispatch('ready:run', { ...input, playerName: ' Tristan ' }, meta)).toMatchObject({
      ok: true,
      value: { taskId: expect.any(String) as string },
    })
    expect(await done).toMatchObject({
      kind: 'ready',
      result: { game: HK, delivered: { kind: 'session', sessionId: 's1' } },
    })
    expect(added.at(-1)?.fileName).toBe(`Tristan - ${HK}.yaml`)
  })
})
