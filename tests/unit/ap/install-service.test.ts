import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { createInstallService, type InstallService } from '@main/core/ap/install-service'
import { createLocator, type Locator } from '@main/core/ap/locator'
import type { ProcessInfo } from '@main/core/ap/processes'
import type { ExecFn, ExecResult } from '@main/core/exec'
import { createHttp } from '@main/core/system/http'
import { psQuote } from '@main/core/system/powershell'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `installer` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/installer.service'
import { apExeFileName } from '@shared/data/ap-constants'
import type { AppErrorData } from '@shared/errors'
import type { ApInstall, ApPaths, ApRelease, OS, TaskRef } from '@shared/types'
import { createTestContext, hostOs, silentLogger, type TestCore } from '../../helpers/core'
import { fetchVia, reply, startTestServer, type TestServer } from '../../helpers/http-server'
import { makeApworld } from '../../helpers/make-apworld'
import { AP_LINUX_RELEASE_ITEMS, tarGz } from '../../helpers/make-targz'

const DOWNLOADS = 'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.8'
const SETUP_NAME = 'Setup.Archipelago.0.6.8.exe'
const TGZ_NAME = 'Archipelago_0.6.8_linux-x86_64.tar.gz'
const LATEST_PATH = '/repos/ArchipelagoMW/Archipelago/releases/latest'

const setupBytes = Buffer.from('MZ not really an installer')
const tgzBytes = tarGz(AP_LINUX_RELEASE_ITEMS)
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** The release object GitHub answers, with the two assets the tests serve. */
const releaseJson = {
  tag_name: '0.6.8',
  published_at: '2026-10-04T16:20:11Z',
  body: 'Bug fixes.',
  assets: [
    {
      name: SETUP_NAME,
      browser_download_url: `${DOWNLOADS}/${SETUP_NAME}`,
      size: setupBytes.length,
      digest: `sha256:${sha256(setupBytes)}`,
    },
    {
      name: TGZ_NAME,
      browser_download_url: `${DOWNLOADS}/${TGZ_NAME}`,
      size: tgzBytes.length,
      digest: `sha256:${sha256(tgzBytes)}`,
    },
  ],
}

type Outcome = { ok: true; result: unknown } | { ok: false; error: AppErrorData }

let root: string
let core: TestCore
let server: TestServer
let processes: ProcessInfo[][]
let listCalls: number
let order: string[]
let outcomes: Map<string, Outcome>
let stages: Map<string, string[]>
let installed: ApInstall[]
let worldsChanged: number

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

const windowsInstall = (base: string, version: string): ApInstall => ({
  kind: 'windows-installer',
  version,
  root: base,
  appImagePath: null,
  paths: apPaths(base),
})

function setup(os: OS): void {
  core = createTestContext(root, { os })
  core.ctx.http = createHttp({
    userAgent: 'Test/1.0 (unit)',
    cacheDir: join(root, 'cache'),
    log: silentLogger,
    githubToken: () => null,
    fetch: fetchVia(server, 'api.github.com', 'github.com'),
  })
  // Nothing real is ever run: a test that expects a program replaces this.
  core.ctx.exec = (cmd) => Promise.reject(new Error(`unexpected program: ${cmd}`))
  const { bus } = core.ctx
  bus.on('task:progress', ({ taskId, stage }) => {
    const list = stages.get(taskId) ?? []
    if (list.at(-1) !== stage) list.push(stage)
    stages.set(taskId, list)
  })
  bus.on('task:done', ({ taskId, result }) => outcomes.set(taskId, { ok: true, result }))
  bus.on('task:failed', ({ taskId, error }) => outcomes.set(taskId, { ok: false, error }))
  bus.on('ap:installed', (install) => {
    order.push('ap:installed')
    installed.push(install)
  })
  bus.on('worlds:changed', () => {
    order.push('worlds:changed')
    worldsChanged++
  })
}

/** Records the calls made to the locator, in the order they come with the events. */
function spyLocator(locator: Pick<Locator, 'detect' | 'invalidate' | 'fromRoot'>): Locator {
  return {
    detect: () => {
      order.push('detect')
      return locator.detect()
    },
    invalidate: () => {
      order.push('invalidate')
      locator.invalidate()
    },
    fromRoot: (rootDir, kind) => locator.fromRoot(rootDir, kind),
    exe: () => {
      throw new Error('not used')
    },
  }
}

