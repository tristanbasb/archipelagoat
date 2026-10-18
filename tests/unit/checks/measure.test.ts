import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseAllDocuments } from 'yaml'
import type { Locator } from '@main/core/ap/locator'
import { listChildren, type ApExit, type SpawnApOptions, type spawnAp } from '@main/core/ap/process'
import { createApSettings, type SettingsEntry } from '@main/core/ap/settings'
import { createCheckEstimates, type CheckEstimates } from '@main/core/checks/datapackage'
import { createMeasurer, isWeighted, type Measurer, type MeasurerDeps } from '@main/core/checks/measure'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import { buildValidationContext, type ValidationContextDeps } from '@main/core/sessions/validate-session'
import type { ExecFn } from '@main/core/exec'
import type { TaskHandle } from '@main/core/tasks'
import { loadYaml11 } from '@main/core/yaml/load'
import type { ValidationContext } from '@main/core/yaml/validate'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths, RomNeed } from '@shared/types'
import { createTestContext, hostOs, silentLogger, type TestCore } from '../../helpers/core'
import { makeSeedZip } from '../../helpers/make-patch.mjs'

const ASH = 'A Short Hike'
const HK = 'Hollow Knight'
const LTTP = 'A Link to the Past'
const MEASURE_TIMEOUT_MS = 2 * 60 * 1000

const claire = `name: Claire\ngame: ${ASH}\n${ASH}:\n  goal: nap\n`
const knight = `name: Knight\ngame: ${HK}\n${HK}:\n  RandomizeGrubs: true\n`
const link = `name: Link\ngame: ${LTTP}\n${LTTP}: {}\n`
/** Two start locations with a weight each: the dice pick one. */
const weightedKnight = `name: Knight\ngame: ${HK}\n${HK}:\n  StartLocation:\n    kings_pass: 1\n    ancestral_mound: 1\n`
/** `game:` itself among two games. */
const luckyGame = `name: Lucky\ngame:\n  ${ASH}: 1\n  ${HK}: 1\n${ASH}: {}\n${HK}: {}\n`

/**
 * What the fake Archipelago does with a run: write a multidata of that many checks (one slot per count
 * of a list, as a document with `quantity`), fail, or hang.
 */
type Outcome = { checks: number | number[]; game?: string } | { fail: string[] } | 'hang'

interface FakeRun {
  opts: SpawnApOptions
  seed: number
  /** The documents of the players folder, as loaded. */
  docs: Record<string, unknown>[]
  /** The files of the players folder. */
  files: string[]
  hostYaml: string
  killed: boolean
  ended: boolean
}

const argOf = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1] ?? ''

let root: string
let core: TestCore
let dataRoot: string
let store: SessionStore
let estimates: CheckEstimates
let runs: FakeRun[]
let outcome: (run: FakeRun) => Outcome | Promise<Outcome>
let romNeeds: (games: readonly string[]) => Promise<RomNeed[]>
let installed: ValidationContext['installedGames']
let entriesSeen: SettingsEntry[][]
let measurer: Measurer

const install: ApInstall = {
  kind: 'custom',
  version: '0.6.8',
  root: 'C:\\AP',
  appImagePath: null,
  paths: {} as ApPaths,
}

/** A fake ArchipelagoGenerate: reads what the measure wrote, then does what `outcome` says. */
const fakeSpawn: typeof spawnAp = (_ctx, opts) => {
  const players = argOf(opts.args, '--player_files_path')
  const output = argOf(opts.args, '--outputpath')
  const seed = Number(argOf(opts.args, '--seed'))
  const files = readdirSync(players)
  const docs = files.flatMap((file) =>
    parseAllDocuments(readFileSync(join(players, file), 'utf8')).map(
      (doc) => doc.toJS() as Record<string, unknown>,
    ),
  )
  let settle: (exit: ApExit) => void = () => undefined
  const exited = new Promise<ApExit>((resolve) => {
    settle = resolve
  })
  const run: FakeRun = {
    opts,
    seed,
    docs,
    files,
    hostYaml: readFileSync(join(opts.cwd, 'host.yaml'), 'utf8'),
    killed: false,
    ended: false,
  }
  exited.then(
    () => (run.ended = true),
    () => undefined,
  )
  runs.push(run)
  void (async () => {
    const result = await outcome(run)
    if (result === 'hang' || run.ended) return
    if ('fail' in result) {
      for (const line of result.fail) opts.onLine?.('stderr', line)
      settle({ code: 1, signal: null })
      return
    }
    const doc = docs[0] ?? {}
    const zip = join(output, `AP_${seed}.zip`)
    const counts = Array.isArray(result.checks) ? result.checks : [result.checks]
    await makeSeedZip(zip, {
      seed: String(seed),
      slots: counts.map((checks, i) => ({
        name: `${String(doc.name)}${i === 0 ? '' : i + 1}`,
        game: result.game ?? String(doc.game),
        checks,
      })),
    })
    opts.onLine?.('stdout', `Creating final archive at ${zip}`)
    settle({ code: 0, signal: null })
  })()
  return {
    pid: 4000 + runs.length,
    exited,
    write: () => undefined,
    kill() {
      run.killed = true
      settle({ code: null, signal: 'SIGKILL' })
    },
    lastLines: () => [],
  }
}

