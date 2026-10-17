import { createHash } from 'node:crypto'
import {
  createWriteStream,
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
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { gzipSync } from 'node:zlib'
import { Header } from 'tar'
import { parse } from 'yaml'
import { ZipFile } from 'yazl'
import { resolveApPaths, type Locator } from '@main/core/ap/locator'
import { createApSettings, SETTINGS_KEYS, type ApSettings, type SettingsEntry } from '@main/core/ap/settings'
import type { CoreContext, Http } from '@main/core/context'
import type { ExecFn, ExecResult } from '@main/core/exec'
import {
  checkPrereqsLinux,
  checkPrereqsWindows,
  createBizhawk,
  linuxInstallHint,
  type Bizhawk,
} from '@main/core/play/bizhawk'
import { createHttp } from '@main/core/system/http'
import type { TaskHandle } from '@main/core/tasks'
import { registerHandlers } from '@main/ipc'
import registerBizhawkHandlers from '@main/ipc/bizhawk'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import type { ServiceContainer } from '@main/services/registry'
// The `bizhawk` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/bizhawk.service'
import { BIZHAWK_ASSETS, BIZHAWK_TAG } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { ApInstall, BizhawkState, OS, TaskDone } from '@shared/types'
import { createTestContext, hostOs, silentLogger, type TestCore } from '../../helpers/core'
import { fetchVia, reply, startTestServer, type TestServer } from '../../helpers/http-server'

// The removal of an old install can be made to fail, as it does on Windows for a folder in use.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const LAUNCHER: Record<OS, string> = { win32: 'EmuHawk.exe', linux: 'EmuHawkMono.sh' }
const VC_URL = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'
const VC_KEY = 'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
const VC_OK = '{"Installed":"1","Major":"14","Minor":"38","Version":"v14.38.33135"}'
const RELEASE_PATH = `/repos/TASEmulators/BizHawk/releases/tags/${BIZHAWK_TAG}`
const DOWNLOAD_DIR = `/TASEmulators/BizHawk/releases/download/${BIZHAWK_TAG}`

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n'
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=41\n'
const ARCH = 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n'

let root: string
let server: TestServer

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'goat bizhawk é-'))
  server = await startTestServer((_req, res) => reply(res, 404, 'nope'))
})

afterEach(async () => {
  vi.mocked(rm).mockReset() // back to the real rm, and no call history
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

// --- fakes --------------------------------------------------------------------------------------

interface Call {
  cmd: string
  args: string[]
  /** The decoded script of a powershell.exe call, '' for anything else. */
  script: string
}

type FakeExec = ExecFn & { calls: Call[] }
type Answer = Partial<ExecResult> | Error | undefined

/** The script a powershell.exe call ran, decoded from its -EncodedCommand. */
const scriptOf = (cmd: string, args: string[]): string =>
  cmd === 'powershell.exe' ? Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le') : ''

/** An exec that answers from `answer` and refuses (like a missing program) what it does not know. */
function fakeExec(answer: (call: Call) => Answer): FakeExec {
  const calls: Call[] = []
  const fn: ExecFn = (cmd, args) => {
    const call: Call = { cmd, args, script: scriptOf(cmd, args) }
    calls.push(call)
    const result = answer(call)
    if (result instanceof Error) return Promise.reject(result)
    if (result === undefined) return Promise.reject(missing(cmd))
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...result })
  }
  return Object.assign(fn, { calls })
}

const missing = (cmd: string): Error => Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })

const LDCONFIG_OK = [
  '1234 libs found in cache `/etc/ld.so.cache`',
  '\tlibopenal.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libopenal.so.1',
  '\tlibz.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libz.so.1',
].join('\n')

interface WindowsExecOptions {
  /** What the VC++ registry key prints; 'null' is a key that does not exist. */
  vc?: string | Error
  /** What `ProductVersion` prints. */
  version?: string | Error
}

/** Windows: the VC++ runtime key, the version of EmuHawk.exe, and no Archipelago program running. */
function windowsExec(opts: WindowsExecOptions = {}): FakeExec {
  return fakeExec(({ cmd, script }) => {
    if (cmd === 'tasklist') return { stdout: '' }
    if (script.includes('OpenBaseKey')) {
      const vc = opts.vc ?? VC_OK
      return vc instanceof Error ? vc : { stdout: `${vc}\r\n` }
    }
    if (script.includes('VersionInfo')) {
      const version = opts.version ?? '2.11.1.0'
      return version instanceof Error ? version : { stdout: `${version}\r\n` }
    }
    return undefined
  })
}

interface LinuxExecOptions {
  /** Programs that are not installed. */
  absent?: string[]
  /** What `ldconfig -p` prints. */
  ldconfig?: string
}

/** Linux: every program is installed unless `absent` says so; `ldconfig` is on the PATH. */
function linuxExec(opts: LinuxExecOptions = {}): FakeExec {
  return fakeExec(({ cmd, args }) => {
    if (cmd === 'ps') return { stdout: '' }
    if (opts.absent?.includes(cmd)) return undefined
    if (cmd === 'ldconfig' && args[0] === '-p') return { stdout: opts.ldconfig ?? LDCONFIG_OK }
    if (['mono', 'lua5.4', 'lsb_release'].includes(cmd)) return { stdout: 'ok\n' }
    return undefined
  })
}

const execFor = (os: OS): FakeExec => (os === 'win32' ? windowsExec() : linuxExec())

interface StubSettings extends Pick<ApSettings, 'get' | 'set'> {
  values: Map<string, unknown>
  sets: (readonly SettingsEntry[])[]
  /** Makes `get` and `set` fail. */
  fail(error: Error | null): void
}

/** An in-memory settings file: `get` reads it, `set` records the write and applies it. */
function stubSettings(initial: Record<string, unknown> = {}): StubSettings {
  const values = new Map<string, unknown>(Object.entries(initial))
  const sets: (readonly SettingsEntry[])[] = []
  let error: Error | null = null
  return {
    values,
    sets,
    fail: (next) => {
      error = next
    },
    get: (path) => (error ? Promise.reject(error) : Promise.resolve(values.get(path.join('.')))),
    set: (entries) => {
      if (error) return Promise.reject(error)
      sets.push(entries)
      for (const { path, value } of entries) values.set(path.join('.'), value)
      return Promise.resolve()
    },
  }
}

const EMUHAWK_KEY = SETTINGS_KEYS.emuhawkPath.join('.')
const ROM_START_KEY = SETTINGS_KEYS.romStart.join('.')

interface Setup {
  core: TestCore
  ctx: CoreContext
  bizhawk: Bizhawk
  settings: StubSettings
  exec: FakeExec
}

interface SetupOptions {
  exec?: FakeExec
  settings?: StubSettings
  http?: Http
  osRelease?: string
}

