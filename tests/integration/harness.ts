// The end-to-end harness of the integration tests: a fake Archipelago install, and the real services of
// the main process (createServices) behind the real IPC handlers, over a fake Platform rooted in a
// temporary folder, as src/main/index.ts wires them.
//
// The Playwright helpers (Task 34) import createFakeApInstall from here, under Playwright's own loader,
// which compiles a .ts file of this package to CommonJS. So this module loads nothing at import time
// but Node, yazl and make-apworld: the app's modules (`@main`, `@shared`) only as types, which the
// transform erases, no Vitest API, and the ES modules of tests/fake-ap through `import()`, which
// CommonJS can call. createTestCore loads the app's modules when it is called, under Vitest only.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreContext, Platform, PlatformPaths } from '@main/core/context'
import type { LogEntry, Logger } from '@main/core/logger'
import type { ServiceContainer } from '@main/services/registry'
import type { AppErrorData } from '@shared/errors'
import type { ChannelInput, ChannelName, ChannelOutput } from '@shared/ipc/contract'
import type { Generation, OS, Session, SessionValidation, TaskRef } from '@shared/types'
import { makeApworld } from '../helpers/make-apworld'

const fakeAp = (): Promise<typeof import('../fake-ap/make-shims.mjs')> => import('../fake-ap/make-shims.mjs')

/** tests/fixtures, next to tests/fake-ap. */
const fixturesDir = async (): Promise<string> => join((await fakeAp()).FAKE_AP_DIR, '..', 'fixtures')

/** The files of tests/fixtures/yamls an organizer adds: five TUNIC players, one file in Windows-1252. */
export const FIXTURE_YAMLS: readonly string[] = [
  'valid.yaml',
  'bom-crlf-multi.yaml',
  'windows-1252.yaml',
  'utf16le-bom.yaml',
]

// --- the fake install -----------------------------------------------------------------------------

