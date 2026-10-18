import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  buildGenerateArgs,
  buildMeasureArgs,
  extractGenerationError,
  readGenerationZip,
  reduceProgress,
  runGeneration,
  type GenerateDeps,
  type GenProgress,
} from '@main/core/ap/generate'
import { createLocator, type Locator } from '@main/core/ap/locator'
import { listChildren, spawnAp } from '@main/core/ap/process'
import { createServerManager } from '@main/core/ap/server'
import { createApSettings, type ApSettings } from '@main/core/ap/settings'
import type { ExecFn } from '@main/core/exec'
import { createVault, type Vault } from '@main/core/play/roms'
import { createSessionStore, type SessionStore } from '@main/core/sessions/store'
import {
  buildValidationContext,
  createSessionValidator,
  type SessionValidator,
  type ValidationContextDeps,
} from '@main/core/sessions/validate-session'
import { workspacePaths } from '@main/core/sessions/workspace'
import { readZipText } from '@main/core/system/archive'
import type { TaskHandle } from '@main/core/tasks'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `generator`, `servers` and `sessions` entries of Services (the service files are loaded by import.meta.glob).
import type {} from '@main/services/generator.service'
import type {} from '@main/services/servers.service'
import type {} from '@main/services/sessions.service'
import { GENERATE_STAGE_IDS } from '@shared/codes'
import { AppError } from '@shared/errors'
import { defaultRules } from '@shared/rules'
import type { RomTableEntry, TaskDone, TaskFailed } from '@shared/types'
import { apOutputLines } from '../../helpers/ap-output'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { apworldManifest, makeApworld } from '../../helpers/make-apworld'
import { makeSeedZip } from '../../helpers/make-patch.mjs'
import { makeShims } from '../../fake-ap/make-shims.mjs'
import { makeZip } from '../sessions/helpers'

const FAKE_AP = fileURLToPath(new URL('../../fake-ap/', import.meta.url))
/** The seed of the captured generation the fake ArchipelagoGenerate replays. */
const SEED = '47305681920473519826'
const LTTP = 'A Link to the Past'
const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex')
/** A synthetic ROM: nobody can build a file with the MD5 of a real game. */
const ROM_BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) & 0xff))
const TABLE: RomTableEntry[] = [
  {
    game: LTTP,
    label: `${LTTP} (test)`,
    md5s: [md5(ROM_BYTES)],
    header: 'none',
    settingsKey: 'lttp_options.rom_file',
    requiredAtGeneration: true,
    extensions: ['.sfc'],
  },
]
const GLOBAL_HOST_YAML = 'generator:\n  spoiler: 3\nserver_options:\n  hint_cost: 10\n'

let root: string
let core: TestCore
let apDir: string
let recordFile: string
/** FAKE_MODE of the fake ArchipelagoGenerate. */
let mode: string
let locator: Locator
let settings: ApSettings
let vault: Vault
let store: SessionStore
let validator: SessionValidator
let deps: GenerateDeps

/** Rejects when `promise` has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`not settled within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

interface ProgressCall {
  stage: string
  percent: number | null
  detail?: Record<string, string | number>
}

interface TaskSpy {
  handle: TaskHandle
  controller: AbortController
  progress: ProgressCall[]
  logs: { stream: string; line: string }[]
}

function taskSpy(onProgress?: (call: ProgressCall, spy: TaskSpy) => void): TaskSpy {
  const controller = new AbortController()
  const spy: TaskSpy = {
    controller,
    progress: [],
    logs: [],
    handle: {
      id: 'task-1',
      signal: controller.signal,
      progress(stage, percent = null, detail) {
        const call: ProgressCall = detail ? { stage, percent, detail } : { stage, percent }
        spy.progress.push(call)
        onProgress?.(call, spy)
      },
      log(stream, line) {
        spy.logs.push({ stream, line })
      },
    },
  }
  return spy
}

const player = (name: string, game: string): string => `name: ${name}\ngame: ${game}\n${game}: {}\n`

async function sessionWith(...files: [string, string][]): Promise<string> {
  const { id } = await store.create('Soirée')
  for (const [name, text] of files) await store.addText(id, name, text)
  return id
}

/** Alice plays Pokemon Emerald, Bob A Hat in Time: the players the fake generation outputs. */
const aliceAndBob = (): Promise<string> =>
  sessionWith(
    ['Alice.yaml', player('Alice', 'Pokemon Emerald')],
    ['Bob.yaml', player('Bob', 'A Hat in Time')],
  )