/** A Bizhawk for `os` (the files are real, the programs and the registry are fake). */
function setup(os: OS, opts: SetupOptions = {}): Setup {
  const core = createTestContext(root, { os })
  const exec = opts.exec ?? execFor(os)
  const ctx: CoreContext = { ...core.ctx, exec, http: opts.http ?? core.ctx.http }
  const settings = opts.settings ?? stubSettings()
  const bizhawk = createBizhawk(ctx, {
    settings,
    readOsRelease: () => Promise.resolve(opts.osRelease ?? UBUNTU),
  })
  return { core, ctx, bizhawk, settings, exec }
}

const dataRoot = (): string => join(root, 'dataRoot')
const managedDir = (): string => join(dataRoot(), 'emulators', `bizhawk-${BIZHAWK_TAG}`)
const storedFile = (): string => join(root, 'userData', 'bizhawk.json')

/** A BizHawk folder: the launcher of `os`, and the marker of an install the app made. */
function makeFolder(dir: string, os: OS, opts: { marker?: boolean } = {}): string {
  mkdirSync(join(dir, 'dll'), { recursive: true })
  writeFileSync(join(dir, LAUNCHER[os]), 'launcher')
  writeFileSync(join(dir, 'dll', 'lib.dll'), 'x')
  if (opts.marker) writeFileSync(join(dir, '.goat-version'), `${BIZHAWK_TAG}\n`)
  return dir
}

const makeManaged = (os: OS): string => makeFolder(managedDir(), os, { marker: true })
const makeExternal = (os: OS, name = 'BizHawk 2.9'): string => makeFolder(join(root, 'Émulateurs', name), os)

function task(signal: AbortSignal = new AbortController().signal): TaskHandle & {
  progress: ReturnType<typeof vi.fn<TaskHandle['progress']>>
} {
  return {
    id: 'task-1',
    signal,
    progress: vi.fn<TaskHandle['progress']>(),
    log: vi.fn<TaskHandle['log']>(),
  }
}

// --- prerequisites ------------------------------------------------------------------------------

describe('checkPrereqsWindows', () => {
  it('checkPrereqsWindows reads the VC++ runtime Version via readRegistryValues', async () => {
    const exec = windowsExec()
    expect(await checkPrereqsWindows(exec)).toEqual([{ name: 'vc_redist.x64', ok: true, hint: null }])

    expect(exec.calls).toHaveLength(1)
    expect(exec.calls[0]?.cmd).toBe('powershell.exe')
    // The 64-bit view of HKLM, whatever the bitness of the app.
    expect(exec.calls[0]?.script).toContain('[Microsoft.Win32.RegistryView]::Registry64')
    expect(exec.calls[0]?.script).toContain('[Microsoft.Win32.RegistryHive]::LocalMachine')
    expect(exec.calls[0]?.script).toContain(`.OpenSubKey('${VC_KEY}')`)
  })

  it.each([
    ['a missing key', 'null'],
    ['a key without a Version', '{"Installed":"1"}'],
    ['an empty Version', '{"Installed":"1","Version":""}'],
    ['a runtime that was uninstalled', '{"Installed":"0","Version":"v14.38.33135"}'],
  ])('reports %s as missing, with the official page as the hint', async (_name, vc) => {
    expect(await checkPrereqsWindows(windowsExec({ vc }))).toEqual([
      { name: 'vc_redist.x64', ok: false, hint: VC_URL },
    ])
  })

  it('reports a registry that cannot be read as missing too', async () => {
    const exec = windowsExec({ vc: new Error('powershell.exe failed') })
    expect(await checkPrereqsWindows(exec)).toEqual([{ name: 'vc_redist.x64', ok: false, hint: VC_URL }])
  })
})

describe('checkPrereqsLinux', () => {
  const names = (prereqs: { name: string; ok: boolean }[]): [string, boolean][] =>
    prereqs.map((p) => [p.name, p.ok])

  it('finds mono, lua5.4, lsb_release and libopenal (through ldconfig -p)', async () => {
    const exec = linuxExec()
    const prereqs = await checkPrereqsLinux(exec)
    expect(names(prereqs)).toEqual([
      ['mono', true],
      ['lua5.4', true],
      ['lsb_release', true],
      ['libopenal', true],
    ])
    expect(prereqs.every((p) => p.hint === null)).toBe(true)
    expect(exec.calls.find((c) => c.cmd === 'ldconfig')?.args).toEqual(['-p'])
  })

  it('reports each program that cannot start as missing', async () => {
    const prereqs = await checkPrereqsLinux(linuxExec({ absent: ['mono', 'lsb_release'] }))
    expect(names(prereqs)).toEqual([
      ['mono', false],
      ['lua5.4', true],
      ['lsb_release', false],
      ['libopenal', true],
    ])
  })

  it('reports libopenal as missing when the cache does not list it for x86-64', async () => {
    const only32 =
      '\tlibopenal.so.1 (libc6) => /usr/lib32/libopenal.so.1\n\tlibopenal.so (libc6,x86-64) => /x'
    expect(names(await checkPrereqsLinux(linuxExec({ ldconfig: only32 })))[3]).toEqual(['libopenal', false])
    expect(names(await checkPrereqsLinux(linuxExec({ ldconfig: '' })))[3]).toEqual(['libopenal', false])
  })

  it('asks /sbin/ldconfig when ldconfig is not on the PATH (Debian, for a regular user)', async () => {
    const exec = fakeExec(({ cmd, args }) => {
      if (cmd === '/sbin/ldconfig' && args[0] === '-p') return { stdout: LDCONFIG_OK }
      if (['mono', 'lua5.4', 'lsb_release'].includes(cmd)) return {}
      return undefined
    })
    expect(names(await checkPrereqsLinux(exec))[3]).toEqual(['libopenal', true])
  })

  it('reports libopenal as missing when no ldconfig can run', async () => {
    const exec = linuxExec({ absent: ['ldconfig'] })
    expect(names(await checkPrereqsLinux(exec))[3]).toEqual(['libopenal', false])
  })
})