/** The name Archipelago gives a game's files (fileSafeName of src/main/core/yaml/template-parser.ts). */
const fileSafe = (game: string): string => game.replace(/[<>:"/\\|?*]/g, '')

/** A module name for the game's world: `Pokemon Emerald` → `pokemon_emerald`. */
const moduleOf = (game: string): string =>
  game
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/**
 * Writes a complete fake Archipelago 0.6.8 install in `dir` (created) and returns `dir`: `manifest.json`,
 * the fake programs as one-line `.mjs` shims of tests/fake-ap, `lib/worlds/<module>.apworld` and
 * `Players/Templates/<game>.yaml` (from tests/fixtures/templates) for each game, an empty `custom_worlds/`.
 * Throws for a game that has no template fixture. Point GOAT_FAKE_AP_DIR at it.
 */
export async function createFakeApInstall(
  dir: string,
  { games }: { games: readonly string[] },
): Promise<string> {
  const { makeShims } = await fakeAp()
  const fixtures = await fixturesDir()
  const templates = join(dir, 'Players', 'Templates')
  mkdirSync(templates, { recursive: true })
  mkdirSync(join(dir, 'custom_worlds'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
  makeShims(dir)
  for (const game of new Set(games)) {
    const template = join(fixtures, 'templates', `${fileSafe(game)}.yaml`)
    if (!existsSync(template)) throw new Error(`no template fixture for ${game} (${template})`)
    copyFileSync(template, join(templates, `${fileSafe(game)}.yaml`))
    await makeApworld(join(dir, 'lib', 'worlds', `${moduleOf(game)}.apworld`), { game })
  }
  return dir
}

// --- the test core --------------------------------------------------------------------------------

export interface TestCoreOptions {
  /** A fresh folder the test owns (and removes): every folder of the fake Platform lives in it. */
  tmp: string
  /** GOAT_WEBHOST_URL, the mock archipelago.gg. Default: the real site, which the test network never reaches. */
  webhostUrl?: string
  /** GOAT_FAKE_AP_DIR, a tree of createFakeApInstall. Without it Archipelago is looked for as usual, inside `tmp`. */
  fakeApDir?: string
  /** The system the services believe they run on. Default: the host's. */
  os?: OS
  /** Hosts whose requests go to a local server instead (`{ 'api.github.com': 'http://127.0.0.1:…' }`). */
  hosts?: Readonly<Record<string, string>>
}

/** An answer of the dialog queue, as in GOAT_E2E_DIALOGS: path(s), or null for a cancelled dialog. */
export type DialogAnswer = string | readonly string[] | null

/** A channel or a task that failed: `error` is what the renderer would get. */
export class HarnessError extends Error {
  constructor(
    message: string,
    readonly error: AppErrorData,
  ) {
    super(message)
    this.name = 'HarnessError'
  }
}

type CallArgs<C extends ChannelName> =
  undefined extends ChannelInput<C> ? [input?: ChannelInput<C>] : [input: ChannelInput<C>]

export interface TestCore {
  services: ServiceContainer
  ctx: CoreContext
  /** A renderer call: the channel's schema, its handler, the services. Throws HarnessError when it fails. */
  call<C extends ChannelName>(name: C, ...input: CallArgs<C>): Promise<ChannelOutput<C>>
  /** The result of the task (task:done); HarnessError for task:failed. */
  waitTask<T>(ref: TaskRef, timeoutMs?: number): Promise<T>
  /** Answers for the next open or save dialogs, in order; an empty queue answers "cancelled". */
  queueDialog(...answers: DialogAnswer[]): void
  /** Everything the services logged. */
  logs: LogEntry[]
  /** Quits as the app does (servers stopped with /exit, children killed), then restores the environment. */
  cleanup(): Promise<void>
}

const MAX_LOGS = 5000
const TASK_TIMEOUT_MS = 50_000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** What the run reads from the environment, set for the test and restored by `cleanup`. */
const ENV_KEYS = ['GOAT_FAKE_AP_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] as const

/**
 * `fetch` for a test: the hosts of `hosts` go to their local server, loopback goes through, and any
 * other host fails as when the network is down. Nothing reaches the Internet.
 */
function testFetch(hosts: Readonly<Record<string, string>>): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const local = hosts[url.host]
    if (local !== undefined) return fetch(`${local}${url.pathname}${url.search}`, init)
    if (LOOPBACK.has(url.hostname)) return fetch(input, init)
    const cause = Object.assign(new Error(`no network in the integration tests: ${url.host}`), {
      code: 'ENETUNREACH',
    })
    return Promise.reject(new TypeError('fetch failed', { cause }))
  }
}

function memoryLogger(entries: LogEntry[]): Logger {
  const write =
    (level: LogEntry['level']) =>
    (message: string, data?: unknown): void => {
      const entry: LogEntry = { ts: new Date().toISOString(), level, message }
      if (data !== undefined) entry.data = data
      if (entries.push(entry) > MAX_LOGS) entries.shift()
    }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/** The warnings and errors logged last: what explains a failure. */
function recentProblems(entries: readonly LogEntry[]): string {
  return entries
    .filter((entry) => entry.level === 'warn' || entry.level === 'error')
    .slice(-10)
    .map(
      (entry) =>
        `  ${entry.level} ${entry.message} ${entry.data === undefined ? '' : String(JSON.stringify(entry.data))}`,
    )
    .join('\n')
}

const asPaths = (answer: DialogAnswer | undefined): string[] =>
  typeof answer === 'string' ? [answer] : answer ? [...answer] : []

/** A Platform without Electron, its folders under `tmp`, its dialogs answered by a queue. */
function fakePlatform(tmp: string, os: OS, dialogs: DialogAnswer[]): Platform {
  const paths: PlatformPaths = {
    userData: join(tmp, 'userData'),
    dataRoot: join(tmp, 'dataRoot'),
    temp: join(tmp, 'temp'),
    home: join(tmp, 'home'),
    downloads: join(tmp, 'downloads'),
    exe: join(tmp, 'app', os === 'win32' ? 'ArchipelaGOAT.exe' : 'archipelagoat'),
  }
  for (const dir of [paths.userData, paths.dataRoot, paths.temp, paths.home, paths.downloads]) {
    mkdirSync(dir, { recursive: true })
  }
  // A reversible scramble: never the plaintext on disk, as with safeStorage.
  const scramble = (bytes: Uint8Array): Buffer => Buffer.from(bytes.map((b) => b ^ 0x5a))
  return {
    os,
    appVersion: '0.1.0-test',
    isPackaged: false,
    locale: 'fr-FR',
    paths,
    canEncrypt: () => true,
    encrypt: (s) => scramble(Buffer.from(s, 'utf8')),
    decrypt: (b) => scramble(b).toString('utf8'),
    openPath: () => Promise.resolve(),
    openExternal: () => Promise.resolve(),
    showOpenDialog: () => Promise.resolve(asPaths(dialogs.shift())),
    showSaveDialog: () => Promise.resolve(asPaths(dialogs.shift())[0] ?? null),
    setProtocolClient: () => true,
  }
}

/**
 * The real services and IPC handlers over a fake Platform, as src/main/index.ts builds them: a real
 * config (GOAT_WEBHOST_URL as `webhostUrl`), secrets, tasks, bus, lifecycle and allowed paths, an HTTP
 * client without the Internet, and the eager services started. GOAT_FAKE_AP_DIR (set to `fakeApDir`,
 * or removed) and the XDG folders (inside `tmp`) hold until `cleanup`.
 */
export async function createTestCore(opts: TestCoreOptions): Promise<TestCore> {
  const { tmp } = opts
  const os: OS = opts.os ?? (process.platform === 'win32' ? 'win32' : 'linux')

  const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  const setEnv = (key: (typeof ENV_KEYS)[number], value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setEnv('GOAT_FAKE_AP_DIR', opts.fakeApDir)
  // The desktop tools and Archipelago's Linux folders stay in `tmp`, never in the user's own.
  for (const [key, name] of [
    ['XDG_DATA_HOME', 'data'],
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_CACHE_HOME', 'cache'],
  ] as const) {
    const dir = join(tmp, 'xdg', name)
    mkdirSync(dir, { recursive: true })
    setEnv(key, dir)
  }
  const restoreEnv = (): void => {
    for (const [key, value] of savedEnv) setEnv(key, value)
  }

  try {
    const [
      { createConfigStore },
      { createEventBus },
      { exec },
      { apUserAgent, createHttp },
      { createSecretStore },
      { createAllowedPaths },
      { createTaskManager },
      { createLifecycle },
      { createServices },
      { registerHandlers },
      { createIpcRegistry },
      { withoutApProcesses },
    ] = await Promise.all([
      import('@main/core/config'),
      import('@main/core/events'),
      import('@main/core/exec'),
      import('@main/core/system/http'),
      import('@main/core/secrets'),
      import('@main/core/system/user-path'),
      import('@main/core/tasks'),
      import('@main/lifecycle'),
      import('@main/services'),
      import('@main/ipc'),
      import('@main/ipc/registry'),
      import('@main/core/ap/processes'),
    ])

    const logs: LogEntry[] = []
    const log = memoryLogger(logs)
    const dialogs: DialogAnswer[] = []
    const platform = fakePlatform(tmp, os, dialogs)
    const bus = createEventBus(log)
    const lifecycle = createLifecycle({ bus, log, quit: () => undefined })
    const config = createConfigStore(join(platform.paths.userData, 'config.json'), os, {
      bus,
      webhostUrlOverride: opts.webhostUrl ?? null,
    })
    const tasks = createTaskManager(bus, log)
    const secrets = createSecretStore(join(platform.paths.userData, 'secrets.bin'), platform, config)
    const ctx: CoreContext = {
      platform,
      log,
      // As src/main/index.ts in a test run with a fake Archipelago: a real one the machine runs does not
      // lock the settings of a flow.
      exec: opts.fakeApDir === undefined ? exec : withoutApProcesses(exec),
      http: createHttp({
        userAgent: apUserAgent(platform.appVersion),
        cacheDir: join(platform.paths.dataRoot, 'catalog'),
        log,
        githubToken: () => secrets.get('github.token'),
        fetch: testFetch(opts.hosts ?? {}),
      }),
      tasks,
      config,
      secrets,
      bus,
      lifecycle,
      paths: createAllowedPaths(
        [platform.paths.dataRoot, platform.paths.userData, platform.paths.downloads],
        os,
      ),
    }

    // The task ends, kept from the start: a task may end before the test waits for it.
    const ended = new Map<string, { ok: true; result: unknown } | { ok: false; error: AppErrorData }>()
    const waiters = new Map<string, () => void>()
    const settle = (
      taskId: string,
      outcome: { ok: true; result: unknown } | { ok: false; error: AppErrorData },
    ): void => {
      ended.set(taskId, outcome)
      waiters.get(taskId)?.()
    }
    bus.on('task:done', ({ taskId, result }) => settle(taskId, { ok: true, result }))
    bus.on('task:failed', ({ taskId, error }) => settle(taskId, { ok: false, error }))

    // What src/main/index.ts adds around the services.
    lifecycle.onCloseRequested(() => ({ servers: [], tasks: tasks.list().map((task) => task.kind) }))
    lifecycle.onBeforeQuit(() => {
      for (const task of tasks.list()) tasks.cancel(task.taskId)
      return Promise.resolve()
    })
    const services = createServices(ctx)
    services.startEager()
    const ipc = createIpcRegistry()
    registerHandlers(services, ipc.registerHandler)

    let cleaned = false

    return {
      services,
      ctx,
      logs,

      async call<C extends ChannelName>(name: C, ...[input]: CallArgs<C>): Promise<ChannelOutput<C>> {
        const answer = await ipc.dispatch(name, input, { senderId: 1 }, log)
        if (answer.ok) return answer.value as ChannelOutput<C>
        throw new HarnessError(
          `${name} failed: ${JSON.stringify(answer.error)}\n${recentProblems(logs)}`,
          answer.error,
        )
      },

      async waitTask<T>(ref: TaskRef, timeoutMs = TASK_TIMEOUT_MS): Promise<T> {
        if (!ended.has(ref.taskId)) {
          let timer: NodeJS.Timeout | undefined
          await new Promise<void>((resolve, reject) => {
            waiters.set(ref.taskId, resolve)
            timer = setTimeout(
              () => reject(new Error(`task ${ref.taskId} still runs after ${timeoutMs} ms`)),
              timeoutMs,
            )
          }).finally(() => {
            clearTimeout(timer)
            waiters.delete(ref.taskId)
          })
        }
        const outcome = ended.get(ref.taskId)
        if (outcome?.ok) return outcome.result as T
        const error = outcome?.error ?? { code: 'AP_UNKNOWN' }
        throw new HarnessError(`task failed: ${JSON.stringify(error)}\n${recentProblems(logs)}`, error)
      },

      queueDialog(...answers) {
        dialogs.push(...answers)
      },

      async cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          await lifecycle.runBeforeQuit()
        } finally {
          restoreEnv()
        }
      },
    }
  } catch (error) {
    restoreEnv()
    throw error
  }
}

// --- flows ----------------------------------------------------------------------------------------

export interface OrganizedSession {
  /** The session once generated. */
  session: Session
  /** What session:addFiles answered. */
  added: { session: Session; ignored: string[] }
  validation: SessionValidation
  generation: Generation
}

/**
 * The organizer's first steps, as the screens make them: a new session, the FIXTURE_YAMLS picked in the
 * (queued) file dialog and added, the session validated (an Error when it blocks), then generated by
 * the fake ArchipelagoGenerate.
 */
export async function organizeFixtureSession(core: TestCore, name: string): Promise<OrganizedSession> {
  const created = await core.call('session:create', { name })
  const yamls = join(await fixturesDir(), 'yamls')
  core.queueDialog(FIXTURE_YAMLS.map((file) => join(yamls, file)))
  const paths = await core.call('app:pickPaths', {
    mode: 'files',
    filters: [{ name: 'YAML', extensions: ['yaml', 'yml', 'txt', 'zip'] }],
  })
  const added = await core.call('session:addFiles', { id: created.id, paths })
  const validation = await core.call('session:validate', { id: created.id })
  if (validation.blocking)
    throw new Error(`the fixture session does not validate: ${JSON.stringify(validation)}`)
  const generation = await core.waitTask<Generation>(await core.call('session:generate', { id: created.id }))
  const session = await core.call('session:get', { id: created.id })
  return { session, added, validation, generation }
}