function service(locator: Pick<Locator, 'detect' | 'invalidate' | 'fromRoot'>): InstallService {
  return createInstallService(core.ctx, {
    locator: spyLocator(locator),
    listProcesses: () => {
      listCalls++
      return Promise.resolve(processes.shift() ?? [])
    },
  })
}

async function settle(ref: TaskRef): Promise<Outcome> {
  await vi.waitFor(() => expect(outcomes.has(ref.taskId)).toBe(true), { timeout: 10_000 })
  return outcomes.get(ref.taskId) as Outcome
}

async function succeeded(ref: TaskRef): Promise<unknown> {
  const outcome = await settle(ref)
  if (!outcome.ok) throw new Error(`task failed: ${JSON.stringify(outcome.error)}`)
  return outcome.result
}

async function failed(ref: TaskRef): Promise<AppErrorData> {
  const outcome = await settle(ref)
  if (outcome.ok) throw new Error('expected the task to fail')
  return outcome.error
}

const dataRoot = (): string => core.ctx.platform.paths.dataRoot
const scriptOf = (args: string[]): string => Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le')
const requestsFor = (name: string): number => server.requests.filter((r) => r.url.endsWith(`/${name}`)).length

function write(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

const backups = (): string[] => {
  const dir = join(dataRoot(), 'backups')
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat installer é-'))
  server = await startTestServer((req, res) => {
    if (req.url === LATEST_PATH) return reply(res, 200, JSON.stringify(releaseJson))
    if (req.url?.endsWith(`/${SETUP_NAME}`)) return reply(res, 200, setupBytes)
    if (req.url?.endsWith(`/${TGZ_NAME}`)) return reply(res, 200, tgzBytes)
    reply(res, 404)
  })
  processes = []
  listCalls = 0
  order = []
  outcomes = new Map()
  stages = new Map()
  installed = []
  worldsChanged = 0
})

