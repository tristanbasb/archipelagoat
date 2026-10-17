import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator } from '@main/core/ap/locator'
import { spawnAp } from '@main/core/ap/process'
import { createTemplates, TEMPLATE_ARGS, type TemplatesDeps } from '@main/core/ap/templates'
import type { HttpAnswer, Platform } from '@main/core/context'
import type { TaskHandle } from '@main/core/tasks'
import { disabledWorldsDir } from '@main/core/worlds/inventory'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import type {} from '@main/services/templates.service'
import { AppError } from '@shared/errors'
import type {
  ApInstall,
  ApPaths,
  ExeRef,
  GameSchema,
  OptionSchema,
  StudioGame,
  TaskDone,
} from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'
import { makeApworld } from '../../helpers/make-apworld'

const FIXTURES = fileURLToPath(new URL('../../fixtures/templates/', import.meta.url))
const fixturePath = (name: string): string => join(FIXTURES, name)
const fixture = (name: string): string => readFileSync(fixturePath(name), 'utf8')

const SITE = 'https://archipelago.gg'

/** Stands for ArchipelagoLauncher(Debug): records how it ran, then plays FAKE_TEMPLATES_MODE. */
const FAKE_LAUNCHER = `
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
writeFileSync(join(process.cwd(), 'launcher-run.json'), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
const mode = process.env.FAKE_TEMPLATES_MODE ?? 'ok'
if (mode === 'hang') {
  setTimeout(() => {}, 60_000)
} else if (mode === 'fail') {
  // Options.generate_yaml_templates chains the error of the world that failed.
  console.error("KeyError: 'option_foo'")
  console.error('')
  console.error('The above exception was the direct cause of the following exception:')
  console.error('')
  console.error('Exception: Template generation failed for world Foo')
  process.exit(1)
} else if (mode === 'crash') {
  process.exit(3)
} else {
  const dir = join(process.cwd(), 'Players', 'Templates')
  mkdirSync(join(dir, 'Presets'), { recursive: true })
  for (const file of JSON.parse(process.env.FAKE_TEMPLATES ?? '[]')) copyFileSync(file, join(dir, basename(file)))
  console.log('Generated templates')
}
`

let root: string
let core: TestCore
let install: ApInstall
let launcher: string