describe('linuxInstallHint', () => {
  const ALL = ['mono', 'lua5.4', 'lsb_release', 'libopenal']

  it('linux hint uses apt on ubuntu, dnf on fedora, pacman on arch', () => {
    expect(linuxInstallHint(UBUNTU, ALL)).toBe('sudo apt install mono-complete lua5.4 lsb-release libopenal1')
    expect(linuxInstallHint(FEDORA, ALL)).toBe(
      'sudo dnf install mono-complete lua /usr/bin/lsb_release openal-soft',
    )
    expect(linuxInstallHint(ARCH, ALL)).toBe('sudo pacman -S mono lua lsb-release openal')
  })

  it('names only the missing prerequisites, in a fixed order, once each', () => {
    expect(linuxInstallHint(UBUNTU, ['libopenal', 'mono', 'mono'])).toBe(
      'sudo apt install mono-complete libopenal1',
    )
    expect(linuxInstallHint(UBUNTU, ['lua5.4'])).toBe('sudo apt install lua5.4')
  })

  it.each([
    ['Linux Mint', 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\n', 'apt'],
    ['Debian', 'ID=debian\n', 'apt'],
    ['Pop!_OS', 'ID=pop\nID_LIKE="ubuntu debian"\n', 'apt'],
    ['Rocky', 'ID="rocky"\nID_LIKE="rhel centos fedora"\n', 'dnf'],
    ['Nobara', "ID='nobara'\nID_LIKE='rhel centos fedora'\n", 'dnf'],
    ['Manjaro', 'ID=manjaro\nID_LIKE=arch\n', 'pacman'],
    ['EndeavourOS', 'ID=endeavouros\nID_LIKE=arch\n', 'pacman'],
    ['a file with Windows line endings', 'ID=fedora\r\nVERSION_ID=41\r\n', 'dnf'],
  ])('knows %s by ID or ID_LIKE', (_name, osRelease, manager) => {
    expect(linuxInstallHint(osRelease, ['mono'])).toContain(`sudo ${manager} `)
  })

  it('gives no command for a distribution it does not know, or nothing to install', () => {
    expect(linuxInstallHint('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n', ALL)).toBe('')
    expect(linuxInstallHint('', ALL)).toBe('')
    expect(linuxInstallHint('ID=constructor\n', ALL)).toBe('')
    expect(linuxInstallHint(UBUNTU, [])).toBe('')
    expect(linuxInstallHint(UBUNTU, ['bizhawk-version', 'vc_redist.x64'])).toBe('')
  })
})

// --- state --------------------------------------------------------------------------------------

describe('state', () => {
  const NOTHING: Omit<BizhawkState, 'prereqs'> = {
    installed: false,
    managed: false,
    version: null,
    path: null,
    configuredInAp: false,
  }

  it('says that nothing is installed, with the prerequisites of the platform', async () => {
    const { bizhawk } = setup('win32')
    expect(await bizhawk.state()).toEqual({
      ...NOTHING,
      prereqs: [{ name: 'vc_redist.x64', ok: true, hint: null }],
    })
  })

  it('state adopts an existing emuhawk_path from AP settings (2.7 ≤ version ≤ 2.11 accepted, else warning)', async () => {
    const dir = makeExternal('win32')
    const exe = join(dir, 'EmuHawk.exe')
    const accepted = async (version: string): Promise<boolean | undefined> => {
      const settings = stubSettings({ [EMUHAWK_KEY]: exe, [ROM_START_KEY]: true })
      const state = await setup('win32', { exec: windowsExec({ version }), settings }).bizhawk.state()
      expect(state).toMatchObject({ installed: true, managed: false, path: dir, configuredInAp: true })
      return state.prereqs.find((p) => p.name === 'bizhawk-version')?.ok
    }

    expect(await accepted('2.7.0.0')).toBe(true)
    expect(await accepted('2.9.1.0')).toBe(true)
    expect(await accepted('2.11')).toBe(true)
    expect(await accepted('2.11.1.0')).toBe(true)
    expect(await accepted('2.6.3.0')).toBe(false)
    expect(await accepted('2.12.0.0')).toBe(false)
    expect(await accepted('3.0.0.0')).toBe(false)
    expect(await accepted('2.1.0+abcdef')).toBe(false)
  })

  it('flags an adopted install whose version is out of range with a warning that has no hint', async () => {
    const dir = makeExternal('win32')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk.exe'), [ROM_START_KEY]: true })
    const { bizhawk } = setup('win32', { exec: windowsExec({ version: '2.6.3.0' }), settings })
    expect(await bizhawk.state()).toEqual({
      installed: true,
      managed: false,
      version: '2.6.3',
      path: dir,
      configuredInAp: true,
      prereqs: [
        { name: 'vc_redist.x64', ok: true, hint: null },
        { name: 'bizhawk-version', ok: false, hint: null },
      ],
    })
  })

  it.each([
    ['2.11.1.0', '2.11.1'],
    ['2.10.0.0', '2.10'],
    ['2.9.1', '2.9.1'],
    ['2.10.0+b8a07a3', '2.10'],
  ])('reads the Windows version %s as %s', async (printed, version) => {
    const dir = makeExternal('win32')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk.exe') })
    const state = await setup('win32', { exec: windowsExec({ version: printed }), settings }).bizhawk.state()
    expect(state.version).toBe(version)
  })

  it('reads the version of EmuHawk.exe with (Get-Item …).VersionInfo.ProductVersion, the path quoted', async () => {
    const dir = makeExternal('win32', "BizHawk d'été")
    const exe = join(dir, 'EmuHawk.exe')
    const exec = windowsExec()
    await setup('win32', { exec, settings: stubSettings({ [EMUHAWK_KEY]: exe }) }).bizhawk.state()

    const script = exec.calls.find((c) => c.script.includes('VersionInfo'))?.script ?? ''
    expect(script).toContain('.VersionInfo.ProductVersion')
    expect(script).toContain(`-LiteralPath '${exe.replaceAll("'", "''")}'`)
  })

  it('does not run PowerShell again for a file it already read the version of', async () => {
    const dir = makeExternal('win32')
    const exec = windowsExec()
    const { bizhawk } = setup('win32', {
      exec,
      settings: stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk.exe') }),
    })
    await bizhawk.state()
    await bizhawk.state()
    expect(exec.calls.filter((c) => c.script.includes('VersionInfo'))).toHaveLength(1)

    // A new EmuHawk.exe (another size) is read again.
    writeFileSync(join(dir, 'EmuHawk.exe'), 'a much longer launcher than before')
    await bizhawk.state()
    expect(exec.calls.filter((c) => c.script.includes('VersionInfo'))).toHaveLength(2)
  })

  it('accepts a version it cannot read, with a warning', async () => {
    const dir = makeExternal('win32')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk.exe') })
    for (const version of [new Error('powershell.exe failed'), '']) {
      const { bizhawk } = setup('win32', { exec: windowsExec({ version }), settings })
      const state = await bizhawk.state()
      expect(state).toMatchObject({ installed: true, version: null })
      expect(state.prereqs.find((p) => p.name === 'bizhawk-version')).toEqual({
        name: 'bizhawk-version',
        ok: false,
        hint: null,
      })
    }
  })

  it('knows no version under Linux (accepted with a warning) and never starts PowerShell', async () => {
    const dir = makeExternal('linux')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawkMono.sh'), [ROM_START_KEY]: true })
    const { bizhawk, exec } = setup('linux', { settings })
    const state = await bizhawk.state()
    expect(state).toMatchObject({
      installed: true,
      managed: false,
      version: null,
      path: dir,
      configuredInAp: true,
    })
    expect(state.prereqs.at(-1)).toEqual({ name: 'bizhawk-version', ok: false, hint: null })
    expect(exec.calls.some((c) => c.cmd === 'powershell.exe')).toBe(false)
  })

  it('appends .exe to the emuhawk_path of Windows, as Archipelago does', async () => {
    const dir = makeExternal('win32')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk'), [ROM_START_KEY]: true })
    expect(await setup('win32', { settings }).bizhawk.state()).toMatchObject({
      installed: true,
      path: dir,
      configuredInAp: true,
    })
  })

  it('ignores an emuhawk_path that is relative, empty, or that holds no EmuHawk', async () => {
    makeExternal('win32')
    const empty = join(root, 'Vide')
    mkdirSync(empty)
    for (const value of ['EmuHawk.exe', '', '   ', null, 42, join(empty, 'EmuHawk.exe')]) {
      const { bizhawk } = setup('win32', { settings: stubSettings({ [EMUHAWK_KEY]: value }) })
      expect(await bizhawk.state()).toMatchObject(NOTHING)
    }
  })

  it.each([
    ['rom_start is true', true, true],
    ['rom_start is missing (the default is true)', undefined, true],
    ['rom_start is false', false, false],
    ['rom_start is a command of the user', 'C:\\Outils\\lanceur.bat', false],
  ])('is configured in AP when %s: %s', async (_name, romStart, configured) => {
    const dir = makeExternal('win32')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk.exe'), [ROM_START_KEY]: romStart })
    expect((await setup('win32', { settings }).bizhawk.state()).configuredInAp).toBe(configured)
  })

  it.skipIf(process.platform !== 'win32')(
    'compares the paths without regard to case or slashes under Windows',
    async () => {
      const dir = makeManaged('win32')
      const spelled = join(dir, 'EmuHawk.exe').toUpperCase().replaceAll('\\', '/')
      const settings = stubSettings({ [EMUHAWK_KEY]: spelled, [ROM_START_KEY]: true })
      expect((await setup('win32', { settings }).bizhawk.state()).configuredInAp).toBe(true)
    },
  )

  it('compares the paths exactly under Linux', async () => {
    const dir = makeManaged('linux')
    const wrongCase = join(dir, 'EmuHawkMono.sh').replace('EmuHawkMono', 'EMUHAWKMONO')
    const settings = stubSettings({ [EMUHAWK_KEY]: wrongCase, [ROM_START_KEY]: true })
    expect((await setup('linux', { settings }).bizhawk.state()).configuredInAp).toBe(false)
  })

  it('adopts the folder of an emuhawk_path that names the wrong launcher, as not configured', async () => {
    // Under Linux the path must be EmuHawkMono.sh: EmuHawk.exe next to it is a mistake to fix.
    const dir = makeExternal('linux')
    writeFileSync(join(dir, 'EmuHawk.exe'), 'x')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawk.exe'), [ROM_START_KEY]: true })
    expect(await setup('linux', { settings }).bizhawk.state()).toMatchObject({
      installed: true,
      path: dir,
      configuredInAp: false,
    })
  })

  it('presents the install of the app as managed, with its version from .goat-version', async () => {
    const dir = makeManaged('win32')
    const { bizhawk } = setup('win32')
    expect(await bizhawk.state()).toEqual({
      installed: true,
      managed: true,
      version: BIZHAWK_TAG,
      path: dir,
      configuredInAp: false,
      prereqs: [
        { name: 'vc_redist.x64', ok: true, hint: null },
        { name: 'bizhawk-version', ok: true, hint: null },
      ],
    })
  })

  it('is configured in AP once emuhawk_path is its launcher', async () => {
    const dir = makeManaged('linux')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, 'EmuHawkMono.sh'), [ROM_START_KEY]: true })
    expect(await setup('linux', { settings }).bizhawk.state()).toMatchObject({
      managed: true,
      version: BIZHAWK_TAG,
      configuredInAp: true,
    })
  })

  it('does not count a folder without .goat-version as an install of the app (half-installed)', async () => {
    makeFolder(managedDir(), 'win32')
    expect(await setup('win32').bizhawk.state()).toMatchObject(NOTHING)
  })

  it('prefers its own install to the one Archipelago points to', async () => {
    const managed = makeManaged('win32')
    const external = makeExternal('win32')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(external, 'EmuHawk.exe'), [ROM_START_KEY]: true })
    expect(await setup('win32', { settings }).bizhawk.state()).toMatchObject({
      managed: true,
      path: managed,
      configuredInAp: false,
    })
  })

  it('still answers when Archipelago is not installed or its settings cannot be read', async () => {
    const managed = makeManaged('win32')
    const settings = stubSettings()
    const { bizhawk } = setup('win32', { settings })
    for (const error of [
      new AppError('AP_NOT_INSTALLED'),
      new AppError('YAML_PARSE', { file: 'host.yaml' }),
    ]) {
      settings.fail(error)
      expect(await bizhawk.state()).toMatchObject({ installed: true, path: managed, configuredInAp: false })
    }
  })

  describe('under Linux', () => {
    it('gives one command for every missing prerequisite, for the distribution it runs on', async () => {
      const exec = linuxExec({ absent: ['mono', 'lua5.4'] })
      const state = await setup('linux', { exec, osRelease: FEDORA }).bizhawk.state()
      const command = 'sudo dnf install mono-complete lua'
      expect(state.prereqs).toEqual([
        { name: 'mono', ok: false, hint: command },
        { name: 'lua5.4', ok: false, hint: command },
        { name: 'lsb_release', ok: true, hint: null },
        { name: 'libopenal', ok: true, hint: null },
      ])
    })

    it('gives no hint when everything is there, or when the distribution is unknown', async () => {
      const ready = await setup('linux').bizhawk.state()
      expect(ready.prereqs.every((p) => p.ok && p.hint === null)).toBe(true)

      const exec = linuxExec({ absent: ['mono'] })
      const unknown = await setup('linux', { exec, osRelease: 'ID=gentoo\n' }).bizhawk.state()
      expect(unknown.prereqs[0]).toEqual({ name: 'mono', ok: false, hint: null })
    })
  })
})