afterEach(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('latest', () => {
  it('answers the latest release, from memory unless forced', async () => {
    setup('win32')
    const installer = service({
      detect: () => Promise.resolve(null),
      invalidate: () => {},
      fromRoot: vi.fn(),
    })
    const release: ApRelease = await installer.latest()
    expect(release.version).toBe('0.6.8')
    expect(release.windows?.sha256).toBe(sha256(setupBytes))
    await installer.latest()
    expect(server.requests.filter((r) => r.url === LATEST_PATH)).toHaveLength(1)
    await installer.latest(true)
    expect(server.requests.filter((r) => r.url === LATEST_PATH)).toHaveLength(2)
  })
})

describe('install on Windows', () => {
  let ap: string
  let detected: ApInstall | null
  let setupExit: number
  let scripts: string[]
  /** What the fake installer sees when it starts. */
  let atSetup: { backups: string[]; disabled: string[]; customWorlds: string[] } | null

  beforeEach(() => {
    setup('win32')
    ap = join(root, 'ProgramData', 'Archipelago')
    detected = null
    setupExit = 0
    scripts = []
    atSetup = null
    core.ctx.exec = (cmd, args): Promise<ExecResult> => {
      if (cmd !== 'powershell.exe') return Promise.reject(new Error(`unexpected program: ${cmd}`))
      scripts.push(scriptOf(args))
      const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])
      atSetup = {
        backups: backups(),
        disabled: list(join(dataRoot(), 'disabled-worlds')),
        customWorlds: list(join(ap, 'custom_worlds')),
      }
      if (setupExit === 0) detected = windowsInstall(ap, '0.6.8')
      return Promise.resolve({ code: setupExit, stdout: '', stderr: '' })
    }
  })

  const installer = (): InstallService =>
    service({ detect: () => Promise.resolve(detected), invalidate: () => {}, fromRoot: vi.fn() })

  async function existingInstall(): Promise<void> {
    detected = windowsInstall(ap, '0.6.7')
    write(join(ap, apExeFileName('ArchipelagoLauncher', 'win32')), 'exe')
    write(join(ap, 'host.yaml'), 'general_options: {}\n')
    write(join(ap, 'options.yaml'), 'generator: {}\n')
    await makeApworld(join(ap, 'custom_worlds', 'good.apworld'))
    // Not a zip: the installer's hidden `--update_settings` step would block on it.
    write(join(ap, 'custom_worlds', 'broken.apworld'), 'not a zip at all')
  }

  it('install backs up settings and quarantines corrupt apworlds before running setup', async () => {
    await existingInstall()

    const ref = installer().install({ desktopIcons: true, customDir: null })
    const result = await succeeded(ref)

    expect(result).toEqual(windowsInstall(ap, '0.6.8'))
    expect(stages.get(ref.taskId)).toEqual([
      'init',
      'download',
      'verify',
      'backup',
      'quarantine',
      'install',
      'detect',
    ])
    // Before the installer ran: one backup with both settings and the list of worlds, and the
    // corrupt world moved out of the folder Archipelago scans.
    expect(atSetup?.disabled).toEqual(['broken.apworld'])
    expect(atSetup?.customWorlds).toEqual(['good.apworld'])
    expect(atSetup?.backups).toHaveLength(1)
    const backup = atSetup?.backups[0] ?? ''
    expect(readdirSync(backup).sort()).toEqual(['custom-worlds.json', 'host.yaml', 'options.yaml'])
    expect(readFileSync(join(backup, 'host.yaml'), 'utf8')).toBe('general_options: {}\n')
    expect(JSON.parse(readFileSync(join(backup, 'custom-worlds.json'), 'utf8'))).toEqual({
      customWorlds: ['broken.apworld', 'good.apworld'],
    })

    // The verified download, run elevated with the silent switches.
    const setupPath = join(dataRoot(), 'downloads', SETUP_NAME)
    expect(readFileSync(setupPath)).toEqual(setupBytes)
    expect(scripts).toHaveLength(1)
    const script = scripts[0] ?? ''
    expect(script).toContain(`$psi.FileName = ${psQuote(setupPath)};`)
    const logDir = join(dataRoot(), 'logs')
    const args = /\$psi\.Arguments = '(.*)'; \$psi\.Verb = 'runas'/.exec(script)?.[1] ?? ''
    expect(args.replaceAll("''", "'")).toMatch(
      new RegExp(
        '^/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CLOSEAPPLICATIONS /TASKS="desktopicon,deletelib" ' +
          `/LOG="${logDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/]ap-setup-[^"]+\\.log"$`,
      ),
    )

    // Then: the cache forgotten, the install detected again, and both events.
    expect(order.slice(-4)).toEqual(['invalidate', 'detect', 'worlds:changed', 'ap:installed'])
    expect(installed).toEqual([windowsInstall(ap, '0.6.8')])
    expect(worldsChanged).toBe(1)
  })

  it('install refuses with AP_RUNNING when Archipelago processes run', async () => {
    await existingInstall()
    processes = [[{ pid: 4242, name: 'ArchipelagoLauncher.exe' }]]

    const error = await failed(installer().install({ desktopIcons: true, customDir: null }))

    expect(error.code).toBe('AP_RUNNING')
    expect(server.requests).toEqual([])
    expect(scripts).toEqual([])
    expect(backups()).toEqual([])
    expect(installed).toEqual([])
  })

  it('checks again for running Archipelago programs right before the installer starts', async () => {
    await existingInstall()
    processes = [[], [{ pid: 7, name: 'ArchipelagoTextClient.exe' }]]

    const error = await failed(installer().install({ desktopIcons: true, customDir: null }))

    expect(error.code).toBe('AP_RUNNING')
    expect(listCalls).toBe(2)
    expect(requestsFor(SETUP_NAME)).toBe(1)
    expect(scripts).toEqual([])
  })

  it('installs even when the running programs cannot be listed', async () => {
    const installer = createInstallService(core.ctx, {
      locator: { detect: () => Promise.resolve(detected), invalidate: () => {}, fromRoot: vi.fn() },
      listProcesses: () => Promise.reject(new Error('tasklist is missing')),
    })
    const result = await succeeded(installer.install({ desktopIcons: true, customDir: null }))
    expect(result).toEqual(windowsInstall(ap, '0.6.8'))
  })

  it('passes a checked customDir as /DIR and deselects the desktop icons', async () => {
    const customDir = join(root, 'Jeux é', 'Archipelago')
    await succeeded(installer().install({ desktopIcons: false, customDir }))
    expect(scripts[0]).toContain(' /TASKS="!desktopicon,deletelib" ')
    expect(scripts[0]).toContain(` /DIR="${customDir.replaceAll("'", "''")}" `)
  })

  it('refuses a customDir that is not a folder the user may write to, before anything else', async () => {
    const error = await failed(installer().install({ desktopIcons: true, customDir: 'relative\\dir' }))
    expect(error.code).toBe('PATH_FORBIDDEN')
    expect(listCalls).toBe(0)
    expect(server.requests).toEqual([])
    expect(scripts).toEqual([])
  })

  it('maps a refused UAC prompt to INSTALL_ELEVATION_DENIED and announces nothing', async () => {
    setupExit = 1223
    const error = await failed(installer().install({ desktopIcons: true, customDir: null }))
    expect(error).toEqual({ code: 'INSTALL_ELEVATION_DENIED' })
    expect(installed).toEqual([])
    expect(worldsChanged).toBe(0)
  })

  it('maps a failed setup to INSTALL_FAILED with its exit code and its log', async () => {
    setupExit = 4
    const exec = core.ctx.exec
    core.ctx.exec = async (cmd, args, opts) => {
      // Inno writes its log where /LOG says before it fails.
      const log = /\/LOG="([^"]+)"/.exec(scriptOf(args))?.[1]?.replaceAll("''", "'")
      if (log) writeFileSync(log, 'Fatal error during install')
      return exec(cmd, args, opts)
    }

    const error = await failed(installer().install({ desktopIcons: true, customDir: null }))

    expect(error).toMatchObject({
      code: 'INSTALL_FAILED',
      params: { exitCode: 4, reason: 'Fatal error during install' },
    })
    expect(error.logPath).toMatch(/ap-setup-.+\.log$/)
    expect(readFileSync(error.logPath ?? '', 'utf8')).toBe('Fatal error during install')
    expect(installed).toEqual([])
  })

  it('fails with AP_NOT_INSTALLED when the installer leaves nothing to detect', async () => {
    core.ctx.exec = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    const error = await failed(installer().install({ desktopIcons: true, customDir: null }))
    expect(error.code).toBe('AP_NOT_INSTALLED')
    expect(installed).toEqual([])
  })

  it('reuses a verified download instead of fetching it again', async () => {
    const installer1 = installer()
    await succeeded(installer1.install({ desktopIcons: true, customDir: null }))
    await succeeded(installer1.install({ desktopIcons: true, customDir: null }))
    expect(requestsFor(SETUP_NAME)).toBe(1)
    expect(scripts).toHaveLength(2)
  })

  it('runs one install at a time', async () => {
    const installer1 = installer()
    let running = 0
    let overlap = false
    const exec = core.ctx.exec
    core.ctx.exec = async (cmd, args, opts) => {
      running++
      if (running > 1) overlap = true
      await new Promise((resolve) => setTimeout(resolve, 50))
      running--
      return exec(cmd, args, opts)
    }
    const refs = [
      installer1.install({ desktopIcons: true, customDir: null }),
      installer1.install({ desktopIcons: false, customDir: null }),
    ]
    for (const ref of refs) await succeeded(ref)
    expect(overlap).toBe(false)
    expect(scripts).toHaveLength(2)
  })

  it('uninstalls with the official uninstaller, then forgets the install', async () => {
    await existingInstall()
    write(join(ap, 'unins000.exe'), 'uninstaller')
    core.ctx.exec = (cmd, args) => {
      scripts.push(scriptOf(args))
      rmSync(join(ap, 'unins000.exe'))
      rmSync(join(ap, apExeFileName('ArchipelagoLauncher', 'win32')))
      detected = null
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }

    const ref = installer().uninstall({ purgeUserData: true })

    expect(await succeeded(ref)).toBeNull()
    expect(scripts[0]).toContain(`$psi.FileName = ${psQuote(join(ap, 'unins000.exe'))};`)
    expect(existsSync(join(ap, 'host.yaml'))).toBe(false)
    expect(existsSync(join(ap, 'custom_worlds'))).toBe(false)
    expect(backups()).toHaveLength(1)
    expect(order.slice(-2)).toEqual(['invalidate', 'worlds:changed'])
    expect(installed).toEqual([])
  })

  it('refuses to uninstall while Archipelago runs', async () => {
    await existingInstall()
    write(join(ap, 'unins000.exe'), 'uninstaller')
    processes = [[{ pid: 1, name: 'ArchipelagoServer.exe' }]]
    const error = await failed(installer().uninstall({ purgeUserData: true }))
    expect(error.code).toBe('AP_RUNNING')
    expect(scripts).toEqual([])
    expect(existsSync(join(ap, 'host.yaml'))).toBe(true)
  })

  it('refuses to uninstall a folder picked by hand, and fails without any install', async () => {
    detected = { ...windowsInstall(ap, '0.6.8'), kind: 'custom' }
    const custom = await failed(installer().uninstall({ purgeUserData: true }))
    expect(custom.code).toBe('INVALID_INPUT')
    detected = null
    const none = await failed(installer().uninstall({ purgeUserData: false }))
    expect(none.code).toBe('AP_NOT_INSTALLED')
    expect(scripts).toEqual([])
  })
})