function apPaths(base: string): ApPaths {
  return {
    localPath: base,
    userPath: base,
    customWorlds: join(base, 'custom_worlds'),
    coreWorlds: join(base, 'lib', 'worlds'),
    players: join(base, 'Players'),
    templates: join(base, 'Players', 'Templates'),
    output: join(base, 'output'),
    logs: join(base, 'logs'),
    cache: join(base, 'cache'),
    settingsFile: join(base, 'host.yaml'),
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat templates é-'))
  core = createTestContext(join(root, 'core'))
  const base = join(root, 'Archipelago')
  install = { kind: 'custom', version: '0.6.8', root: base, appImagePath: null, paths: apPaths(base) }
  mkdirSync(install.paths.customWorlds, { recursive: true })
  mkdirSync(install.paths.coreWorlds, { recursive: true })
  mkdirSync(join(install.paths.templates, 'Presets'), { recursive: true })
  launcher = join(root, 'bin', 'launcher.mjs')
  mkdirSync(join(root, 'bin'))
  writeFileSync(launcher, FAKE_LAUNCHER)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

// --- helpers ------------------------------------------------------------------------------------

interface FakeLocator {
  locator: Pick<Locator, 'detect' | 'exe'>
  /** The programs asked for. */
  asked: string[]
}

function fakeLocator(found: ApInstall | null, env: Record<string, string> = {}): FakeLocator {
  const asked: string[] = []
  const exe: ExeRef = { command: process.execPath, argsPrefix: [launcher], env }
  return {
    asked,
    locator: {
      detect: () => Promise.resolve(found),
      exe: (_install, name) => {
        asked.push(name)
        return exe
      },
    },
  }
}

interface FakeSite {
  texts: string[]
  jsons: string[]
}

/** ctx.http answering from `texts` and `jsons` by URL; anything else is a 404. */
function fakeSite(
  texts: Record<string, string | (() => Promise<HttpAnswer<string>>)>,
  jsons: Record<string, unknown> = {},
): FakeSite {
  const site: FakeSite = { texts: [], jsons: [] }
  const notFound = (url: string): Promise<never> =>
    Promise.reject(new AppError('HTTP_ERROR', { status: 404, url }))
  core.ctx.http = {
    getText(url) {
      site.texts.push(url)
      const answer = texts[url]
      if (answer === undefined) return notFound(url)
      return typeof answer === 'string' ? Promise.resolve({ data: answer, fromCache: false }) : answer()
    },
    getJson<T>(url: string) {
      site.jsons.push(url)
      if (!(url in jsons)) return notFound(url)
      return Promise.resolve({ data: jsons[url] as T, fromCache: false })
    },
    fetchRaw: () => Promise.reject(new AppError('NOT_IMPLEMENTED')),
  }
  return site
}

const templateUrl = (safe: string): string =>
  `${SITE}/static/generated/configs/${encodeURIComponent(safe)}.yaml`
const presetsUrl = (game: string): string => `${SITE}/games/${encodeURIComponent(game)}/option-presets`

interface FakeTask extends TaskHandle {
  controller: AbortController
  lines: string[]
  stages: string[]
}

function fakeTask(): FakeTask {
  const controller = new AbortController()
  const lines: string[] = []
  const stages: string[] = []
  return {
    id: 'task-1',
    signal: controller.signal,
    controller,
    lines,
    stages,
    progress: (stage) => {
      stages.push(stage)
    },
    log: (stream, line) => {
      lines.push(`${stream}: ${line}`)
    },
  }
}

const writeTemplate = (name: string, text: string): void =>
  writeFileSync(join(install.paths.templates, name), `\uFEFF${text.replace(/^\uFEFF/, '')}`)
const writePreset = (name: string, text: string): void =>
  writeFileSync(join(install.paths.templates, 'Presets', name), text)

/** A copy of a real template made for another game. */
const renamed = (name: string, from: string, to: string): string => fixture(name).replaceAll(from, to)

const optionOf = (schema: GameSchema, key: string): OptionSchema | undefined =>
  schema.groups.flatMap((group) => group.options).find((o) => o.key === key)

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected a failure')
}

const make = (deps: TemplatesDeps): ReturnType<typeof createTemplates> => createTemplates(core.ctx, deps)

// --- getSchema ----------------------------------------------------------------------------------

describe('getSchema', () => {
  it('reads the local template and the presets of the local Presets folder', async () => {
    const site = fakeSite({})
    writeTemplate('A Link to the Past.yaml', fixture('A Link to the Past.yaml'))
    writePreset(
      'A Link to the Past - Fast.yaml',
      fixture('A Link to the Past.yaml')
        .replace(
          'description: Default A Link to the Past Template',
          'description: Fast Preset for A Link to the Past',
        )
        .replace('    ganon: 50\n    crystals: 0\n', '    ganon: 0\n    crystals: 50\n')
        .replace('    7: 50\n', '    5: 50\n'),
    )
    // The preset of another game whose file name starts the same way.
    writePreset(
      'A Link to the Past - Remix - Hard.yaml',
      renamed('Super Mario 64.yaml', 'Super Mario 64', 'A Link to the Past - Remix'),
    )
    const templates = make(fakeLocator(install))

    const schema = await templates.getSchema('A Link to the Past')
    expect(schema.source).toBe('local')
    expect(schema.game).toBe('A Link to the Past')
    expect(schema.apVersion).toBe('0.6.8')
    expect(optionOf(schema, 'progression_balancing')).toMatchObject({ kind: 'named-range', default: 50 })
    // Only what the preset changes; the first range of 0..7 weighted 7 is crystals_needed_for_gt.
    expect(schema.presets).toEqual({ Fast: { goal: 'crystals', crystals_needed_for_gt: 5 } })
    expect(site.texts).toEqual([])
    expect(site.jsons).toEqual([])
  })

  it('names a local preset after its file when its description says nothing', async () => {
    fakeSite({})
    writeTemplate('TUNIC.yaml', fixture('TUNIC.yaml'))
    writePreset(
      'TUNIC - Sync.yaml',
      fixture('TUNIC.yaml')
        .replace('description: Default TUNIC Template', 'description: My own words')
        .replace(
          /( {2}shuffle_ladders:\n(?: {4}#.*\n)*) {4}'false': 50\n {4}'true': 0\n/,
          "$1    'false': 0\n    'true': 50\n",
        ),
    )
    const schema = await make(fakeLocator(install)).getSchema('TUNIC')
    expect(schema.presets).toEqual({ Sync: { shuffle_ladders: true } })
  })

  it('getSchema falls back to site template when local missing and caches it', async () => {
    const site = fakeSite(
      { [templateUrl('TUNIC')]: fixture('TUNIC.yaml') },
      { [presetsUrl('TUNIC')]: JSON.parse(fixture('presets-TUNIC.json')) as unknown },
    )
    const templates = make(fakeLocator(install))

    const schema = await templates.getSchema('TUNIC')
    expect(schema.source).toBe('site')
    expect(schema.game).toBe('TUNIC')
    expect(optionOf(schema, 'ability_shuffling')).toMatchObject({ kind: 'toggle', default: true })
    // The site sends toggles as 'true'/'false': they become the booleans of the schema.
    expect(schema.presets).toEqual({
      Sync: { ability_shuffling: true },
      Async: {
        progression_balancing: 0,
        ability_shuffling: true,
        shuffle_ladders: true,
        laurels_location: '10_fairies',
      },
      'Glace Mode': {
        accessibility: 'minimal',
        ability_shuffling: true,
        entrance_rando: 'yes',
        fool_traps: 'onslaught',
        laurels_zips: true,
        ice_grappling: 'hard',
        ladder_storage: 'hard',
        ladder_storage_without_items: true,
        maskless: true,
        lanternless: true,
      },
    })

    expect(await templates.getSchema('TUNIC')).toEqual(schema)
    expect(site.texts).toEqual([templateUrl('TUNIC')])
    expect(site.jsons).toEqual([presetsUrl('TUNIC')])
  })

  it('keeps the other values of the site presets as they are', async () => {
    fakeSite(
      { [templateUrl('The Witness')]: fixture('The Witness.yaml') },
      { [presetsUrl('The Witness')]: JSON.parse(fixture('presets-The Witness.json')) as unknown },
    )
    const { presets } = await make(fakeLocator(install)).getSchema('The Witness')
    expect(Object.keys(presets)).toEqual([
      'Beginner Mode',
      'Short & Dense',
      'Advanced, But Chill',
      'Nice Allsanity',
    ])
    expect(presets['Beginner Mode']).toEqual({
      victory_condition: 'mountain_box_short',
      puzzle_skip_amount: 15,
    })
    expect(presets['Short & Dense']).toMatchObject({
      progression_balancing: 30,
      shuffle_symbols: false,
      shuffle_boat: true,
      laser_hints: false,
      shuffle_doors: 'panels',
      early_good_items: ['Door / Door Panel'],
      trap_weights: { Slowness: 6, 'Power Surge': 2, Bonk: 1 },
    })
  })

  it('drops site presets that are not objects', async () => {
    fakeSite(
      { [templateUrl('Factorio')]: fixture('Factorio.yaml') },
      { [presetsUrl('Factorio')]: { Odd: 'not an object', Fine: { death_link: 'random' } } },
    )
    expect((await make(fakeLocator(install)).getSchema('Factorio')).presets).toEqual({
      Fine: { death_link: 'random' },
    })
    fakeSite({ [templateUrl('Factorio')]: fixture('Factorio.yaml') }, { [presetsUrl('Factorio')]: [] })
    expect((await make(fakeLocator(install)).getSchema('Factorio')).presets).toEqual({})
  })

  it('asks the site with the file-safe name of the template and the game name of the presets', async () => {
    const game = 'Jak and Daxter: The Precursor Legacy'
    const site = fakeSite(
      {
        [templateUrl('Jak and Daxter The Precursor Legacy')]: fixture(
          'Jak and Daxter The Precursor Legacy.yaml',
        ),
      },
      { [presetsUrl(game)]: {} },
    )
    const schema = await make(fakeLocator(null)).getSchema(game)
    expect(schema).toMatchObject({ game, source: 'site', presets: {} })
    expect(site.texts).toEqual([
      `${SITE}/static/generated/configs/Jak%20and%20Daxter%20The%20Precursor%20Legacy.yaml`,
    ])
    expect(site.jsons).toEqual([
      `${SITE}/games/Jak%20and%20Daxter%3A%20The%20Precursor%20Legacy/option-presets`,
    ])
  })

  it('uses the webhost of the settings', async () => {
    core.ctx.config.updateInternal({ webhostUrl: 'http://127.0.0.1:8123/' })
    const site = fakeSite({})
    expect(await failure(make(fakeLocator(install)).getSchema('Factorio'))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(site.texts).toEqual(['http://127.0.0.1:8123/static/generated/configs/Factorio.yaml'])
  })

  it('keeps the site template when the site has no presets for it', async () => {
    fakeSite({ [templateUrl('Factorio')]: fixture('Factorio.yaml') })
    const schema = await make(fakeLocator(install)).getSchema('Factorio')
    expect(schema).toMatchObject({ source: 'site', presets: {} })
  })

  it('answers NOT_FOUND when neither the Templates folder nor the site has the game', async () => {
    fakeSite({})
    expect(await failure(make(fakeLocator(install)).getSchema('Clique'))).toMatchObject({
      code: 'NOT_FOUND',
      params: { game: 'Clique' },
    })
  })

  it('reports a failed network as such, and does not keep a stale answer in memory', async () => {
    const offline = (): Promise<never> => Promise.reject(new AppError('NETWORK_OFFLINE'))
    fakeSite({ [templateUrl('Factorio')]: offline })
    const templates = make(fakeLocator(install))
    expect(await failure(templates.getSchema('Factorio'))).toMatchObject({ code: 'NETWORK_OFFLINE' })

    const stale = (): Promise<HttpAnswer<string>> =>
      Promise.resolve({ data: fixture('Factorio.yaml'), fromCache: true, stale: true })
    const site = fakeSite({ [templateUrl('Factorio')]: stale })
    expect((await templates.getSchema('Factorio')).source).toBe('site')
    await templates.getSchema('Factorio')
    expect(site.texts).toEqual([templateUrl('Factorio'), templateUrl('Factorio')])
  })

  it('goes to the site when the local template is broken or names another game', async () => {
    const site = fakeSite({
      [templateUrl('Timespinner')]: fixture('Timespinner.yaml'),
      [templateUrl('Factorio')]: fixture('Factorio.yaml'),
    })
    writeTemplate('Timespinner.yaml', 'not: a template\n')
    writeTemplate('Factorio.yaml', renamed('Super Mario 64.yaml', 'Super Mario 64', 'Other Game'))
    const templates = make(fakeLocator(install))
    expect((await templates.getSchema('Timespinner')).source).toBe('site')
    expect((await templates.getSchema('Factorio')).source).toBe('site')
    expect(site.texts).toEqual([templateUrl('Timespinner'), templateUrl('Factorio')])
  })

  it('refuses a site answer that is not the template of the game', async () => {
    fakeSite({ [templateUrl('Hollow Knight')]: fixture('Factorio.yaml') })
    expect(await failure(make(fakeLocator(install)).getSchema('Hollow Knight'))).toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

// --- listGames ----------------------------------------------------------------------------------

describe('listGames', () => {
  it('lists the installed worlds and the local templates', async () => {
    await makeApworld(join(install.paths.customWorlds, 'foo.apworld'), { game: 'Foo' })
    await makeApworld(join(install.paths.customWorlds, 'bar.apworld'), { game: 'Bar' })
    await makeApworld(join(disabledWorldsDir(core.platform.paths.dataRoot), 'baz.apworld'), { game: 'Baz' })
    // Core worlds: TUNIC has a template on the site; the generic world is hidden.
    for (const module of ['tunic', 'generic']) {
      mkdirSync(join(install.paths.coreWorlds, module))
      writeFileSync(join(install.paths.coreWorlds, module, '__init__.py'), '')
    }
    writeTemplate('A Link to the Past.yaml', fixture('A Link to the Past.yaml'))
    writeTemplate('Foo.yaml', renamed('Super Mario 64.yaml', 'Super Mario 64', 'Foo'))
    // Not where Archipelago writes the template of its game, and not a template.
    writeTemplate('renamed.yaml', fixture('Timespinner.yaml'))
    writeTemplate('meta.yaml', 'meta_description: Meta-Mystery file\nnull:\n  progression_balancing: 50\n')

    const games = await make(fakeLocator(install)).listGames()
    expect(games).toEqual<StudioGame[]>([
      { game: 'A Link to the Past', installed: false, schemaSource: 'local' },
      { game: 'Bar', installed: true, schemaSource: 'none' },
      { game: 'Foo', installed: true, schemaSource: 'local' },
      { game: 'TUNIC', installed: true, schemaSource: 'site' },
    ])
  })

  it('counts a game whose site template is in memory as a site game', async () => {
    await makeApworld(join(install.paths.customWorlds, 'witness_fork.apworld'), { game: 'The Witness' })
    fakeSite({ [templateUrl('The Witness')]: fixture('The Witness.yaml') })
    const templates = make(fakeLocator({ ...install, version: null }))
    expect(await templates.listGames()).toEqual([
      { game: 'The Witness', installed: true, schemaSource: 'none' },
    ])
    await templates.getSchema('The Witness')
    expect(await templates.listGames()).toEqual([
      { game: 'The Witness', installed: true, schemaSource: 'site' },
    ])
  })

  it('lists nothing when Archipelago is not installed', async () => {
    expect(await make(fakeLocator(null)).listGames()).toEqual([])
  })
})

// --- regenerate ---------------------------------------------------------------------------------

describe('regenerate', () => {
  const runRecord = (dir: string): { argv: string[]; cwd: string } =>
    JSON.parse(readFileSync(join(dir, 'launcher-run.json'), 'utf8')) as { argv: string[]; cwd: string }

  it.each<[Platform['os'], string]>([
    ['win32', 'ArchipelagoLauncherDebug'],
    ['linux', 'ArchipelagoLauncher'],
  ])('on %s runs %s "Generate Template Options" in the user folder', async (os, program) => {
    core = createTestContext(join(root, `core-${os}`), { os })
    // An AppImage has no local folder: Archipelago runs in its user folder.
    const target: ApInstall = { ...install, paths: { ...install.paths, localPath: '' } }
    const files = ['A Link to the Past.yaml', 'TUNIC.yaml', 'Timespinner.yaml'].map(fixturePath)
    const { locator, asked } = fakeLocator(target, { FAKE_TEMPLATES: JSON.stringify(files) })
    const spawn = vi.fn(spawnAp)
    const task = fakeTask()

    expect(await make({ locator, spawn }).regenerate(task)).toEqual({ count: 3 })
    expect(asked).toEqual([program])
    expect(spawn).toHaveBeenCalledWith(
      core.ctx,
      expect.objectContaining({ args: TEMPLATE_ARGS, cwd: install.paths.userPath, stdin: 'ignore' }),
    )
    expect(TEMPLATE_ARGS).toEqual(['Generate Template Options', '--', '--skip_open_folder'])
    expect(runRecord(install.paths.userPath)).toEqual({
      argv: ['Generate Template Options', '--', '--skip_open_folder'],
      cwd: install.paths.userPath,
    })
    expect(task.lines).toContain('stdout: Generated templates')
    expect(task.stages.at(-1)).toBe('done')
  })

  it('regenerate refuses when a corrupt apworld exists', async () => {
    writeFileSync(join(install.paths.customWorlds, 'broken.apworld'), 'not a zip')
    const spawn = vi.fn(spawnAp)
    const error = await failure(make({ ...fakeLocator(install), spawn }).regenerate(fakeTask()))
    expect(error).toMatchObject({ code: 'WORLD_CORRUPT_BLOCKING', params: { file: 'broken.apworld' } })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses when Archipelago is not installed', async () => {
    expect(await failure(make(fakeLocator(null)).regenerate(fakeTask()))).toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
  })

  it('translates a failed run from its output', async () => {
    const task = fakeTask()
    const error = await failure(make(fakeLocator(install, { FAKE_TEMPLATES_MODE: 'fail' })).regenerate(task))
    expect(error).toMatchObject({ code: 'AP_UNKNOWN', params: { type: 'KeyError', message: "'option_foo'" } })
    expect(task.lines).toContain('stderr: Exception: Template generation failed for world Foo')

    const silent = await failure(
      make(fakeLocator(install, { FAKE_TEMPLATES_MODE: 'crash' })).regenerate(fakeTask()),
    )
    expect(silent).toMatchObject({ code: 'AP_UNKNOWN', params: { exitCode: '3' } })
  })

  it('reports a launcher that cannot start', async () => {
    const { locator } = fakeLocator(install)
    const missing: TemplatesDeps['locator'] = {
      detect: locator.detect,
      exe: () => ({ command: join(root, 'missing', 'ArchipelagoLauncher.exe'), argsPrefix: [] }),
    }
    expect(await failure(make({ locator: missing }).regenerate(fakeTask()))).toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
  })

  it('stops a run past its time limit', async () => {
    const templates = make({ ...fakeLocator(install, { FAKE_TEMPLATES_MODE: 'hang' }), timeoutMs: 1000 })
    expect(await failure(templates.regenerate(fakeTask()))).toMatchObject({ code: 'PROCESS_TIMEOUT' })
  })

  it('stops the run when the task is cancelled', async () => {
    const task = fakeTask()
    const pending = failure(make(fakeLocator(install, { FAKE_TEMPLATES_MODE: 'hang' })).regenerate(task))
    await vi.waitFor(() => expect(existsSync(join(install.paths.userPath, 'launcher-run.json'))).toBe(true), {
      timeout: 10_000,
    })
    task.controller.abort()
    expect(await pending).toMatchObject({ code: 'TASK_CANCELLED' })
  })

  it('does not start when the task is already cancelled', async () => {
    const task = fakeTask()
    task.controller.abort()
    const spawn = vi.fn(spawnAp)
    expect(await failure(make({ ...fakeLocator(install), spawn }).regenerate(task))).toMatchObject({
      code: 'TASK_CANCELLED',
    })
    expect(spawn).not.toHaveBeenCalled()
  })
})

// --- handlers -----------------------------------------------------------------------------------

describe('studio schema handlers', () => {
  it('serve the games, a schema and the regeneration through the templates service', async () => {
    // A fake install (GOAT_FAKE_AP_DIR) whose launcher writes the templates of FAKE_TEMPLATES.
    const fakeDir = join(root, 'fake-ap')
    mkdirSync(join(fakeDir, 'Players', 'Templates'), { recursive: true })
    for (const name of ['ArchipelagoLauncher', 'ArchipelagoLauncherDebug'])
      writeFileSync(join(fakeDir, `${name}.mjs`), FAKE_LAUNCHER)
    writeFileSync(join(fakeDir, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    writeFileSync(join(fakeDir, 'Players', 'Templates', 'Factorio.yaml'), fixture('Factorio.yaml'))
    vi.stubEnv('GOAT_FAKE_AP_DIR', fakeDir)
    vi.stubEnv('FAKE_TEMPLATES', JSON.stringify([fixturePath('TUNIC.yaml')]))
    const done: TaskDone[] = []
    core.ctx.bus.on('task:done', (event) => done.push(event))

    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const call = async <T>(name: string, input?: unknown): Promise<T> => {
      const result = await ipc.dispatch(name, input, { senderId: 1 })
      if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
      return result.value as T
    }

    expect(await call('studio:games')).toEqual([
      { game: 'Factorio', installed: false, schemaSource: 'local' },
    ])
    expect(await call<GameSchema>('studio:schema', { game: 'Factorio' })).toMatchObject({
      game: 'Factorio',
      source: 'local',
    })

    const { taskId } = await call<{ taskId: string }>('ap:regenerateTemplates')
    await vi.waitFor(() => expect(done.map((event) => event.taskId)).toContain(taskId), { timeout: 15_000 })
    expect(done.find((event) => event.taskId === taskId)).toMatchObject({
      kind: 'templates',
      result: { count: 2 },
    })
    expect((await call<StudioGame[]>('studio:games')).map((g) => g.game)).toEqual(['Factorio', 'TUNIC'])
  })
})