/** Counts of the fake: A Short Hike 131, Hollow Knight 203 (AP 0.6.8 defaults). */
const defaultOutcome = (run: FakeRun): Outcome => ({ checks: run.docs[0]?.game === ASH ? 131 : 203 })

function deps(overrides: Partial<MeasurerDeps> = {}): MeasurerDeps {
  return {
    locator: {
      detect: () => Promise.resolve(install),
      exe: (_install, name) => ({ command: `fake-${name}`, argsPrefix: [] }),
    },
    settings: {
      makeSessionSettings: (dir, entries) => {
        entriesSeen.push([...entries])
        const file = join(dir, 'host.yaml')
        writeFileSync(file, JSON.stringify(entries))
        return Promise.resolve(file)
      },
    },
    sessions: store,
    worlds: { installedGames: () => Promise.resolve(new Map(installed)) },
    romNeeds: (games) => romNeeds(games),
    estimates,
    spawn: fakeSpawn,
    ...overrides,
  }
}

function taskSpy(): { handle: TaskHandle; controller: AbortController; stages: string[] } {
  const controller = new AbortController()
  const stages: string[] = []
  return {
    controller,
    stages,
    handle: {
      id: 'task-1',
      signal: controller.signal,
      progress: (stage) => void stages.push(stage),
      log: () => undefined,
    },
  }
}

const tmpRoot = (): string => join(dataRoot, 'tmp')
const measureDirs = (): string[] =>
  existsSync(tmpRoot()) ? readdirSync(tmpRoot()).filter((name) => name.startsWith('measure-')) : []

/** Waits for `check`, in real time, without timers (some tests fake them). */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
  expect(check()).toBe(true)
}

async function sessionWith(...files: [string, string][]): Promise<string> {
  const { id } = await store.create('Soirée')
  for (const [name, text] of files) await store.addText(id, name, text)
  return id
}

const measureOne = (yamlText: string, game: string, sessionId: string | null = null) =>
  measurer.measureDoc({ sessionId, game, yamlText, task: taskSpy().handle })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat measure é-'))
  core = createTestContext(root)
  dataRoot = core.ctx.platform.paths.dataRoot
  runs = []
  outcome = defaultOutcome
  romNeeds = () => Promise.resolve([])
  installed = new Map([
    [ASH, { worldVersion: null }],
    [HK, { worldVersion: null }],
    [LTTP, { worldVersion: null }],
  ])
  entriesSeen = []
  const context: ValidationContextDeps = {
    locator: { detect: () => Promise.resolve(install) },
    worlds: { installedGames: () => Promise.resolve(new Map(installed)) },
    templates: { getSchema: (game) => Promise.reject(new AppError('NOT_FOUND', { game })) },
    settings: { get: () => Promise.resolve(undefined) },
    log: silentLogger,
  }
  store = createSessionStore(core.ctx, {
    validationContext: (games, plando) => buildValidationContext(context, games, plando),
  })
  estimates = createCheckEstimates(core.ctx)
  measurer = createMeasurer(core.ctx, deps())
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