// --- install ------------------------------------------------------------------------------------

/** Not compressible: a wrong byte changes the hash. */
const filler = (size: number): Buffer =>
  Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251))

async function makeZip(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const zip = new ZipFile()
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(Buffer.from(data), name)
  zip.end()
  const file = join(root, `fixture-${Math.random().toString(16).slice(2)}.zip`)
  await pipeline(zip.outputStream, createWriteStream(file))
  return readFileSync(file)
}

/** A .tar.gz with the mode of each file as given (the launcher is not executable in this one). */
function makeTarGz(entries: Record<string, { data: Buffer | string; mode?: number }>): Buffer {
  const parts: Buffer[] = []
  for (const [path, { data, mode }] of Object.entries(entries)) {
    const body = Buffer.from(data)
    const block = Buffer.alloc(512)
    new Header({ path, type: 'File', mode: mode ?? 0o644, size: body.length, mtime: new Date(0) }).encode(
      block,
      0,
    )
    parts.push(block, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

async function archiveFor(os: OS): Promise<Buffer> {
  if (os === 'win32') {
    return makeZip({ 'EmuHawk.exe': 'MZ launcher', 'dll/libfoo.dll': filler(50_000) })
  }
  return makeTarGz({
    'EmuHawkMono.sh': { data: '#!/bin/sh\nmono EmuHawk.exe "$@"\n' },
    'EmuHawk.exe': { data: 'MZ launcher' },
    'dll/libfoo.so': { data: filler(50_000), mode: 0o755 },
  })
}

interface ServeOptions {
  /** The digest the API announces. Default: the real one; null for an asset without a digest. */
  digest?: string | null
  /** The size the API announces. Default: the real one. */
  size?: number
  /** The asset name. Default: the pinned asset of `os`. */
  name?: string
  /** What the download serves, when it is not the archive. */
  body?: Buffer
}

/** Serves the release of the pinned tag and its archive from the local server. */
function serveRelease(os: OS, archive: Buffer, opts: ServeOptions = {}): void {
  const name = opts.name ?? BIZHAWK_ASSETS[os]
  const digest = opts.digest === undefined ? sha256(archive) : opts.digest
  const release = {
    tag_name: BIZHAWK_TAG,
    assets: [
      {
        name: 'notes.txt',
        browser_download_url: `https://github.com/TASEmulators/BizHawk/releases/download/${BIZHAWK_TAG}/notes.txt`,
        size: 3,
      },
      {
        name,
        browser_download_url: `https://github.com/TASEmulators/BizHawk/releases/download/${BIZHAWK_TAG}/${name}`,
        size: opts.size ?? archive.length,
        digest: digest === null ? null : `sha256:${digest}`,
      },
    ],
  }
  server.handle((req, res) => {
    if (req.url === RELEASE_PATH) return reply(res, 200, JSON.stringify(release))
    if (req.url === `${DOWNLOAD_DIR}/${encodeURIComponent(name)}`)
      return reply(res, 200, opts.body ?? archive)
    reply(res, 404, 'nope')
  })
}

const makeHttp = (): Http =>
  createHttp({
    userAgent: 'Test/1.0 (unit)',
    cacheDir: join(root, 'catalog'),
    log: silentLogger,
    githubToken: () => null,
    fetch: fetchVia(server, 'api.github.com', 'github.com'),
  })

const requestedPaths = (): string[] => server.requests.map((r) => r.url)

const tree = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort()

describe.each<OS>(['win32', 'linux'])('install (%s)', (os) => {
  it('install downloads pinned asset, verifies digest, extracts and writes .goat-version', async () => {
    const archive = await archiveFor(os)
    serveRelease(os, archive)
    const { bizhawk } = setup(os, { http: makeHttp() })
    const handle = task()

    const state = await bizhawk.install(handle)

    // The release of the pinned tag, then the asset of the platform: nothing else.
    expect(requestedPaths()).toEqual([RELEASE_PATH, `${DOWNLOAD_DIR}/${BIZHAWK_ASSETS[os]}`])
    expect(existsSync(join(managedDir(), LAUNCHER[os]))).toBe(true)
    expect(existsSync(join(managedDir(), 'dll', os === 'win32' ? 'libfoo.dll' : 'libfoo.so'))).toBe(true)
    expect(readFileSync(join(managedDir(), '.goat-version'), 'utf8').trim()).toBe(BIZHAWK_TAG)
    expect(state).toMatchObject({
      installed: true,
      managed: true,
      version: BIZHAWK_TAG,
      path: managedDir(),
      configuredInAp: false,
    })
    // The verified archive is not kept: only the extracted install is.
    expect(existsSync(join(dataRoot(), 'downloads', 'bizhawk', BIZHAWK_ASSETS[os]))).toBe(false)
    expect(readdirSync(join(dataRoot(), 'emulators'))).toEqual([`bizhawk-${BIZHAWK_TAG}`])

    const stages = handle.progress.mock.calls.map(([stage]) => stage)
    expect(stages[0]).toBe('release')
    expect([...new Set(stages)]).toEqual(['release', 'download', 'extract'])
    expect(handle.progress.mock.calls).toContainEqual(['download', 100])
  })

  it('refuses a download whose digest is not the one of the API, and leaves nothing behind', async () => {
    const archive = await archiveFor(os)
    const tampered = Buffer.from(archive)
    tampered[tampered.length - 5] = (tampered[tampered.length - 5] ?? 0) ^ 0xff
    serveRelease(os, archive, { body: tampered })
    const { bizhawk } = setup(os, { http: makeHttp() })

    const error = await failure(bizhawk.install(task()))

    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(existsSync(managedDir())).toBe(false)
    expect(existsSync(join(dataRoot(), 'downloads', 'bizhawk'))).toBe(true)
    expect(readdirSync(join(dataRoot(), 'downloads', 'bizhawk'))).toEqual([])
  })

  it('refuses an asset the API gives no digest for, before requesting the archive', async () => {
    const archive = await archiveFor(os)
    serveRelease(os, archive, { digest: null })
    const { bizhawk } = setup(os, { http: makeHttp() })

    const error = await failure(bizhawk.install(task()))

    expect(error.code).toBe('INSTALL_FAILED')
    expect(error.params).toMatchObject({ reason: 'no-digest' })
    expect(error.detail).toBe(BIZHAWK_ASSETS[os])
    // Only the release was asked for: the archive was never requested, nothing was written.
    expect(requestedPaths()).toEqual([RELEASE_PATH])
    expect(existsSync(managedDir())).toBe(false)
    expect(existsSync(join(dataRoot(), 'downloads', 'bizhawk'))).toBe(false)
  })

  it('keeps the install it has when the API gives no digest for the asset', async () => {
    const archive = await archiveFor(os)
    serveRelease(os, archive)
    await setup(os, { http: makeHttp() }).bizhawk.install(task())

    serveRelease(os, archive, { digest: null })
    const error = await failure(setup(os, { http: makeHttp() }).bizhawk.install(task()))

    expect(error.params).toMatchObject({ reason: 'no-digest' })
    // The refusal comes before the old install is replaced.
    expect(existsSync(join(managedDir(), LAUNCHER[os]))).toBe(true)
  })

  it('refuses an archive of another size than the one of the API', async () => {
    const archive = await archiveFor(os)
    serveRelease(os, archive, { size: archive.length + 1 })

    const error = await failure(setup(os, { http: makeHttp() }).bizhawk.install(task()))

    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(error.params).toMatchObject({ expectedSize: archive.length + 1, actualSize: archive.length })
    expect(existsSync(managedDir())).toBe(false)
  })

  it('fails with NOT_FOUND when the release has no asset for this platform', async () => {
    serveRelease(os, await archiveFor(os), { name: 'BizHawk-2.11.1-other.zip' })
    const error = await failure(setup(os, { http: makeHttp() }).bizhawk.install(task()))
    expect(error.code).toBe('NOT_FOUND')
    expect(error.detail).toBe(BIZHAWK_ASSETS[os])
  })

  it('reports an archive that cannot be extracted as INSTALL_FAILED and removes what was written', async () => {
    const junk = Buffer.from('this is not an archive at all')
    serveRelease(os, junk)
    const error = await failure(setup(os, { http: makeHttp() }).bizhawk.install(task()))
    expect(error.code).toBe('INSTALL_FAILED')
    expect(error.params).toMatchObject({ reason: 'extract' })
    expect(existsSync(managedDir())).toBe(false)
  })

  it('reports an archive without the launcher as INSTALL_FAILED and removes what was written', async () => {
    const archive =
      os === 'win32'
        ? await makeZip({ 'readme.txt': 'hello' })
        : makeTarGz({ 'readme.txt': { data: 'hello' } })
    serveRelease(os, archive)
    const error = await failure(setup(os, { http: makeHttp() }).bizhawk.install(task()))
    expect(error.code).toBe('INSTALL_FAILED')
    expect(error.params).toMatchObject({ reason: 'launcher-missing' })
    expect(existsSync(managedDir())).toBe(false)
  })

  it('stops with TASK_CANCELLED, and removes what was written, when the task is cancelled', async () => {
    serveRelease(os, await archiveFor(os))
    const controller = new AbortController()
    const handle = task(controller.signal)
    // The user cancels while the archive is being extracted.
    handle.progress.mockImplementation((stage) => {
      if (stage === 'extract') controller.abort()
    })
    const { bizhawk } = setup(os, { http: makeHttp() })

    expect((await failure(bizhawk.install(handle))).code).toBe('TASK_CANCELLED')
    expect(existsSync(managedDir())).toBe(false)
    expect((await bizhawk.state()).installed).toBe(false)
  })

  it('does not even ask GitHub when the task is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { bizhawk } = setup(os, { http: makeHttp() })
    expect((await failure(bizhawk.install(task(controller.signal)))).code).toBe('TASK_CANCELLED')
    expect(server.requests).toHaveLength(0)
  })

  it('replaces an install of the same version, leaving none of its old files', async () => {
    serveRelease(os, await archiveFor(os))
    makeManaged(os)
    writeFileSync(join(managedDir(), 'old-file.txt'), 'from the previous install')
    await setup(os, { http: makeHttp() }).bizhawk.install(task())

    const files = tree(managedDir())
    expect(files).not.toContain('old-file.txt')
    expect(files).toContain('.goat-version')
    expect(files).toContain(LAUNCHER[os])
  })

  it('keeps the old install when it cannot be removed', async () => {
    serveRelease(os, await archiveFor(os))
    const dir = makeManaged(os)
    const { bizhawk } = setup(os, { http: makeHttp() })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    // The folder is in use (a running EmuHawk): everything else is removed as usual.
    vi.mocked(rm).mockImplementation((path, options) =>
      path === dir
        ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        : actual.rm(path, options),
    )

    const error = await failure(bizhawk.install(task()))

    expect(error.code).toBe('INSTALL_FAILED')
    expect(error.params).toMatchObject({ reason: 'remove-old' })
    expect(existsSync(join(dir, LAUNCHER[os]))).toBe(true)
  })

  it('runs once when two installs are asked at the same time', async () => {
    serveRelease(os, await archiveFor(os))
    const { bizhawk } = setup(os, { http: makeHttp() })
    const [first, second] = await Promise.all([bizhawk.install(task()), bizhawk.install(task())])
    expect(first).toEqual(second)
    expect(requestedPaths().filter((url) => url === RELEASE_PATH)).toHaveLength(1)

    // Once it is over, a new install is a new run.
    await bizhawk.install(task())
    expect(requestedPaths().filter((url) => url === RELEASE_PATH)).toHaveLength(2)
  })

  it('goes back to its own install when the user had chosen another BizHawk', async () => {
    serveRelease(os, await archiveFor(os))
    const external = makeExternal(os)
    const { bizhawk } = setup(os, { http: makeHttp() })
    await bizhawk.setPath(external)
    expect(await bizhawk.state()).toMatchObject({ managed: false, path: external })

    const state = await bizhawk.install(task())

    expect(state).toMatchObject({ managed: true, path: managedDir() })
    expect(existsSync(storedFile())).toBe(false)
  })
})

describe('install under Linux', () => {
  it.skipIf(process.platform === 'win32')(
    'makes the launcher executable and keeps the other modes',
    async () => {
      serveRelease('linux', await archiveFor('linux'))
      await setup('linux', { http: makeHttp() }).bizhawk.install(task())

      const launcher = statSync(join(managedDir(), 'EmuHawkMono.sh')).mode
      expect(launcher & 0o111).toBe(0o111)
      expect(statSync(join(managedDir(), 'dll', 'libfoo.so')).mode & 0o111).toBe(0o111)
      // A file the archive did not make executable stays as it was.
      expect(statSync(join(managedDir(), 'EmuHawk.exe')).mode & 0o111).toBe(0)
    },
  )

  it('installs even though prerequisites are missing: they are reported, not required', async () => {
    serveRelease('linux', await archiveFor('linux'))
    const exec = linuxExec({ absent: ['mono'] })
    const state = await setup('linux', { http: makeHttp(), exec }).bizhawk.install(task())
    expect(state.installed).toBe(true)
    expect(state.prereqs.find((p) => p.name === 'mono')).toMatchObject({ ok: false })
  })
})

// --- setPath ------------------------------------------------------------------------------------

describe.each<OS>(['win32', 'linux'])('setPath (%s)', (os) => {
  it('adopts a folder that holds the launcher, as an external install that AP does not use yet', async () => {
    const dir = makeExternal(os)
    const { bizhawk } = setup(os)
    const state = await bizhawk.setPath(dir)
    expect(state).toMatchObject({ installed: true, managed: false, path: dir, configuredInAp: false })
    expect(JSON.parse(readFileSync(storedFile(), 'utf8'))).toEqual({ path: dir })
  })

  it('setPath rejects folder without EmuHawk', async () => {
    const empty = join(root, 'Vide')
    mkdirSync(empty)
    const other = os === 'win32' ? 'EmuHawkMono.sh' : 'EmuHawk.exe'
    writeFileSync(join(empty, other), 'the launcher of the other platform')
    const { bizhawk } = setup(os)

    const error = await failure(bizhawk.setPath(empty))

    expect(error.code).toBe('NOT_FOUND')
    expect(error.params).toMatchObject({ file: LAUNCHER[os] })
    expect(existsSync(storedFile())).toBe(false)
    expect((await bizhawk.state()).installed).toBe(false)
  })

  it('goes through assertUserPath: absolute, existing, and a folder', async () => {
    const dir = makeExternal(os)
    const { bizhawk } = setup(os)
    expect((await failure(bizhawk.setPath('Émulateurs\\BizHawk'))).code).toBe('PATH_FORBIDDEN')
    expect((await failure(bizhawk.setPath(join(root, 'absent')))).code).toBe('NOT_FOUND')
    const file = join(dir, LAUNCHER[os])
    expect((await failure(bizhawk.setPath(file))).code).toBe('PATH_FORBIDDEN')
    expect(existsSync(storedFile())).toBe(false)
  })

  it('remembers the folder for the next start, until it disappears', async () => {
    const dir = makeExternal(os)
    await setup(os).bizhawk.setPath(dir)

    const restarted = setup(os).bizhawk
    expect(await restarted.state()).toMatchObject({ installed: true, managed: false, path: dir })

    rmSync(dir, { recursive: true })
    expect((await restarted.state()).installed).toBe(false)
  })

  it('prefers the folder the user chose to its own install and to the one AP points to', async () => {
    makeManaged(os)
    const chosen = makeExternal(os, 'Choisi')
    const adopted = makeExternal(os, 'Adopté')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(adopted, LAUNCHER[os]) })
    const { bizhawk } = setup(os, { settings })
    expect(await bizhawk.setPath(chosen)).toMatchObject({ managed: false, path: chosen })
  })

  it('forgets the folder with null, and with it the install it gave', async () => {
    const dir = makeExternal(os)
    const { bizhawk, settings } = setup(os)
    await bizhawk.setPath(dir)

    expect(await bizhawk.setPath(null)).toMatchObject({ installed: false, path: null })
    expect(existsSync(storedFile())).toBe(false)
    // Archipelago pointed nowhere: nothing to undo there.
    expect(settings.sets).toEqual([])
  })

  it('forgets an install that AP points to as well, or the app would adopt it again', async () => {
    const dir = makeExternal(os)
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, LAUNCHER[os]), [ROM_START_KEY]: true })
    const { bizhawk } = setup(os, { settings })
    expect(await bizhawk.state()).toMatchObject({ installed: true, path: dir })

    expect(await bizhawk.setPath(null)).toMatchObject({ installed: false, path: null, configuredInAp: false })
    expect(settings.sets).toEqual([[{ path: SETTINGS_KEYS.emuhawkPath, value: null }]])
    expect(settings.values.get(EMUHAWK_KEY)).toBeNull()
    // rom_start is the user's: left alone.
    expect(settings.values.get(ROM_START_KEY)).toBe(true)
  })

  it('leaves AP alone when it points to another BizHawk than the one that is forgotten', async () => {
    const chosen = makeExternal(os, 'Choisi')
    const other = makeExternal(os, 'Autre')
    const settings = stubSettings({ [EMUHAWK_KEY]: join(other, LAUNCHER[os]) })
    const { bizhawk } = setup(os, { settings })
    await bizhawk.setPath(chosen)

    await bizhawk.setPath(null)

    expect(settings.sets).toEqual([])
    // What AP points to is still there to be adopted.
    expect(await bizhawk.state()).toMatchObject({ installed: true, path: other })
  })

  it('does not touch AP when what it points to is the install of the app', async () => {
    const managed = makeManaged(os)
    const settings = stubSettings({ [EMUHAWK_KEY]: join(managed, LAUNCHER[os]), [ROM_START_KEY]: true })
    const { bizhawk } = setup(os, { settings })
    expect(await bizhawk.setPath(null)).toMatchObject({ managed: true, configuredInAp: true })
    expect(settings.sets).toEqual([])
  })

  it('keeps the choice when AP cannot be changed (a program runs), so that the user can try again', async () => {
    const dir = makeExternal(os)
    const settings = stubSettings({ [EMUHAWK_KEY]: join(dir, LAUNCHER[os]) })
    const { bizhawk } = setup(os, { settings })
    await bizhawk.setPath(dir)
    settings.set = () => Promise.reject(new AppError('SETTINGS_LOCKED', { processes: 'ArchipelagoLauncher' }))

    expect((await failure(bizhawk.setPath(null))).code).toBe('SETTINGS_LOCKED')
    expect(existsSync(storedFile())).toBe(true)
  })

  it('forgets without error when Archipelago is not installed', async () => {
    const dir = makeExternal(os)
    const settings = stubSettings()
    const { bizhawk } = setup(os, { settings })
    await bizhawk.setPath(dir)
    settings.fail(new AppError('AP_NOT_INSTALLED'))
    expect(await bizhawk.setPath(null)).toMatchObject({ installed: false })
  })
})