describe('install on Linux', () => {
  beforeEach(() => {
    setup('linux')
    core.ctx.exec = (cmd) =>
      cmd === 'ldd'
        ? Promise.resolve({ code: 0, stdout: 'ldd (GNU libc) 2.39\n', stderr: '' })
        : Promise.reject(new Error(`unexpected program: ${cmd}`))
  })

  it('installs the managed copy and announces it', async () => {
    const locator = createLocator(core.ctx)
    const ref = service(locator).install({ desktopIcons: true, customDir: null })
    const result = (await succeeded(ref)) as ApInstall

    expect(result).toMatchObject({
      kind: 'linux-managed',
      version: '0.6.8',
      root: posix.join(dataRoot(), 'archipelago', 'Archipelago'),
    })
    // No hidden settings step to block on Linux: there is no quarantine.
    expect(stages.get(ref.taskId)).toEqual(['init', 'download', 'verify', 'backup', 'install', 'detect'])
    expect(installed).toEqual([result])
    expect(worldsChanged).toBe(1)
    expect(core.ctx.config.get().apPathOverride).toBeNull()
  })

  it('installs into a customDir and points detection at the extracted Archipelago folder', async () => {
    const customDir = join(root, 'Jeux é')
    const locator = createLocator(core.ctx)
    const result = (await succeeded(service(locator).install({ desktopIcons: true, customDir }))) as ApInstall

    const extracted = posix.normalize(join(customDir, 'Archipelago'))
    expect(core.ctx.config.get().apPathOverride).toBe(extracted)
    expect(result).toMatchObject({ kind: 'custom', root: extracted, version: '0.6.8' })
    expect(existsSync(join(customDir, 'Archipelago', 'ArchipelagoLauncher'))).toBe(true)
    expect(installed).toEqual([result])
  })

  it('uninstalls the managed copy and keeps the user data', async () => {
    const locator = createLocator(core.ctx)
    const installer = service(locator)
    await succeeded(installer.install({ desktopIcons: true, customDir: null }))
    const apDir = join(dataRoot(), 'archipelago', 'Archipelago')
    write(join(apDir, 'Players', 'Ann.yaml'), 'name: Ann')

    expect(await succeeded(installer.uninstall({ purgeUserData: false }))).toBeNull()

    expect(readdirSync(apDir)).toEqual(['Players'])
    expect(await locator.detect()).toBeNull()
    expect(worldsChanged).toBe(2)
  })
})