describe('isWeighted', () => {
  it('tells weights on several choices, random values and a weighted game from plain values', () => {
    expect(isWeighted({ game: HK, [HK]: { RandomizeGrubs: true, StartLocation: 'kings_pass' } }, HK)).toBe(
      false,
    )
    expect(isWeighted({ game: HK, [HK]: { StartLocation: { kings_pass: 1, ancestral_mound: 1 } } }, HK)).toBe(
      true,
    )
    // A single live weight, or the weights of another game, roll nothing.
    expect(isWeighted({ game: HK, [HK]: { StartLocation: { kings_pass: 1, ancestral_mound: 0 } } }, HK)).toBe(
      false,
    )
    expect(isWeighted({ game: HK, [ASH]: { goal: { nap: 1, help: 1 } } }, HK)).toBe(false)
    expect(isWeighted({ game: HK, [HK]: { Grubs: 'random-range-1-10' } }, HK)).toBe(true)
    expect(isWeighted({ game: HK, [HK]: { Grubs: { random: 1 } } }, HK)).toBe(true)
    // Weights written as text count as Archipelago's int() reads them.
    expect(
      isWeighted({ game: HK, [HK]: { StartLocation: { kings_pass: '1', ancestral_mound: '2' } } }, HK),
    ).toBe(true)
    // start_inventory's mapping is its value, not weights; so is any mapping that is not of numbers.
    expect(isWeighted({ game: HK, [HK]: { start_inventory: { Dash: 1, Claw: 1 } } }, HK)).toBe(false)
    expect(isWeighted({ game: HK, [HK]: { custom: { a: 'x', b: 'y' } } }, HK)).toBe(false)
    expect(isWeighted(null, HK)).toBe(false)
    expect(isWeighted({ game: { [ASH]: 1, [HK]: 1 } }, ASH)).toBe(true)
    expect(isWeighted({ game: { [ASH]: 1, [HK]: 0 } }, ASH)).toBe(false)
  })

  it('finds nothing to roll in the default templates of Archipelago 0.6.8', () => {
    for (const game of [ASH, HK]) {
      const text = readFileSync(new URL(`../../fixtures/templates/${game}.yaml`, import.meta.url), 'utf8')
      const [doc] = loadYaml11(text).docs
      expect(isWeighted(doc, game), game).toBe(false)
    }
  })
})