// --- configureAp --------------------------------------------------------------------------------

describe('configureAp', () => {
  it('configureAp writes EmuHawk.exe on windows and EmuHawkMono.sh on linux', async () => {
    for (const os of ['win32', 'linux'] as const) {
      const dir = makeManaged(os)
      const { bizhawk, settings } = setup(os)

      const state = await bizhawk.configureAp()

      expect(settings.sets).toEqual([
        [
          { path: SETTINGS_KEYS.emuhawkPath, value: join(dir, LAUNCHER[os]) },
          { path: SETTINGS_KEYS.romStart, value: true },
        ],
      ])
      expect(state).toMatchObject({ managed: true, path: dir, configuredInAp: true })
      rmSync(dir, { recursive: true })
    }
  })

  it('writes an absolute path', async () => {
    makeManaged('win32')
    const { bizhawk, settings } = setup('win32')
    await bizhawk.configureAp()
    const value = settings.values.get(EMUHAWK_KEY)
    expect(typeof value === 'string' && /^([a-z]:[\\/]|\/)/i.test(value)).toBe(true)
  })

  it('points AP at the external BizHawk the user chose, and turns rom_start back on', async () => {
    const dir = makeExternal('win32')
    const settings = stubSettings({ [ROM_START_KEY]: false })
    const { bizhawk } = setup('win32', { settings })
    await bizhawk.setPath(dir)

    expect(await bizhawk.configureAp()).toMatchObject({ managed: false, path: dir, configuredInAp: true })
    expect(settings.values.get(EMUHAWK_KEY)).toBe(join(dir, 'EmuHawk.exe'))
    expect(settings.values.get(ROM_START_KEY)).toBe(true)
  })

  it('fails with NOT_FOUND when there is no BizHawk to point AP at, and writes nothing', async () => {
    const { bizhawk, settings } = setup('win32')
    expect((await failure(bizhawk.configureAp())).code).toBe('NOT_FOUND')
    expect(settings.sets).toEqual([])
  })

  it('lets the errors of the settings through (a program runs, AP is missing)', async () => {
    makeManaged('win32')
    const settings = stubSettings()
    const { bizhawk } = setup('win32', { settings })
    settings.set = () => Promise.reject(new AppError('SETTINGS_LOCKED', { processes: 'ArchipelagoLauncher' }))
    expect((await failure(bizhawk.configureAp())).code).toBe('SETTINGS_LOCKED')
  })
})