const wsOf = (id: string) => workspacePaths(core.ctx.platform.paths.dataRoot, id)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat generate é-'))
  core = createTestContext(join(root, 'core'))
  const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
  core.ctx.exec = exec
  // A fake Archipelago 0.6.8 whose programs are the Node fakes, with a global host.yaml.
  apDir = join(root, 'Archipelago é')
  makeShims(apDir)
  writeFileSync(join(apDir, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
  writeFileSync(join(apDir, 'host.yaml'), GLOBAL_HOST_YAML)
  recordFile = join(root, 'record.json')
  mode = ''
  locator = createLocator(core.ctx, {
    fakeRoot: apDir,
    exeOverride: (name) => ({
      command: process.execPath,
      argsPrefix: [join(apDir, `${name}.mjs`)],
      env: { FAKE_MODE: mode, FAKE_RECORD: recordFile },
    }),
  })
  settings = createApSettings(core.ctx, locator)
  vault = createVault(core.ctx, { settings, locator, table: TABLE })
  const context: ValidationContextDeps = {
    locator,
    worlds: {
      installedGames: () =>
        Promise.resolve(
          new Map(['Pokemon Emerald', 'A Hat in Time', LTTP].map((game) => [game, { worldVersion: null }])),
        ),
    },
    templates: { getSchema: (game) => Promise.reject(new AppError('NOT_FOUND', { game })) },
    settings,
    log: silentLogger,
  }
  store = createSessionStore(core.ctx, {
    validationContext: (games, plando) => buildValidationContext(context, games, plando),
  })
  validator = createSessionValidator(store, {
    ...context,
    catalog: { lookupByGame: () => null },
    vault,
    table: TABLE,
  })
  deps = { sessions: { ...store, ...validator }, settings, locator }
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

describe('buildGenerateArgs', () => {
  it('buildGenerateArgs uses absolute paths with spaces and accents', () => {
    const ws = {
      players: join(root, 'Jérôme Dupont', 'players'),
      output: join(root, 'Jérôme Dupont', 'sortie é'),
    }
    const rules = { ...defaultRules(), spoiler: 2 as const, plando: [] }
    expect(buildGenerateArgs(ws, rules)).toEqual([
      '--player_files_path',
      ws.players,
      '--outputpath',
      ws.output,
      '--spoiler',
      '2',
    ])
    // A relative folder is made absolute: Generate resolves it against its cwd otherwise.
    expect(buildGenerateArgs({ players: join('rel é', 'players'), output: 'out' }, rules)).toEqual([
      '--player_files_path',
      resolve('rel é', 'players'),
      '--outputpath',
      resolve('out'),
      '--spoiler',
      '2',
    ])
  })

  it('adds --race and the plando modules when the rules ask for them', () => {
    const ws = { players: join(root, 'p'), output: join(root, 'o') }
    expect(
      buildGenerateArgs(ws, { ...defaultRules(), spoiler: 0, race: true, plando: ['items', 'bosses'] }),
    ).toEqual([
      '--player_files_path',
      ws.players,
      '--outputpath',
      ws.output,
      '--spoiler',
      '0',
      '--race',
      '--plando',
      'items, bosses',
    ])
  })
})

describe('buildMeasureArgs', () => {
  it('buildMeasureArgs asks for no spoiler, the seed and no progression balancing', () => {
    const ws = { players: join(root, 'measure é', 'players'), output: join(root, 'measure é', 'output') }
    expect(buildMeasureArgs(ws, 1337)).toEqual([
      '--player_files_path',
      ws.players,
      '--outputpath',
      ws.output,
      '--spoiler',
      '0',
      '--seed',
      '1337',
      '--skip_prog_balancing',
    ])
  })
})

describe('reduceProgress', () => {
  const start: GenProgress = { stage: 'init', percent: 0 }

  it('reduceProgress over generate-success.txt is monotonic and ends at 100/done', () => {
    const states: GenProgress[] = []
    let state = start
    for (const line of apOutputLines('generate-success.txt')) {
      state = reduceProgress(state, line)
      states.push(state)
    }
    for (const [i, current] of states.entries()) {
      const previous = states[i - 1] ?? start
      expect(current.percent).toBeGreaterThanOrEqual(previous.percent)
      expect(GENERATE_STAGE_IDS.indexOf(current.stage)).toBeGreaterThanOrEqual(
        GENERATE_STAGE_IDS.indexOf(previous.stage),
      )
    }
    expect(state).toEqual({ stage: 'done', percent: 100 })
    // The fill step refines the bar between `fill` (32) and `balancing` (60), never reaching it.
    const fill = states.filter((s) => s.stage === 'fill').map((s) => s.percent)
    expect(fill[0]).toBe(32)
    expect(fill.some((p) => p > 32 && p < 60)).toBe(true)
    expect(Math.max(...fill)).toBeLessThan(60)
    // The captured run logs every stage.
    expect(new Set(states.map((s) => s.stage))).toEqual(new Set(GENERATE_STAGE_IDS))
  })

  it('follows the real 12-player generation of Archipelago 0.6.8 up to 100/done', () => {
    // The log of the real run (docs/verification/2026-10-16-real-run.md): stdout and stderr as they
    // came, with a fill step past its own total (`1490/1473`).
    let state = start
    const fill: number[] = []
    for (const line of apOutputLines('real-generate-12-players.txt')) {
      const next = reduceProgress(state, line)
      expect(next.percent).toBeGreaterThanOrEqual(state.percent)
      if (next.stage === 'fill') fill.push(next.percent)
      state = next
    }
    expect(state).toEqual({ stage: 'done', percent: 100 })
    expect(Math.max(...fill)).toBe(59)
  })

  it('ignores unknown lines, fill steps outside the fill stage and stages already passed', () => {
    const prefill: GenProgress = { stage: 'prefill', percent: 28 }
    expect(reduceProgress(prefill, 'Took 1.0520 seconds in PokemonEmeraldWorld.set_rules')).toBe(prefill)
    expect(reduceProgress(prefill, 'Current fill step (Progression) at 5/10 items placed.')).toBe(prefill)
    expect(reduceProgress(prefill, 'Creating Items.')).toBe(prefill)
    // Timestamped lines (`--log_time`) count as well.
    expect(reduceProgress(start, '[2026-10-17 12:00:00] Creating MultiWorld.')).toEqual({
      stage: 'creating',
      percent: 12,
    })
    const fill: GenProgress = { stage: 'fill', percent: 32 }
    expect(reduceProgress(fill, 'Current fill step (Remaining) at 0/1748 items placed.')).toBe(fill)
    expect(reduceProgress(fill, 'Took 2.5000 seconds in fill_restrictive for player 1, named Alice.')).toBe(
      fill,
    )
  })
})

describe('extractGenerationError', () => {
  it('extractGenerationError maps huge FillError to AP_FILL_UNBEATABLE with detail ≤ 4000 chars', () => {
    const lines = apOutputLines('generate-fill-error.txt')
    const traceback = lines.indexOf('Traceback (most recent call last):')
    const placements = `[${Array.from({ length: 80_000 }, (_, i) => `(Location ${i} (Alice), Item (Bob))`).join(', ')}]`
    expect(placements.length).toBeGreaterThan(2_000_000)
    const stderr = lines.slice(traceback, -1).map((line) => (line.startsWith('[(') ? placements : line))
    const stdout = [...lines.slice(0, traceback), lines.at(-1) ?? '']

    const started = Date.now()
    const error = extractGenerationError(stderr, stdout)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(error.code).toBe('AP_FILL_UNBEATABLE')
    expect(error.detail?.length).toBeLessThanOrEqual(4000)
    expect(error.detail).toContain('Fill.FillError: Game appears as unbeatable. Aborting.')
  })

  it('reads only the last exception (with its chain), past the atexit prompt error', () => {
    // An earlier exception that a more specific catalog entry would match: only the last one counts.
    const earlier = [
      'Traceback (most recent call last):',
      '  File "Generate.py", line 664, in <module>',
      "Exception: No world found to handle game Zork. Did you mean 'Zork Grand Inquisitor' (88% sure)?",
      '',
    ]
    const atexit = [
      'Exception ignored in atexit callback: <built-in function input>',
      'EOFError: EOF when reading a line',
    ]
    const last = [
      'Traceback (most recent call last):',
      '  File "Main.py", line 196, in main',
      'Fill.FillError: No more spots to place 3 items. Remaining locations are invalid.',
    ]
    expect(extractGenerationError([...earlier, ...last, ...atexit], [])).toEqual({
      code: 'AP_FILL_NO_SPOTS',
      params: { count: '3' },
      detail: last.join('\n'),
    })

    // A chained exception keeps its cause: the catalog order picks the ROM error over the wrapper.
    const chained = [
      'Traceback (most recent call last):',
      '  File "settings.py", line 96, in resolve',
      'FileNotFoundError: C:\\roms\\z3.sfc does not exist, but lttp_options.rom_file is required',
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'Traceback (most recent call last):',
      '  File "Main.py", line 140, in main',
      'RuntimeError: stage_assert_generate failed',
    ]
    expect(extractGenerationError([...earlier, ...chained, ...atexit], [])).toMatchObject({
      code: 'AP_ROM_MISSING',
      params: { path: 'C:\\roms\\z3.sfc', key: 'lttp_options.rom_file' },
      detail: chained.join('\n'),
    })
  })

  it('falls back to the end of stdout, then to GENERATION_FAILED', () => {
    // stderr without a Python exception: what it says, as the detail of a generic failure.
    expect(
      extractGenerationError(['Fatal Python error: Segmentation fault', ''], ['Creating Items.']),
    ).toEqual({ code: 'GENERATION_FAILED', detail: 'Fatal Python error: Segmentation fault' })
    expect(extractGenerationError([], ['Creating MultiWorld.', 'Segmentation fault'])).toEqual({
      code: 'GENERATION_FAILED',
      detail: 'Creating MultiWorld.\nSegmentation fault',
    })
    expect(extractGenerationError(['', 'Press enter to close.'], ['ValueError: oops'])).toEqual({
      code: 'AP_UNKNOWN',
      params: { type: 'ValueError', message: 'oops' },
      detail: 'ValueError: oops',
    })
    expect(extractGenerationError([], [])).toEqual({ code: 'GENERATION_FAILED' })
  })
})

describe('readGenerationZip', () => {
  it('readGenerationZip reads slots for multiworld and single-player spoilers', async () => {
    const multi = await makeSeedZip(join(root, 'multi', `AP_${SEED}.zip`), {
      seed: SEED,
      slots: [
        { name: 'Alice', game: 'Pokemon Emerald', patch: '.apemerald' },
        { name: 'Bob Le Bricoleur', game: 'A Hat in Time' },
        { name: 'Carol', game: LTTP, patch: '.aplttp' },
      ],
    })
    expect(await readGenerationZip(multi)).toEqual({
      seedName: SEED,
      spoilerName: `AP_${SEED}_Spoiler.txt`,
      slots: [
        { slot: 1, name: 'Alice', game: 'Pokemon Emerald', patchFile: `AP_${SEED}_P1_Alice.apemerald` },
        { slot: 2, name: 'Bob Le Bricoleur', game: 'A Hat in Time', patchFile: null },
        { slot: 3, name: 'Carol', game: LTTP, patchFile: `AP_${SEED}_P3_Carol.aplttp` },
      ],
    })

    // One player: the spoiler has no `Player 1:` line, the name comes from the patch file.
    const single = await makeSeedZip(join(root, 'single', 'AP_12345.zip'), {
      seed: '12345',
      slots: [{ name: 'Alice', game: 'Pokemon Emerald', patch: '.apemerald' }],
    })
    expect(await readGenerationZip(single)).toEqual({
      seedName: '12345',
      spoilerName: 'AP_12345_Spoiler.txt',
      slots: [{ slot: 1, name: 'Alice', game: 'Pokemon Emerald', patchFile: 'AP_12345_P1_Alice.apemerald' }],
    })
  })

  it('reads the slots from the file names alone without a spoiler', async () => {
    const zip = await makeZip(join(root, 'nospoiler', 'AP_777.zip'), {
      'AP_777.archipelago': Buffer.from([3, 1, 2, 3]),
      'AP_777_P2_Bob_Le_Bricoleur.apemerald': 'patch',
      'AP_777_P1_Mr.X.apz5': 'patch',
      'AP_777_P1_Mr.X.notes': 'other file of the slot',
    })
    expect(await readGenerationZip(zip)).toEqual({
      seedName: '777',
      spoilerName: null,
      slots: [
        // A slot's patch is the file a client opens (a known patch route) before any other.
        { slot: 1, name: 'Mr.X', game: '', patchFile: 'AP_777_P1_Mr.X.apz5' },
        { slot: 2, name: 'Bob_Le_Bricoleur', game: '', patchFile: 'AP_777_P2_Bob_Le_Bricoleur.apemerald' },
      ],
    })
  })

  it('reads the slot files of the worlds that name them AP-<seed>-P<n>-<name> (Factorio, Kingdom Hearts 2)', async () => {
    // The names of the real 0.6.8 generation (docs/verification/2026-10-16-real-run.md): Factorio's
    // mod (worlds/factorio/Mod.py:114-115, also KH1) and the KH2 mod with its timestamp
    // (worlds/kh2/OpenKH.py:84-85), both followed by `_<version>`.
    const seed = '85957999565022565374'
    const factorio = `AP-${seed}-P2-Goat10_0.6.8.zip`
    const kh2 = `AP-${seed}-P11-Goat8-17Oct2026-174651_0.6.8.zip`
    const zip = await makeZip(join(root, 'mods', `AP_${seed}.zip`), {
      [`AP_${seed}.archipelago`]: Buffer.from([3, 1, 2, 3]),
      [factorio]: 'factorio mod',
      [kh2]: 'kh2 mod',
    })
    expect(await readGenerationZip(zip)).toEqual({
      seedName: seed,
      spoilerName: null,
      slots: [
        { slot: 2, name: 'Goat10', game: '', patchFile: factorio },
        { slot: 11, name: 'Goat8', game: '', patchFile: kh2 },
      ],
    })
  })

  it('refuses a zip without multidata', async () => {
    const zip = await makeZip(join(root, 'empty', 'AP_1.zip'), { 'readme.txt': 'nothing' })
    await expect(readGenerationZip(zip)).rejects.toMatchObject({ code: 'GENERATION_FAILED' })
  })
})

describe('runGeneration', () => {
  it('runGeneration success stores Generation with slots and patch file names', async () => {
    const id = await aliceAndBob()
    const ws = wsOf(id)
    const task = taskSpy()

    const generation = await within(runGeneration(core.ctx, deps, id, task.handle), 15_000)

    expect(generation).toEqual({
      seedName: SEED,
      zipPath: join(ws.output, `AP_${SEED}.zip`),
      spoilerName: `AP_${SEED}_Spoiler.txt`,
      slots: [
        {
          slot: 1,
          name: 'Alice',
          game: 'Pokemon Emerald',
          patchFile: join(ws.output, 'slots', 'P1_Alice', `AP_${SEED}_P1_Alice.apemerald`),
        },
        { slot: 2, name: 'Bob', game: 'A Hat in Time', patchFile: null },
      ],
      durationS: expect.any(Number) as number,
      logPath: expect.any(String) as string,
    })
    expect(generation.durationS).toBeGreaterThan(0)
    expect(await store.get(id)).toMatchObject({ status: 'generated', generation })

    // Spawned as the spec says: in the workspace, absolute paths, the session's rules.
    const record = JSON.parse(readFileSync(recordFile, 'utf8')) as {
      program: string
      argv: string[]
      cwd: string
    }
    expect(record.program).toBe('ArchipelagoGenerate')
    expect(record.cwd).toBe(ws.dir)
    expect(record.argv).toEqual(buildGenerateArgs(ws, defaultRules()))

    // Progress: GENERATE_STAGE_IDS codes, monotonic, from the start to done/100, fill with done/total.
    expect(task.progress[0]).toEqual({ stage: 'init', percent: 0 })
    expect(task.progress.at(-1)).toEqual({ stage: 'done', percent: 100 })
    const percents = task.progress.map((call) => call.percent ?? 0)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    for (const call of task.progress) expect(GENERATE_STAGE_IDS).toContain(call.stage)
    expect(task.progress).toContainEqual({
      stage: 'fill',
      percent: expect.any(Number) as number,
      detail: { done: 1000, total: 1442 },
    })

    // The full log, in the workspace logs, and the lines streamed to the task.
    expect(dirname(generation.logPath)).toBe(ws.logs)
    expect(basename(generation.logPath)).toMatch(/^generate-\d{8}-\d{6}(?:-\d+)?\.txt$/)
    const log = readFileSync(generation.logPath, 'utf8')
    expect(log).toContain('Filling the multiworld with 3190 items.')
    expect(log).toContain('Done. Enjoy. Total Time: ')
    expect(task.logs).toContainEqual({ stream: 'stdout', line: 'Creating MultiWorld.' })
  })

  it('hands the stored generation to onGenerated, whose failure fails nothing', async () => {
    const id = await aliceAndBob()
    const seen: { sessionId: string; zipPath: string; status: string }[] = []
    const onGenerated = async (sessionId: string, generation: { zipPath: string }): Promise<void> => {
      seen.push({ sessionId, zipPath: generation.zipPath, status: (await store.get(sessionId)).status })
      throw new Error('the hook failed')
    }

    const generation = await within(
      runGeneration(core.ctx, { ...deps, onGenerated }, id, taskSpy().handle),
      15_000,
    )
    // Called once the session holds the new generation.
    expect(seen).toEqual([{ sessionId: id, zipPath: generation.zipPath, status: 'generated' }])

    // Not called when the generation fails.
    mode = 'fail'
    seen.length = 0
    await expect(
      runGeneration(core.ctx, { ...deps, onGenerated }, id, taskSpy().handle, { replace: true }),
    ).rejects.toBeInstanceOf(AppError)
    expect(seen).toEqual([])
  })

  it('runGeneration failure does not hang (stdin ignored) and returns mapped error', async () => {
    mode = 'fail'
    const id = await aliceAndBob()
    const ws = wsOf(id)
    const started = Date.now()

    const failure = await within(
      runGeneration(core.ctx, deps, id, taskSpy().handle).then(
        () => null,
        (error: unknown) => error,
      ),
      10_000,
    )

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(failure).toBeInstanceOf(AppError)
    const error = failure as AppError
    expect(error.code).toBe('AP_YAML_INVALID')
    expect(error.params).toMatchObject({ file: 'Bob.yaml' })
    expect(error.detail).toContain('ValueError: Encountered 1 error(s) in player files.')
    expect(error.detail).not.toContain('Press enter to close.')
    expect(dirname(error.logPath ?? '')).toBe(ws.logs)
    expect(readFileSync(error.logPath ?? '', 'utf8')).toContain('1. File Bob.yaml is invalid.')
    expect(await store.get(id)).toMatchObject({ status: 'draft', generation: null })
  })

  it('runGeneration refuses with GENERATION_PREFLIGHT when validation blocks', async () => {
    const zork = await sessionWith(
      ['Alice.yaml', player('Alice', 'Pokemon Emerald')],
      ['Carol.yaml', player('Carol', 'Zork')],
    )
    await expect(runGeneration(core.ctx, deps, zork, taskSpy().handle)).rejects.toMatchObject({
      code: 'GENERATION_PREFLIGHT',
      params: { errors: 1 },
    })
    // A game that needs a ROM nobody has.
    const rom = await sessionWith(['Alice.yaml', player('Alice', LTTP)])
    await expect(runGeneration(core.ctx, deps, rom, taskSpy().handle)).rejects.toMatchObject({
      code: 'GENERATION_PREFLIGHT',
      params: { errors: 1 },
    })
    const empty = await sessionWith()
    await expect(runGeneration(core.ctx, deps, empty, taskSpy().handle)).rejects.toMatchObject({
      code: 'GENERATION_PREFLIGHT',
    })
    // Nothing ran and nothing was written.
    expect(existsSync(recordFile)).toBe(false)
    for (const id of [zork, rom, empty]) expect(existsSync(join(wsOf(id).dir, 'host.yaml'))).toBe(false)
  })

  it.each([
    [
      'a room on archipelago.gg',
      {
        mode: 'web',
        seedId: 'seed1',
        roomId: 'room1',
        roomUrl: 'https://archipelago.gg/room/room1',
        port: 38281,
      },
    ],
    ['a local server that stopped', { mode: 'local', port: 38281, savefile: 'AP_old.apsave' }],
  ] as const)(
    'generates a session hosted by %s again only once replacing it is confirmed',
    async (_, hosting) => {
      const id = await aliceAndBob()
      await store.setHosting(id, hosting)
      expect((await store.get(id)).status).toBe('hosting')

      // Not confirmed: nothing runs, the session keeps its game.
      await expect(runGeneration(core.ctx, deps, id, taskSpy().handle)).rejects.toMatchObject({
        code: 'GENERATION_PREFLIGHT',
        params: { reason: 'game-in-progress' },
      })
      expect(existsSync(recordFile)).toBe(false)
      expect(await store.get(id)).toMatchObject({ status: 'hosting', hosting })

      const generation = await within(
        runGeneration(core.ctx, deps, id, taskSpy().handle, { replace: true }),
        15_000,
      )

      // A new seed: the old room stays on the site, the session no longer points to it.
      expect(generation.seedName).toBe(SEED)
      expect(await store.get(id)).toMatchObject({ status: 'generated', generation, hosting: null })
    },
  )

  it('counts the save of the current seed as a game in progress', async () => {
    const id = await aliceAndBob()
    const first = await within(runGeneration(core.ctx, deps, id, taskSpy().handle), 15_000)
    // A generation with nothing hosted yet is replaced without asking.
    await within(runGeneration(core.ctx, deps, id, taskSpy().handle), 15_000)
    // Where MultiServer 0.6.8 saves, whatever --savefile says: next to AP_<seed>.zip.
    writeFileSync(join(wsOf(id).output, `AP_${first.seedName}.apsave`), 'save')

    await expect(runGeneration(core.ctx, deps, id, taskSpy().handle)).rejects.toMatchObject({
      code: 'GENERATION_PREFLIGHT',
      params: { reason: 'game-in-progress' },
    })
    await expect(
      within(runGeneration(core.ctx, deps, id, taskSpy().handle, { replace: true }), 15_000),
    ).resolves.toMatchObject({ seedName: SEED })
  })

  it('fails without touching the session when a local server came up while Archipelago generated', async () => {
    const id = await aliceAndBob()
    const previous = await within(runGeneration(core.ctx, deps, id, taskSpy().handle), 15_000)
    const patch = previous.slots[0]?.patchFile ?? ''
    expect(existsSync(patch)).toBe(true)
    // No server at the start; one serves the previous seed once Archipelago is done.
    let checks = 0
    const serving: GenerateDeps = { ...deps, isServing: () => checks++ > 0 }

    const error = await runGeneration(core.ctx, serving, id, taskSpy().handle).catch((e: unknown) => e)

    expect(error).toMatchObject({ code: 'GENERATION_PREFLIGHT', params: { reason: 'hosting' } })
    expect((error as AppError).logPath).toBeDefined()
    // The served seed keeps its patches, and the session its generation.
    expect(existsSync(patch)).toBe(true)
    expect((await store.get(id)).generation).toEqual(previous)
  })

  it('refuses with WORLD_CORRUPT_BLOCKING when a world would stop Archipelago, whatever the players use', async () => {
    const id = await aliceAndBob()
    const custom = join(apDir, 'custom_worlds')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'broken.apworld'), 'not a zip')

    await expect(runGeneration(core.ctx, deps, id, taskSpy().handle)).rejects.toMatchObject({
      code: 'WORLD_CORRUPT_BLOCKING',
      params: { file: 'broken.apworld' },
    })
    expect(existsSync(recordFile)).toBe(false)
  })

  it('refuses without Archipelago', async () => {
    const id = await aliceAndBob()
    const noAp: GenerateDeps = {
      ...deps,
      locator: { detect: () => Promise.resolve(null), exe: (install, name) => locator.exe(install, name) },
    }
    await expect(runGeneration(core.ctx, noAp, id, taskSpy().handle)).rejects.toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
    // The program went missing after the detection.
    const gone: GenerateDeps = {
      ...deps,
      locator: {
        detect: () => locator.detect(),
        exe: () => ({ command: join(root, 'gone', 'ArchipelagoGenerate.exe'), argsPrefix: [] }),
      },
    }
    await expect(runGeneration(core.ctx, gone, id, taskSpy().handle)).rejects.toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
    expect(existsSync(recordFile)).toBe(false)
  })

  it('refuses while a local server of the session runs', async () => {
    const id = await aliceAndBob()
    const other = await aliceAndBob()
    const server = spawnAp(core.ctx, {
      exe: { command: process.execPath, argsPrefix: [join(FAKE_AP, 'ArchipelagoServer.mjs')] },
      args: ['--port', '0'],
      cwd: wsOf(id).dir,
      stdin: 'pipe',
      sessionId: id,
    })
    try {
      await expect(runGeneration(core.ctx, deps, id, taskSpy().handle)).rejects.toMatchObject({
        code: 'GENERATION_PREFLIGHT',
        params: { reason: 'hosting' },
      })
      // The server of one session does not block another one.
      await expect(
        within(runGeneration(core.ctx, deps, other, taskSpy().handle), 15_000),
      ).resolves.toMatchObject({ seedName: SEED })
    } finally {
      server.kill()
      await within(server.exited, 5000)
    }
  })

  it('refuses while an orphan server of a previous run holds the session, which keeps its hosting', async () => {
    const id = await aliceAndBob()
    const hosting = { mode: 'local', port: 38281, savefile: join(wsOf(id).output, 'AP_old.apsave') } as const
    await store.setHosting(id, hosting)
    // Not a child of this run: only the servers manager knows of it, once it has reconciled.
    const servers = createServerManager(core.ctx, {
      sessions: { ...store, resolveRomNeeds: () => Promise.resolve([]) },
      settings,
      locator,
      orphans: {
        find: () => Promise.resolve([{ pid: 9001, exe: 'ArchipelagoServer', sessionId: id }]),
        stop: () => Promise.resolve('stopped'),
      },
    })
    await servers.reconcile()
    const serving: GenerateDeps = { ...deps, isServing: (sessionId) => servers.isBusy(sessionId) }

    await expect(runGeneration(core.ctx, serving, id, taskSpy().handle)).rejects.toMatchObject({
      code: 'GENERATION_PREFLIGHT',
      params: { reason: 'hosting' },
    })
    expect(existsSync(recordFile)).toBe(false)
    expect(await store.get(id)).toMatchObject({ status: 'hosting', generation: null, hosting })
  })

  it('runGeneration extracts per-slot files and stores absolute patchFile paths', async () => {
    const id = await aliceAndBob()
    const ws = wsOf(id)
    // A slot folder of a previous generation: replaced by the new one.
    mkdirSync(join(ws.output, 'slots', 'P9_Old'), { recursive: true })
    writeFileSync(join(ws.output, 'slots', 'P9_Old', 'AP_old_P9_Old.apemerald'), 'old')

    const generation = await within(runGeneration(core.ctx, deps, id, taskSpy().handle), 15_000)

    const patchFile = generation.slots[0]?.patchFile ?? ''
    expect(isAbsolute(patchFile)).toBe(true)
    expect(patchFile).toBe(join(ws.output, 'slots', 'P1_Alice', `AP_${SEED}_P1_Alice.apemerald`))
    expect(JSON.parse((await readZipText(patchFile, 'archipelago.json')) ?? '{}')).toMatchObject({
      player: 1,
      player_name: 'Alice',
      game: 'Pokemon Emerald',
    })
    // Only the slot files: neither the multidata nor the spoiler, and Bob has no file.
    expect(readdirSync(join(ws.output, 'slots'))).toEqual(['P1_Alice'])
    expect(readdirSync(join(ws.output, 'slots', 'P1_Alice'))).toEqual([`AP_${SEED}_P1_Alice.apemerald`])
    expect(generation.slots[1]?.patchFile).toBeNull()
  })

  it('cancel kills a slow fake generate and removes partial output', async () => {
    mode = 'slow'
    const id = await aliceAndBob()
    const ws = wsOf(id)
    mkdirSync(ws.output, { recursive: true })
    writeFileSync(join(ws.output, `AP_previous.zip`), 'a previous generation')
    const task = taskSpy((call, spy) => {
      if (call.stage !== 'weights' || spy.controller.signal.aborted) return
      // What Archipelago was writing when it was stopped.
      writeFileSync(join(ws.output, `AP_${SEED}.zip`), 'half a zip')
      spy.controller.abort(new AppError('TASK_CANCELLED'))
    })
    const started = Date.now()

    await expect(within(runGeneration(core.ctx, deps, id, task.handle), 5000)).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
    })

    expect(Date.now() - started).toBeLessThan(4000)
    expect(listChildren()).toEqual([])
    expect(readdirSync(ws.output)).toEqual(['AP_previous.zip'])
    await delay(400)
    expect(readdirSync(ws.output)).toEqual(['AP_previous.zip'])
    expect(task.progress.map((call) => call.stage)).not.toContain('done')
    expect(await store.get(id)).toMatchObject({ status: 'draft', generation: null })
  })

  it('reports a stall after a silence without a new line, then clears it', async () => {
    mode = 'slow'
    const id = await aliceAndBob()
    let cleared = false
    const task = taskSpy((call, spy) => {
      const stalled = spy.progress.some((c) => c.detail?.stalled === 1)
      if (stalled && call.detail?.stalled === undefined && !spy.controller.signal.aborted) {
        cleared = true
        spy.controller.abort(new AppError('TASK_CANCELLED'))
      }
    })

    await expect(
      within(runGeneration(core.ctx, { ...deps, stallMs: 60 }, id, task.handle), 5000),
    ).rejects.toMatchObject({ code: 'TASK_CANCELLED' })

    const stall = task.progress.find((call) => call.detail?.stalled === 1)
    expect(stall).toBeDefined()
    expect(GENERATE_STAGE_IDS).toContain(stall?.stage)
    expect(cleared).toBe(true)
  })

  it('session host.yaml contains the vault rom path when the global key is unset', async () => {
    const romDir = join(root, 'Mes ROMs')
    mkdirSync(romDir)
    const rom = join(romDir, 'Zelda é.sfc')
    writeFileSync(rom, ROM_BYTES)
    await vault.scan([rom], taskSpy().handle)
    const id = await sessionWith(
      ['Alice.yaml', player('Alice', LTTP)],
      ['Bob.yaml', player('Bob', 'A Hat in Time')],
    )
    await store.setSecrets(id, { serverPassword: 'hunter2 secret' })

    await within(runGeneration(core.ctx, deps, id, taskSpy().handle), 15_000)

    const hostYaml = join(wsOf(id).dir, 'host.yaml')
    const session = parse(readFileSync(hostYaml, 'utf8')) as {
      lttp_options: { rom_file: string }
      generator: { spoiler: number; plando_options: string }
      server_options: { server_password: string; hint_cost: number }
    }
    expect(session.lttp_options.rom_file).toBe(rom)
    expect(session.generator).toMatchObject({ spoiler: 3, plando_options: 'bosses, connections, texts' })
    expect(session.server_options).toMatchObject({ server_password: 'hunter2 secret', hint_cost: 10 })
    if (process.platform !== 'win32') expect(statSync(hostYaml).mode & 0o777).toBe(0o600)
    // The global settings are untouched.
    expect(readFileSync(join(apDir, 'host.yaml'), 'utf8')).toBe(GLOBAL_HOST_YAML)
  })
})