describe('ap install handlers', () => {
  it('serve the installer service', async () => {
    setup(hostOs)
    const ap = join(root, 'AP')
    write(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), '')
    write(join(ap, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    core.ctx.config.updateInternal({ apPathOverride: ap })
    // No real process list: none runs.
    const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    core.ctx.exec = exec

    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const call = async <T>(name: string, input?: unknown): Promise<T> => {
      const result = await ipc.dispatch(name, input, { senderId: 1 })
      if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
      return result.value as T
    }

    const release = await call<ApRelease>('ap:latestRelease', {})
    expect(release.version).toBe('0.6.8')
    await call('ap:latestRelease', { force: true })
    expect(server.requests.filter((r) => r.url === LATEST_PATH)).toHaveLength(2)

    // A relative folder is refused by the task, before anything runs.
    const install = await call<TaskRef>('ap:install', { desktopIcons: true, customDir: 'relative' })
    expect((await failed(install)).code).toBe('PATH_FORBIDDEN')

    // A folder picked by hand is never uninstalled by the app.
    const uninstall = await call<TaskRef>('ap:uninstall', { purgeUserData: false })
    expect((await failed(uninstall)).code).toBe('INVALID_INPUT')
    expect(existsSync(join(ap, 'manifest.json'))).toBe(true)
  })
})