describe('with the real settings file of Archipelago', () => {
  const HOST_YAML = [
    'general_options:',
    '  output_path: "output"',
    'bizhawkclient_options:',
    '  # The location of the EmuHawk you want to auto launch patched ROMs with',
    '  emuhawk_path: null',
    '  # Set this to true to autostart a patched ROM in BizHawk with the connector script,',
    '  rom_start: false',
    '',
  ].join('\n')

  function realSettings(core: TestCore, ctx: CoreContext): { settings: ApSettings; hostYaml: string } {
    const ap = join(root, 'Archipélago')
    mkdirSync(ap, { recursive: true })
    const hostYaml = join(ap, 'host.yaml')
    writeFileSync(hostYaml, HOST_YAML)
    const paths = resolveApPaths(
      { localPath: ap, os: hostOs, home: core.platform.paths.home, localWritable: true, cwd: ap },
      existsSync,
    )
    const install: ApInstall = { kind: 'custom', version: '0.6.8', root: ap, appImagePath: null, paths }
    const locator: Locator = {
      detect: () => Promise.resolve(install),
      fromRoot: () => Promise.reject(new Error('not used')),
      exe: () => {
        throw new Error('not used')
      },
      invalidate: () => undefined,
    }
    return { settings: createApSettings(ctx, locator), hostYaml }
  }

  it('writes the launcher and rom_start into host.yaml, keeps its comments, and then reads it back', async () => {
    const core = createTestContext(root)
    const exec = execFor(hostOs)
    const ctx: CoreContext = { ...core.ctx, exec }
    const { settings, hostYaml } = realSettings(core, ctx)
    const bizhawk = createBizhawk(ctx, { settings, readOsRelease: () => Promise.resolve(UBUNTU) })
    const dir = makeManaged(hostOs)
    expect(await bizhawk.state()).toMatchObject({ installed: true, configuredInAp: false })

    const state = await bizhawk.configureAp()

    const text = readFileSync(hostYaml, 'utf8')
    expect(text).toContain('# The location of the EmuHawk you want to auto launch patched ROMs with')
    const written = parse(text, { version: '1.1' }) as { bizhawkclient_options: Record<string, unknown> }
    expect(written.bizhawkclient_options).toEqual({
      emuhawk_path: join(dir, LAUNCHER[hostOs]),
      rom_start: true,
    })
    expect(state).toMatchObject({ managed: true, path: dir, configuredInAp: true })
  })

  it('adopts the emuhawk_path of a host.yaml that Archipelago wrote', async () => {
    const core = createTestContext(root)
    const dir = makeExternal(hostOs)
    const ctx: CoreContext = { ...core.ctx, exec: execFor(hostOs) }
    const { settings, hostYaml } = realSettings(core, ctx)
    writeFileSync(
      hostYaml,
      HOST_YAML.replace(
        'emuhawk_path: null',
        `emuhawk_path: ${JSON.stringify(join(dir, LAUNCHER[hostOs]))}`,
      ).replace('rom_start: false', 'rom_start: true'),
    )
    const bizhawk = createBizhawk(ctx, { settings })

    expect(await bizhawk.state()).toMatchObject({
      installed: true,
      managed: false,
      path: dir,
      configuredInAp: true,
    })
  })
})