describe('measureDoc', () => {
  it('measures one document with --spoiler 0, seed 42 and --skip_prog_balancing in a temp dir it removes', async () => {
    expect(await measureOne(knight, HK)).toEqual({ checks: 203, range: null, error: null })

    expect(runs).toHaveLength(1)
    const [run] = runs
    if (!run) throw new Error('no run')
    const dir = run.opts.cwd
    expect(dirname(dir)).toBe(tmpRoot())
    expect(dir).toMatch(/[\\/]measure-[0-9a-f-]{36}$/)
    expect(run.opts.exe.command).toBe('fake-ArchipelagoGenerate')
    expect(run.opts.args).toEqual([
      '--player_files_path',
      join(dir, 'players'),
      '--outputpath',
      join(dir, 'output'),
      '--spoiler',
      '0',
      '--seed',
      '42',
      '--skip_prog_balancing',
    ])
    expect(run.opts.stdin).toBe('ignore')
    expect(run.files).toEqual(['p.yaml'])
    expect(run.docs).toEqual([{ name: 'Knight', game: HK, [HK]: { RandomizeGrubs: true } }])
    // The settings file of a measure without a session: the default rules, no password, no ROM.
    expect(entriesSeen[0]).toEqual(
      expect.arrayContaining([
        { path: ['generator', 'race'], value: 0 },
        { path: ['server_options', 'password'], value: null },
      ]),
    )
    // Written in the folder Archipelago runs in, which is where it loads its settings from.
    expect(JSON.parse(run.hostYaml)).toEqual(entriesSeen[0])
    expect(run.opts.sessionId).toBeUndefined()
    // Its own folder and host.yaml: out of the lock of the global settings.
    expect(run.opts.scoped).toBe(true)
    expect(existsSync(dir)).toBe(false)
    // The datapackage of the measure feeds the estimates.
    expect(estimates.maxFor(HK)).toBe(203)
  })

  it('uses the cache for an identical YAML, world version and seed', async () => {
    expect(await measureOne(knight, HK)).toMatchObject({ checks: 203 })
    expect(await measureOne(knight, HK)).toEqual({ checks: 203, range: null, error: null })
    expect(runs).toHaveLength(1)

    // Kept on disk: another run of the app measures nothing either.
    const again = createMeasurer(core.ctx, deps())
    expect(
      await again.measureDoc({ sessionId: null, game: HK, yamlText: knight, task: taskSpy().handle }),
    ).toEqual({ checks: 203, range: null, error: null })
    expect(runs).toHaveLength(1)
    expect(existsSync(join(dataRoot, 'checks', 'measures.json'))).toBe(true)

    // Another world version, or another YAML, is another measure.
    installed.set(HK, { worldVersion: '1.2.0' })
    await measureOne(knight, HK)
    expect(runs).toHaveLength(2)
    await measureOne(knight.replace('RandomizeGrubs: true', 'RandomizeGrubs: false'), HK)
    expect(runs).toHaveLength(3)
  })

  it('tells a custom world without world_version by its file: updated, its YAML is measured again', async () => {
    const world = join(root, 'hollow_knight.apworld')
    writeFileSync(world, 'v1')
    utimesSync(world, 1_700_000_000, 1_700_000_000)
    installed.set(HK, { worldVersion: null, file: world })
    expect(await measureOne(knight, HK)).toMatchObject({ checks: 203 })

    // The same file: kept, in this run and the next.
    expect(await measureOne(knight, HK)).toMatchObject({ checks: 203 })
    const again = createMeasurer(core.ctx, deps())
    expect(
      await again.measureDoc({ sessionId: null, game: HK, yamlText: knight, task: taskSpy().handle }),
    ).toMatchObject({ checks: 203 })
    expect(runs).toHaveLength(1)

    // Updated (the catalog always offers it, its version being unknown): the count may differ.
    writeFileSync(world, 'version 2')
    utimesSync(world, 1_700_000_100, 1_700_000_100)
    outcome = () => ({ checks: 240 })
    expect(await measureOne(knight, HK)).toMatchObject({ checks: 240 })
    expect(runs).toHaveLength(2)
  })

  it('a weighted YAML is measured on seeds 42, 1337 and 2026 and reported as a range', async () => {
    const counts: Record<number, number> = { 42: 180, 1337: 230, 2026: 203 }
    outcome = (run) => ({ checks: counts[run.seed] ?? 0 })

    expect(await measureOne(weightedKnight, HK)).toEqual({ checks: 203, range: [180, 230], error: null })
    expect(runs.map((run) => run.seed).sort((a, b) => a - b)).toEqual([42, 1337, 2026])
    // Each seed has its own folder, all gone.
    expect(new Set(runs.map((run) => run.opts.cwd)).size).toBe(3)
    expect(measureDirs()).toEqual([])
  })

  it('a game needing a ROM at generation without one in the vault fails its row with AP_ROM_MISSING and keeps the estimate', async () => {
    mkdirSync(join(dataRoot, 'checks'), { recursive: true })
    writeFileSync(
      join(dataRoot, 'checks', 'datapackage.json'),
      JSON.stringify({ fetchedAt: null, etag: null, games: { [LTTP]: { max: 286, checksum: null } } }),
    )
    estimates = createCheckEstimates(core.ctx)
    measurer = createMeasurer(core.ctx, deps())
    const need = (status: RomNeed['status'], path: string | null): RomNeed => ({
      game: LTTP,
      settingsKey: 'lttp_options.rom_file',
      status,
      path,
      vaultPath: null,
    })
    romNeeds = (games) => Promise.resolve(games.includes(LTTP) ? [need('missing', null)] : [])
    const id = await sessionWith(['Link.yaml', link], ['Claire.yaml', claire])

    const result = await measurer.measureSession(id, taskSpy().handle)
    // In the session's order, which is Archipelago's (file names sorted).
    expect(result.players).toEqual([
      expect.objectContaining({ name: 'Claire', checks: 131, source: 'measure', error: null }),
      expect.objectContaining({
        name: 'Link',
        game: LTTP,
        checks: 286,
        range: null,
        source: 'estimate',
        error: { code: 'AP_ROM_MISSING', params: { game: LTTP } },
      }),
    ])
    // Nothing ran for Link.
    expect(runs.map((run) => run.docs[0]?.name)).toEqual(['Claire'])

    // With the ROM in the vault, its path goes into the measure's settings file.
    const rom = join(root, 'roms', 'Zelda no Densetsu.sfc')
    romNeeds = (games) => Promise.resolve(games.includes(LTTP) ? [need('ok', rom)] : [])
    expect(await measureOne(link, LTTP)).toMatchObject({ checks: 203, error: null })
    expect(entriesSeen.at(-1)).toEqual(
      expect.arrayContaining([{ path: ['lttp_options', 'rom_file'], value: rom }]),
    )
  })

  it('times out after 2 minutes with MEASURE_TIMEOUT and kills the process', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    outcome = () => 'hang'
    const pending = measureOne(knight, HK)
    await until(() => runs.length === 1)
    const [run] = runs
    if (!run) throw new Error('no run')

    vi.advanceTimersByTime(MEASURE_TIMEOUT_MS - 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(run.killed).toBe(false)
    vi.advanceTimersByTime(1)

    expect(await pending).toEqual({ checks: null, range: null, error: { code: 'MEASURE_TIMEOUT' } })
    expect(run.killed).toBe(true)
    expect(existsSync(run.opts.cwd)).toBe(false)
    // A failed measure is not kept: the next ask runs again.
    outcome = defaultOutcome
    vi.useRealTimers()
    expect(await measureOne(knight, HK)).toMatchObject({ checks: 203 })
    expect(runs).toHaveLength(2)
  })
})