describe('session:generate', () => {
  let savedFakeDir: string | undefined

  beforeEach(async () => {
    const fakeDir = join(root, 'fake AP')
    makeShims(fakeDir)
    writeFileSync(join(fakeDir, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    await makeApworld(join(fakeDir, 'custom_worlds', 'tunic.apworld'), {
      manifest: apworldManifest('TUNIC', { world_version: '3.1.0' }),
    })
    savedFakeDir = process.env.GOAT_FAKE_AP_DIR
    process.env.GOAT_FAKE_AP_DIR = fakeDir
  })

  afterEach(() => {
    if (savedFakeDir === undefined) delete process.env.GOAT_FAKE_AP_DIR
    else process.env.GOAT_FAKE_AP_DIR = savedFakeDir
  })

  /** The real services and their handlers, a session the fake Archipelago generates, and its task end. */
  async function generatorService() {
    const services = createServices(core.ctx)
    const ipc = createIpcRegistry()
    registerHandlers(services, ipc.registerHandler)
    const sessions = services.get('sessions')
    const { id } = await sessions.create('Soirée')
    await sessions.addText(id, 'Alice.yaml', player('Alice', 'TUNIC'))
    const ended = new Promise<TaskDone | TaskFailed>((done) => {
      core.ctx.bus.on('task:done', done)
      core.ctx.bus.on('task:failed', done)
    })
    return { services, ipc, sessions, id, ended }
  }

  it('starts the generation as a task of the generator service', async () => {
    const { ipc, sessions, id, ended } = await generatorService()

    const answer = await ipc.dispatch('session:generate', { id }, { senderId: 1 })

    expect(answer).toEqual({ ok: true, value: { taskId: expect.any(String) as string } })
    const end = await within(ended, 15_000)
    expect(end).toMatchObject({ kind: 'generate', result: { seedName: SEED } })
    expect(end.taskId).toBe((answer as { value: { taskId: string } }).value.taskId)
    expect(await sessions.get(id)).toMatchObject({ status: 'generated', generation: { seedName: SEED } })
  })

  it('refuses a session whose server the servers service reports, an orphan included', async () => {
    const { services, ipc, sessions, id, ended } = await generatorService()
    const hosting = { mode: 'local', port: 38281, savefile: join(wsOf(id).output, 'AP_old.apsave') } as const
    await sessions.setHosting(id, hosting)
    // What the servers service answers for a server it starts, runs or stops, or an orphan it found.
    const isBusy = vi.spyOn(services.get('servers'), 'isBusy').mockReturnValue(true)

    const answer = await ipc.dispatch('session:generate', { id }, { senderId: 1 })

    expect(answer).toMatchObject({ ok: true })
    expect(await within(ended, 15_000)).toMatchObject({
      kind: 'generate',
      error: { code: 'GENERATION_PREFLIGHT', params: { reason: 'hosting' } },
    })
    expect(isBusy).toHaveBeenCalledWith(id)
    expect(await sessions.get(id)).toMatchObject({ status: 'hosting', generation: null, hosting })
  })

  it('keeps a generation and a local server of the same session apart, and the session undeletable', async () => {
    const { services, ipc, sessions, id, ended } = await generatorService()
    const generator = services.get('generator')
    expect(generator.isGenerating(id)).toBe(false)

    const answer = await ipc.dispatch('session:generate', { id }, { senderId: 1 })
    expect(answer).toMatchObject({ ok: true })
    // From the answer on, until the task is over.
    expect(generator.isGenerating(id)).toBe(true)
    expect(await ipc.dispatch('server:start', { sessionId: id }, { senderId: 1 })).toMatchObject({
      ok: false,
      error: { code: 'AP_RUNNING', params: { reason: 'generating' } },
    })
    expect(await ipc.dispatch('session:delete', { id }, { senderId: 1 })).toMatchObject({
      ok: false,
      error: { code: 'AP_RUNNING' },
    })

    expect(await within(ended, 15_000)).toMatchObject({ kind: 'generate', result: { seedName: SEED } })
    await vi.waitFor(() => expect(generator.isGenerating(id)).toBe(false))
    expect(await sessions.get(id)).toMatchObject({ status: 'generated' })
  })

  it('a generation cancelled before it starts is not counted as running', async () => {
    const { services, id } = await generatorService()
    const generator = services.get('generator')
    const { taskId } = generator.generate(id)
    expect(generator.isGenerating(id)).toBe(true)
    core.ctx.tasks.cancel(taskId)
    expect(generator.isGenerating(id)).toBe(false)
  })
})