// --- handlers and service -----------------------------------------------------------------------

describe('bizhawk handlers', () => {
  const state: BizhawkState = {
    installed: true,
    managed: true,
    version: BIZHAWK_TAG,
    path: '/emulators/bizhawk',
    configuredInAp: false,
    prereqs: [],
  }

  /** A Bizhawk made of mocks, which are also returned: reading them back off the object is a lint error. */
  function fake(): {
    bizhawk: Bizhawk
    install: ReturnType<typeof vi.fn<Bizhawk['install']>>
    setPath: ReturnType<typeof vi.fn<Bizhawk['setPath']>>
    configureAp: ReturnType<typeof vi.fn<Bizhawk['configureAp']>>
  } {
    const install = vi.fn<Bizhawk['install']>(() => Promise.resolve(state))
    const setPath = vi.fn<Bizhawk['setPath']>(() => Promise.resolve(state))
    const configureAp = vi.fn<Bizhawk['configureAp']>(() => Promise.resolve(state))
    const bizhawk: Bizhawk = { state: () => Promise.resolve(state), install, setPath, configureAp }
    return { bizhawk, install, setPath, configureAp }
  }

  function boot(bizhawk: Bizhawk): {
    core: TestCore
    call: (name: string, input?: unknown) => Promise<unknown>
  } {
    const core = createTestContext(root)
    const services = {
      ctx: core.ctx,
      get: (name: string) => {
        if (name !== 'bizhawk') throw new Error(`unexpected service ${name}`)
        return bizhawk
      },
      startEager: () => undefined,
    } as unknown as ServiceContainer
    const ipc = createIpcRegistry()
    registerBizhawkHandlers(ipc.registerHandler, services)
    return { core, call: (name, input) => ipc.dispatch(name, input, { senderId: 1 }) }
  }

  it('bizhawk:state, bizhawk:setPath and bizhawk:configureAp answer with the state', async () => {
    const { bizhawk, setPath, configureAp } = fake()
    const { call } = boot(bizhawk)

    expect(await call('bizhawk:state')).toEqual({ ok: true, value: state })
    expect(await call('bizhawk:setPath', { path: 'D:\\BizHawk' })).toEqual({ ok: true, value: state })
    expect(await call('bizhawk:setPath', { path: null })).toEqual({ ok: true, value: state })
    expect(await call('bizhawk:configureAp')).toEqual({ ok: true, value: state })
    expect(setPath.mock.calls).toEqual([['D:\\BizHawk'], [null]])
    expect(configureAp).toHaveBeenCalledOnce()
  })

  it('bizhawk:install starts a bizhawk-install task whose result is the state', async () => {
    const { bizhawk, install } = fake()
    const { core, call } = boot(bizhawk)
    const done = new Promise<TaskDone>((resolve) => core.ctx.bus.on('task:done', resolve))

    const answer = (await call('bizhawk:install')) as { ok: true; value: { taskId: string } }

    expect(answer.ok).toBe(true)
    const finished = await done
    expect(finished).toMatchObject({ taskId: answer.value.taskId, kind: 'bizhawk-install', result: state })
    expect(install).toHaveBeenCalledOnce()
  })

  it('passes the errors on as data, and refuses an empty path', async () => {
    const { bizhawk, setPath, configureAp } = fake()
    configureAp.mockRejectedValue(new AppError('SETTINGS_LOCKED', { processes: 'x' }))
    const { call } = boot(bizhawk)

    expect(await call('bizhawk:configureAp')).toEqual({
      ok: false,
      error: { code: 'SETTINGS_LOCKED', params: { processes: 'x' } },
    })
    expect(await call('bizhawk:setPath', { path: '' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    expect(setPath).not.toHaveBeenCalled()
  })

  it('registerHandlers loads the module, and the service resolves from the container', async () => {
    const core = createTestContext(root)
    const ipc = createIpcRegistry()
    const services = createServices(core.ctx)
    registerHandlers(services, ipc.registerHandler)

    expect(Object.keys(services.get('bizhawk')).sort()).toEqual([
      'configureAp',
      'install',
      'setPath',
      'state',
    ])
    // `bizhawk:setPath` reaches the real service: a relative path is refused before anything else.
    expect(await ipc.dispatch('bizhawk:setPath', { path: 'relative' }, { senderId: 1 })).toMatchObject({
      ok: false,
      error: { code: 'PATH_FORBIDDEN' },
    })
  })
})