describe('the settings lock', () => {
  it('a sessionless measure running does not make settings.set throw', async () => {
    // A real program that runs until it is killed, spawned by the measure itself (no fake spawn). It
    // writes a file once it runs: then it is the measure's own child, alive.
    const started = join(root, 'sleeper-started')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(started)}, ''); setTimeout(() => {}, 60000)`
    // `--`: the measure's flags go to the script. Without it Node stops at once on `--player_files_path`
    // (« bad option »), and the measure's child is gone before the lock is asked.
    const sleeper = { command: process.execPath, argsPrefix: ['-e', script, '--'] }
    measurer = createMeasurer(
      core.ctx,
      deps({ spawn: undefined, locator: { detect: () => Promise.resolve(install), exe: () => sleeper } }),
    )
    const before = new Set(listChildren().map(({ pid }) => pid))
    const spy = taskSpy()
    const pending = measurer.measureDoc({ sessionId: null, game: HK, yamlText: knight, task: spy.handle })
    await until(() => existsSync(started))
    const [child, ...others] = listChildren().filter(({ pid }) => !before.has(pid))
    expect(others).toEqual([])
    if (!child) throw new Error('no child')
    /** The measure's child is still running, so the lock still knows it as its own. */
    const alive = (): boolean => listChildren().some(({ pid }) => pid === child.pid)

    // The system lists it as ArchipelagoGenerate, as it would the real one.
    const listing: ExecFn = (command) =>
      Promise.resolve({
        code: 0,
        stdout:
          command === 'tasklist'
            ? `"ArchipelagoGenerate.exe","${child.pid}","Console","1","10 000 K"\r\n`
            : `${child.pid} ArchipelagoGene\n`,
        stderr: '',
      })
    core.ctx.exec = listing
    const ap = join(root, 'Archipelago')
    mkdirSync(ap, { recursive: true })
    writeFileSync(join(ap, 'host.yaml'), 'bizhawkclient_options:\n  rom_start: true\n')
    const paths = { ...install.paths, localPath: ap, userPath: ap }
    const locator = {
      detect: () => Promise.resolve({ ...install, paths }),
    } as unknown as Locator
    const settings = createApSettings(core.ctx, locator)

    expect(alive()).toBe(true)
    await settings.set([{ path: ['bizhawkclient_options', 'rom_start'], value: false }])
    expect(readFileSync(join(ap, 'host.yaml'), 'utf8')).toContain('rom_start: false')

    // Any other Archipelago program still locks them.
    core.ctx.exec = (command) =>
      listing(command, []).then((result) => ({
        ...result,
        stdout:
          result.stdout +
          (command === 'tasklist'
            ? '"ArchipelagoBizHawkClient.exe","4242424","Console","1","10 000 K"\r\n'
            : '4242424 ArchipelagoBizH\n'),
      }))
    expect(alive()).toBe(true)
    await expect(
      settings.set([{ path: ['bizhawkclient_options', 'rom_start'], value: true }]),
    ).rejects.toMatchObject({
      code: 'SETTINGS_LOCKED',
      params: { processes: hostOs === 'win32' ? 'ArchipelagoBizHawkClient.exe' : 'ArchipelagoBizH' },
    })

    spy.controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    await until(() => !alive())
    // A program to start and stop under the load of the whole suite: more than one wait's worth of time.
  }, 15_000)
})

describe('measureSession', () => {
  it('measures each document of a multi-document player file separately', async () => {
    const id = await sessionWith(['Duo.yaml', `${claire}---\n${knight}`])
    const fileId = (await store.get(id)).players[0]?.id
    const spy = taskSpy()

    const result = await measurer.measureSession(id, spy.handle)
    expect(result.players).toEqual([
      {
        fileId,
        docIndex: 0,
        name: 'Claire',
        game: ASH,
        checks: 131,
        range: null,
        source: 'measure',
        error: null,
      },
      {
        fileId,
        docIndex: 1,
        name: 'Knight',
        game: HK,
        checks: 203,
        range: null,
        source: 'measure',
        error: null,
      },
    ])
    // One generation per document, each with that document alone, as a session player.
    expect(runs).toHaveLength(2)
    for (const run of runs) {
      expect(run.files).toEqual(['p.yaml'])
      expect(run.docs).toHaveLength(1)
      expect(run.opts.sessionId).toBe(id)
      expect(run.opts.scoped).toBe(true)
    }
    expect(runs.map((run) => run.docs[0]?.name).sort()).toEqual(['Claire', 'Knight'])
    expect(spy.stages[0]).toBe('prepare')
    expect(spy.stages).toContain('generate')
    expect(spy.stages.slice(-2)).toEqual(['read', 'done'])
    // The last counts of the session are kept.
    expect(await measurer.lastSession(id)).toEqual(result)
    expect(existsSync(join(dataRoot, 'checks', 'sessions', `${id}.json`))).toBe(true)
  })

  it("uses the session's rules but never its passwords in the settings file", async () => {
    const id = await sessionWith(['Claire.yaml', claire])
    await store.update(id, { rules: { ...(await store.get(id)).rules, race: true } })
    await store.setSecrets(id, { password: 'hunter2', serverPassword: 'sw0rdfish' })

    await measurer.measureSession(id, taskSpy().handle)
    expect(entriesSeen[0]).toEqual(
      expect.arrayContaining([
        { path: ['generator', 'race'], value: 1 },
        { path: ['server_options', 'password'], value: null },
        { path: ['server_options', 'server_password'], value: null },
      ]),
    )
    expect(runs[0]?.hostYaml).not.toMatch(/hunter2|sw0rdfish/)
  })

  it('a document with quantity 2 is measured on its first slot', async () => {
    outcome = () => ({ checks: [203, 210] })
    expect(
      await measureOne(
        `quantity: 2
${knight}`,
        HK,
      ),
    ).toEqual({ checks: 203, range: null, error: null })
    expect(runs).toHaveLength(1)
  })

  it('a YAML whose game is weighted is measured on three seeds and reported as a range', async () => {
    const rolled: Record<number, string> = { 42: ASH, 1337: HK, 2026: ASH }
    outcome = (run) => {
      const game = rolled[run.seed] ?? ASH
      return { checks: game === ASH ? 131 : 203, game }
    }
    const id = await sessionWith(['Lucky.yaml', luckyGame])

    const result = await measurer.measureSession(id, taskSpy().handle)
    expect(result.players).toEqual([
      expect.objectContaining({
        name: 'Lucky',
        game: null,
        checks: 131,
        range: [131, 203],
        source: 'measure',
      }),
    ])
    expect(runs.map((run) => run.seed).sort((a, b) => a - b)).toEqual([42, 1337, 2026])
  })

  it('runs at most two measures at once', async () => {
    const gates: (() => void)[] = []
    let most = 0
    outcome = (run) => {
      // The generations started and not exited yet, this one included.
      most = Math.max(most, runs.filter((started) => !started.ended).length)
      return new Promise<Outcome>((resolve) => gates.push(() => resolve(defaultOutcome(run))))
    }
    const id = await sessionWith(
      ['A.yaml', claire.replace('Claire', 'Ana')],
      ['B.yaml', knight.replace('Knight', 'Bea')],
      ['C.yaml', claire.replace('Claire', 'Cid')],
      ['D.yaml', knight.replace('Knight', 'Dan')],
    )
    const pending = measurer.measureSession(id, taskSpy().handle)

    await until(() => runs.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runs).toHaveLength(2)
    gates.shift()?.()
    await until(() => runs.length === 3)
    while (gates.length > 0 || runs.length < 4) {
      gates.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    }
    const result = await pending
    expect(result.players.map((player) => player.checks)).toEqual([131, 203, 131, 203])
    expect(most).toBe(2)
  })

  it('starts a foreground measure before the background ones waiting, which run one at a time', async () => {
    const gates: (() => void)[] = []
    let most = 0
    let mostBackground = 0
    const isBackground = (run: FakeRun): boolean => String(run.docs[0]?.name).startsWith('Bg')
    outcome = (run) => {
      const live = runs.filter((started) => !started.ended)
      most = Math.max(most, live.length)
      mostBackground = Math.max(mostBackground, live.filter(isBackground).length)
      return new Promise<Outcome>((resolve) => gates.push(() => resolve(defaultOutcome(run))))
    }
    const measure = (name: string, priority?: 'background') =>
      measurer.measureDoc({
        sessionId: null,
        game: ASH,
        yamlText: claire.replace('Claire', name),
        task: taskSpy().handle,
        ...(priority === undefined ? {} : { priority }),
      })
    const background = ['Bg1', 'Bg2', 'Bg3', 'Bg4'].map((name) => measure(name, 'background'))

    // One background measure at a time, though a slot is free.
    await until(() => runs.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runs).toHaveLength(1)
    // A foreground measure takes the free slot at once.
    const first = measure('Ana')
    await until(() => runs.length === 2)
    expect(runs[1]?.docs[0]?.name).toBe('Ana')
    // Asked after the background ones, the next foreground measure gets the next free slot.
    const second = measure('Bea')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runs).toHaveLength(2)
    gates.shift()?.()
    await until(() => runs.length === 3)
    expect(runs[2]?.docs[0]?.name).toBe('Bea')

    while (runs.length < 6 || gates.length > 0) {
      gates.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    }
    const results = await Promise.all([first, second, ...background])
    expect(results.map((result) => result.checks)).toEqual([131, 131, 131, 131, 131, 131])
    expect(runs.map((run) => run.docs[0]?.name)).toEqual(['Bg1', 'Ana', 'Bea', 'Bg2', 'Bg3', 'Bg4'])
    expect(most).toBe(2)
    expect(mostBackground).toBe(1)
  })

  it('a missing world only fails its own row', async () => {
    outcome = (run) =>
      run.docs[0]?.game === 'Nope Game'
        ? {
            fail: [
              'Traceback (most recent call last):',
              '  File "Generate.py", line 594, in roll_settings',
              "Exception: No world found to handle game Nope Game. Did you mean 'Noita' (42% sure)?",
            ],
          }
        : defaultOutcome(run)
    const id = await sessionWith(
      ['Claire.yaml', claire],
      ['Nope.yaml', 'name: Nope\ngame: Nope Game\nNope Game: {}\n'],
      ['Knight.yaml', knight],
    )

    const result = await measurer.measureSession(id, taskSpy().handle)
    expect(result.players.map(({ name, checks, source }) => ({ name, checks, source }))).toEqual([
      { name: 'Claire', checks: 131, source: 'measure' },
      { name: 'Knight', checks: 203, source: 'measure' },
      { name: 'Nope', checks: null, source: 'measure' },
    ])
    expect(result.players[2]?.error).toMatchObject({
      code: 'AP_WORLD_NOT_FOUND',
      params: { game: 'Nope Game', suggestion: 'Noita' },
    })
    expect(measureDirs()).toEqual([])
  })

  it('a player file that cannot be read fails its own row', async () => {
    const id = await sessionWith(['Broken.yaml', 'name: Broken\ngame: [unclosed\n'], ['Claire.yaml', claire])
    const broken = (await store.get(id)).players[0]?.id

    const result = await measurer.measureSession(id, taskSpy().handle)
    expect(result.players).toEqual([
      {
        fileId: broken,
        docIndex: 0,
        name: '',
        game: null,
        checks: null,
        range: null,
        source: 'measure',
        error: { code: 'AP_YAML_INVALID', detail: 'yaml-syntax' },
      },
      expect.objectContaining({ name: 'Claire', checks: 131, error: null }),
    ])
    expect(runs.map((run) => run.docs[0]?.name)).toEqual(['Claire'])
    // measureDoc takes one document, never a whole file.
    expect(await measureOne(`${claire}---\n${knight}`, ASH)).toEqual({
      checks: null,
      range: null,
      error: { code: 'AP_YAML_INVALID', detail: '2 player documents, one expected' },
    })
  })

  it('reports Archipelago missing on every row', async () => {
    measurer = createMeasurer(
      core.ctx,
      deps({
        locator: { detect: () => Promise.resolve(null), exe: () => ({ command: 'x', argsPrefix: [] }) },
      }),
    )
    const id = await sessionWith(['Claire.yaml', claire])
    const result = await measurer.measureSession(id, taskSpy().handle)
    expect(result.players).toEqual([
      expect.objectContaining({ checks: null, source: 'measure', error: { code: 'AP_NOT_INSTALLED' } }),
    ])
    expect(runs).toEqual([])
  })

  it('cancelling stops the running generations and removes their folders', async () => {
    outcome = () => 'hang'
    const id = await sessionWith(
      ['Claire.yaml', claire],
      ['Knight.yaml', knight],
      ['Cid.yaml', claire.replace('Claire', 'Cid')],
    )
    const spy = taskSpy()
    const pending = measurer.measureSession(id, spy.handle)
    await until(() => runs.length === 2 && measureDirs().length === 2)

    spy.controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    expect(runs.map((run) => run.killed)).toEqual([true, true])
    // The third one never started.
    expect(runs).toHaveLength(2)
    expect(measureDirs()).toEqual([])
    expect(await measurer.lastSession(id)).toBeNull()
  })
})

describe('fromGeneration', () => {
  it('fromGeneration stores the counts of the real multidata and feeds the estimates', async () => {
    // Added Knight first: Archipelago numbers the files sorted by name, so Claire is slot 1.
    const id = await sessionWith(['knight.yaml', knight], ['Claire.yaml', claire])
    const [claireFile, knightFile] = (await store.get(id)).players
    expect(claireFile?.storedName).toBe('Claire.yaml')
    const zip = join(root, 'output', 'AP_12345.zip')
    await makeSeedZip(zip, {
      seed: '12345',
      slots: [
        { name: 'Claire', game: ASH, checks: 131 },
        { name: 'Knight', game: HK, checks: 203 },
      ],
    })

    await measurer.fromGeneration(id, zip)
    const stored = await measurer.lastSession(id)
    expect(stored?.players).toEqual([
      {
        fileId: claireFile?.id,
        docIndex: 0,
        name: 'Claire',
        game: ASH,
        checks: 131,
        range: null,
        source: 'generation',
        error: null,
      },
      {
        fileId: knightFile?.id,
        docIndex: 0,
        name: 'Knight',
        game: HK,
        checks: 203,
        range: null,
        source: 'generation',
        error: null,
      },
    ])
    expect(runs).toEqual([])
    expect(estimates.maxFor(HK)).toBe(203)
    expect(estimates.maxFor(ASH)).toBe(131)

    await expect(measurer.fromGeneration('../escape', zip)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('counts the slots a document with quantity takes before the next player', async () => {
    // Claire is two players (slots 1 and 2): Knight is slot 3, not 2.
    const id = await sessionWith(
      [
        'Claire.yaml',
        `quantity: 2
${claire}`,
      ],
      ['Knight.yaml', knight],
    )
    const zip = join(root, 'output', 'AP_777.zip')
    await makeSeedZip(zip, {
      seed: '777',
      slots: [
        { name: 'Claire1', game: ASH, checks: 131 },
        { name: 'Claire2', game: ASH, checks: 131 },
        { name: 'Knight', game: HK, checks: 203 },
      ],
    })

    await measurer.fromGeneration(id, zip)
    expect((await measurer.lastSession(id))?.players).toEqual([
      expect.objectContaining({ name: 'Claire1', game: ASH, checks: 131, source: 'generation' }),
      expect.objectContaining({ name: 'Knight', game: HK, checks: 203, source: 'generation' }),
    ])
  })

  it('stores nothing when the seed does not match the session', async () => {
    const id = await sessionWith(['Claire.yaml', claire], ['Knight.yaml', knight])
    const before = await measurer.measureSession(id, taskSpy().handle)
    // Zed was added after the generation: three players for two slots.
    await store.addText(id, 'Zed.yaml', claire.replace('Claire', 'Zed'))
    const zip = join(root, 'output', 'AP_888.zip')
    await makeSeedZip(zip, {
      seed: '888',
      slots: [
        { name: 'Claire', game: ASH, checks: 140 },
        { name: 'Knight', game: HK, checks: 210 },
      ],
    })
    const warn = vi.spyOn(core.ctx.log, 'warn')

    try {
      await measurer.fromGeneration(id, zip)
      expect(await measurer.lastSession(id)).toEqual(before)
      expect(warn).toHaveBeenCalledWith(
        'measure: the seed does not match the session, its counts are not kept',
        { sessionId: id, slots: 2, players: 3 },
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('lastSession is null before any count, NOT_FOUND for an unknown session', async () => {
    const id = await sessionWith(['Claire.yaml', claire])
    expect(await measurer.lastSession(id)).toBeNull()
    await expect(measurer.lastSession('s_nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(measurer.lastSession('../escape')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('startup', () => {
  it('removes leftover measure folders at startup', async () => {
    // A data folder of its own: the measurer of beforeEach sweeps the other one.
    const next = createTestContext(join(root, 'next run'))
    const tmp = join(next.ctx.platform.paths.dataRoot, 'tmp')
    const leftover = join(tmp, 'measure-0b8c6d4e-1f2a-4b3c-8d9e-0f1a2b3c4d5e')
    mkdirSync(join(leftover, 'players'), { recursive: true })
    writeFileSync(join(leftover, 'players', 'p.yaml'), knight)
    const other = join(tmp, 'keep-me')
    mkdirSync(other)
    let orphansStopped: () => void = () => undefined

    createMeasurer(
      next.ctx,
      deps({
        orphansStopped: new Promise<void>((resolve) => {
          orphansStopped = resolve
        }),
      }),
    )
    // An orphan generation of the previous run may still hold its folder: the sweep waits for it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(existsSync(leftover)).toBe(true)
    orphansStopped()
    await vi.waitFor(() => expect(existsSync(leftover)).toBe(false))
    expect(existsSync(other)).toBe(true)
  })
})
