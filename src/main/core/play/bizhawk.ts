// BizHawk, the emulator behind the one-click games (spec §3.12, brief §1.11): the pinned release
// installed under dataRoot, an install the user already has adopted, the prerequisites of the platform
// checked, and Archipelago's settings pointed at it. Nothing here starts BizHawk: ArchipelagoBizHawkClient
// does, from `bizhawkclient_options` (worlds/_bizhawk/context.py).
import { chmod, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fetchReleaseByTag } from '@main/core/ap/releases'
import { SETTINGS_KEYS, type ApSettings } from '@main/core/ap/settings'
import type { CoreContext } from '@main/core/context'
import type { ExecFn } from '@main/core/exec'
import { extractTarGzSafe, extractZipSafe } from '@main/core/system/archive'
import { download } from '@main/core/system/downloads'
import { writeFileAtomic } from '@main/core/system/fsx'
import { psQuote, runPowerShell } from '@main/core/system/powershell'
import { readRegistryValues } from '@main/core/system/registry'
import { assertUserPath } from '@main/core/system/user-path'
import type { TaskHandle } from '@main/core/tasks'
import { BIZHAWK_ASSETS, BIZHAWK_REPO, BIZHAWK_TAG } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { BizhawkState, OS } from '@shared/types'

type Prereq = BizhawkState['prereqs'][number]

/** Names of the prerequisites, as the Emulators and ROMs screen knows them. */
const PREREQ = {
  vcRedist: 'vc_redist.x64',
  mono: 'mono',
  lua: 'lua5.4',
  lsb: 'lsb_release',
  openal: 'libopenal',
  version: 'bizhawk-version',
} as const

/** What Archipelago starts: `emuhawk_path` is this file (brief §1.11: Mono needs `EmuHawkMono.sh`). */
const LAUNCHER: Record<OS, string> = { win32: 'EmuHawk.exe', linux: 'EmuHawkMono.sh' }

/** The VC++ runtime BizHawk needs since 2.10, in the native 64-bit view (brief §1.11). */
const VC_RUNTIME_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
/** Opened by the screen with `app:openExternal`: it is on the allowlist. */
const VC_REDIST_URL = 'https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist'

/** Written last: a folder without it is an install that was interrupted. */
const VERSION_FILE = '.goat-version'
/** The BizHawk folder the user chose (userData): the choice is the app's, Archipelago is not touched. */
const CHOICE_FILE = 'bizhawk.json'

const PROBE_TIMEOUT_MS = 10_000
const VERSION_TIMEOUT_MS = 15_000
/** The archive is verified (digest, size) before it is opened: the limit only has to hold a BizHawk. */
const MAX_UNPACKED = 2 * 1024 ** 3

// --- prerequisites ------------------------------------------------------------------------------

/**
 * The VC++ x64 runtime: present when its key in the 64-bit registry view holds a `Version` and is
 * not marked uninstalled. A registry that cannot be read leaves it unproven, so it counts as missing.
 */
export async function checkPrereqsWindows(exec: ExecFn): Promise<Prereq[]> {
  let present = false
  try {
    const values = await readRegistryValues(exec, VC_RUNTIME_KEY, { view64: true })
    present = values !== null && (values.Version ?? '').trim() !== '' && values.Installed !== '0'
  } catch {
    // PowerShell failed or printed something else.
  }
  return [{ name: PREREQ.vcRedist, ok: present, hint: present ? null : VC_REDIST_URL }]
}

/** True when the program starts: its exit code is not what is looked at, only that it exists. */
async function starts(exec: ExecFn, cmd: string, args: string[]): Promise<boolean> {
  try {
    await exec(cmd, args, { timeoutMs: PROBE_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}

/** `libopenal.so.1` for x86-64 in the loader cache; `ldconfig` is not on the PATH of a regular user on Debian. */
async function hasOpenAl(exec: ExecFn): Promise<boolean> {
  for (const cmd of ['ldconfig', '/sbin/ldconfig']) {
    try {
      const { code, stdout } = await exec(cmd, ['-p'], { timeoutMs: PROBE_TIMEOUT_MS })
      if (code === 0) return /^\s*libopenal\.so\.1\s.*x86-64/m.test(stdout)
    } catch {
      // Not found: the next one.
    }
  }
  return false
}

/** Mono, Lua 5.4, lsb_release and OpenAL, which BizHawk needs under Linux. The hints are added by the caller. */
export async function checkPrereqsLinux(exec: ExecFn): Promise<Prereq[]> {
  const [mono, lua, lsb, openal] = await Promise.all([
    starts(exec, 'mono', ['--version']),
    starts(exec, 'lua5.4', ['-v']),
    starts(exec, 'lsb_release', ['-v']),
    hasOpenAl(exec),
  ])
  const prereq = (name: string, ok: boolean): Prereq => ({ name, ok, hint: null })
  return [
    prereq(PREREQ.mono, mono),
    prereq(PREREQ.lua, lua),
    prereq(PREREQ.lsb, lsb),
    prereq(PREREQ.openal, openal),
  ]
}

type PackageManager = 'apt' | 'dnf' | 'pacman'

/** The distributions and families whose package manager is known: by `ID`, then by each `ID_LIKE`. */
const FAMILIES = new Map<string, PackageManager>([
  ['debian', 'apt'],
  ['ubuntu', 'apt'],
  ['fedora', 'dnf'],
  ['rhel', 'dnf'],
  ['centos', 'dnf'],
  ['arch', 'pacman'],
])

const INSTALL_COMMANDS: Record<PackageManager, { command: string; packages: Record<string, string> }> = {
  apt: {
    command: 'sudo apt install',
    packages: {
      [PREREQ.mono]: 'mono-complete',
      [PREREQ.lua]: 'lua5.4',
      [PREREQ.lsb]: 'lsb-release',
      [PREREQ.openal]: 'libopenal1',
    },
  },
  dnf: {
    command: 'sudo dnf install',
    // dnf resolves a file path to the package that holds it, whatever that package is called.
    packages: {
      [PREREQ.mono]: 'mono-complete',
      [PREREQ.lua]: 'lua',
      [PREREQ.lsb]: '/usr/bin/lsb_release',
      [PREREQ.openal]: 'openal-soft',
    },
  },
  pacman: {
    command: 'sudo pacman -S',
    packages: {
      [PREREQ.mono]: 'mono',
      [PREREQ.lua]: 'lua',
      [PREREQ.lsb]: 'lsb-release',
      [PREREQ.openal]: 'openal',
    },
  },
}

/** A value of `/etc/os-release` (`KEY=value`, `KEY="value"` or `KEY='value'`); '' when the key is not there. */
function osReleaseValue(text: string, key: string): string {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`))
  return (line?.slice(key.length + 1) ?? '').trim().replace(/^(["'])(.*)\1$/, '$2')
}

/**
 * The shell command that installs the `missing` prerequisites (their names, as `checkPrereqsLinux`
 * gives them) on the distribution that `osRelease` (the text of `/etc/os-release`) describes: apt for
 * Debian and Ubuntu, dnf for Fedora and RHEL, pacman for Arch, and their derivatives. '' when the
 * distribution is not known or nothing is to be installed.
 */
export function linuxInstallHint(osRelease: string, missing: string[]): string {
  const ids = [osReleaseValue(osRelease, 'ID'), ...osReleaseValue(osRelease, 'ID_LIKE').split(/\s+/)]
  const manager = ids.map((id) => FAMILIES.get(id.toLowerCase())).find((m) => m !== undefined)
  if (!manager) return ''
  const { command, packages } = INSTALL_COMMANDS[manager]
  // Always in the same order, each package once.
  const wanted = Object.keys(packages).filter((name) => missing.includes(name))
  return wanted.length === 0 ? '' : [command, ...wanted.map((name) => packages[name])].join(' ')
}

// --- versions -----------------------------------------------------------------------------------

/** `2.11.1.0` → `2.11.1`, `2.10.0.0` → `2.10`, `2.10.0+b8a07a3` → `2.10`; null when it does not start like a version. */
function normalizeVersion(raw: string): string | null {
  const match = /^(\d+)\.(\d+)((?:\.\d+)*)/.exec(raw.trim())
  if (!match) return null
  const parts = [match[1] ?? '', match[2] ?? '', ...(match[3] ?? '').split('.').filter((part) => part !== '')]
  while (parts.length > 2 && parts.at(-1) === '0') parts.pop()
  return parts.join('.')
}

/** The connector refuses BizHawk before 2.7 and warns after 2.11 (brief §1.11); an unknown version is not proven. */
function supportedVersion(version: string | null): boolean {
  if (version === null) return false
  const [major, minor] = version.split('.').map(Number)
  return major === 2 && minor !== undefined && minor >= 7 && minor <= 11
}

// --- the service --------------------------------------------------------------------------------

export interface Bizhawk {
  /**
   * The BizHawk the app presents: the one the user chose, else the one it installed, else the one
   * Archipelago's `emuhawk_path` points to (external, `managed: false`). `path` is its folder.
   * `prereqs` holds the prerequisites of the platform, and `bizhawk-version` once something is installed.
   */
  state(): Promise<BizhawkState>
  /**
   * The pinned release, downloaded, verified and extracted (task `bizhawk-install`); resolves with the new
   * state. It also takes the place of a folder chosen with `setPath`. An install asked while another one
   * runs joins it (and its task, which is the one that reports and can be cancelled). An asset the API
   * gives no digest for is refused (INSTALL_FAILED `no-digest`) before anything is downloaded.
   */
  install(task: TaskHandle): Promise<BizhawkState>
  /**
   * Chooses the BizHawk folder `path` (it must hold the launcher: NOT_FOUND otherwise); null forgets the
   * choice, and `emuhawk_path` too when it points to that install, or the app would adopt it again.
   * Archipelago is not changed otherwise: `configureAp` does that.
   */
  setPath(path: string | null): Promise<BizhawkState>
  /**
   * Writes the absolute path of the launcher (`EmuHawk.exe`, `EmuHawkMono.sh` under Linux) and
   * `rom_start: true` into Archipelago's settings. NOT_FOUND when there is no BizHawk, and the errors
   * of `ApSettings.set` (SETTINGS_LOCKED, AP_NOT_INSTALLED, YAML_PARSE).
   */
  configureAp(): Promise<BizhawkState>
}

export interface BizhawkDeps {
  settings: Pick<ApSettings, 'get' | 'set'>
  /** The text of `/etc/os-release`, for the install command. Default: reads the file ('' when there is none). */
  readOsRelease?: () => Promise<string>
}

/** A BizHawk folder: where it is and the launcher in it. */
interface Located {
  dir: string
  launcher: string
  managed: boolean
}

/** What Archipelago's settings say about BizHawk. */
interface ApView {
  emuhawkPath: string | null
  romStart: unknown
}

async function readOsReleaseFile(): Promise<string> {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      // The next place.
    }
  }
  return ''
}

const isFile = (file: string): Promise<boolean> =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  )

const readText = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '')

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('TASK_CANCELLED')
}

/** What an install reports: cancellations and its own failures as they are, anything else as INSTALL_FAILED. */
function installFailure(error: unknown): AppError {
  if (error instanceof AppError && (error.code === 'TASK_CANCELLED' || error.code === 'INSTALL_FAILED')) {
    return error
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new AppError('INSTALL_FAILED', { reason: 'extract' }, { detail, cause: error })
}

export function createBizhawk(ctx: CoreContext, deps: BizhawkDeps): Bizhawk {
  const { os } = ctx.platform
  const { dataRoot, userData } = ctx.platform.paths
  const { settings } = deps
  const readOsRelease = deps.readOsRelease ?? readOsReleaseFile
  const managedDir = path.join(dataRoot, 'emulators', `bizhawk-${BIZHAWK_TAG}`)
  const choiceFile = path.join(userData, CHOICE_FILE)

  const fold = (p: string): string => (os === 'win32' ? p.toLowerCase() : p)
  const same = (a: string, b: string): boolean => fold(path.resolve(a)) === fold(path.resolve(b))

  /** Archipelago adds `.exe` to the path of an executable on Windows (settings.py `_resolve_exe`). */
  const resolveExe = (value: string): string =>
    os === 'win32' && !/\.exe$/i.test(value) ? `${value}.exe` : value

  const launcherIn = async (dir: string): Promise<string | null> => {
    const launcher = path.join(dir, LAUNCHER[os])
    return (await isFile(launcher)) ? launcher : null
  }

  async function readAp(): Promise<ApView> {
    try {
      const [emuhawkPath, romStart] = await Promise.all([
        settings.get(SETTINGS_KEYS.emuhawkPath),
        settings.get(SETTINGS_KEYS.romStart),
      ])
      const value = typeof emuhawkPath === 'string' ? emuhawkPath.trim() : ''
      return { emuhawkPath: value === '' ? null : value, romStart }
    } catch (error) {
      // Without Archipelago (or with a file it cannot read) there is no setting to adopt: not an error here.
      if (!(error instanceof AppError && error.code === 'AP_NOT_INSTALLED')) {
        ctx.log.warn('bizhawk: cannot read the archipelago settings', error)
      }
      return { emuhawkPath: null, romStart: undefined }
    }
  }

  /** The folder the user chose, when it still holds the launcher. */
  async function locateChosen(): Promise<Located | null> {
    let dir: unknown
    try {
      dir = (JSON.parse(await readFile(choiceFile, 'utf8')) as { path?: unknown } | null)?.path
    } catch {
      return null
    }
    if (typeof dir !== 'string' || dir === '') return null
    const launcher = await launcherIn(dir)
    return launcher ? { dir, launcher, managed: false } : null
  }

  /** The install of the app, once it is complete (the marker is the last file written). */
  async function locateManaged(): Promise<Located | null> {
    const launcher = await launcherIn(managedDir)
    if (!launcher || !(await isFile(path.join(managedDir, VERSION_FILE)))) return null
    return { dir: managedDir, launcher, managed: true }
  }

  /** The folder of the file `emuhawk_path` names, when the launcher is there (even if the path names another file). */
  async function locateAdopted(ap: ApView): Promise<Located | null> {
    if (ap.emuhawkPath === null) return null
    const target = resolveExe(ap.emuhawkPath)
    if (!path.isAbsolute(target)) return null
    const dir = path.dirname(target)
    const launcher = await launcherIn(dir)
    return launcher ? { dir, launcher, managed: false } : null
  }

  async function inspect(): Promise<{ found: Located | null; ap: ApView }> {
    const ap = await readAp()
    const found = (await locateChosen()) ?? (await locateManaged()) ?? (await locateAdopted(ap))
    return { found, ap }
  }

  /** Whether Archipelago starts this install: its launcher is `emuhawk_path` and `rom_start` is on. */
  const isConfigured = (ap: ApView, found: Located): boolean =>
    ap.emuhawkPath !== null &&
    same(resolveExe(ap.emuhawkPath), found.launcher) &&
    // A missing key is Archipelago's default (true); a command or false means it will not use emuhawk_path.
    (ap.romStart === true || ap.romStart === undefined)

  // The version of an EmuHawk.exe is read by PowerShell, which is slow: once per file as it is.
  const versions = new Map<string, string>()

  async function readExeVersion(exe: string): Promise<string | null> {
    if (os !== 'win32') return null
    try {
      const info = await stat(exe)
      const key = `${exe}\0${info.size}\0${info.mtimeMs}`
      const known = versions.get(key)
      if (known !== undefined) return known
      const script = `(Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo.ProductVersion`
      const { code, stdout } = await runPowerShell(ctx.exec, script, { timeoutMs: VERSION_TIMEOUT_MS })
      const version = code === 0 ? normalizeVersion(stdout) : null
      // A failure may be passing (a scan holding the file): it is asked again next time.
      if (version !== null) versions.set(key, version)
      return version
    } catch (error) {
      ctx.log.warn('bizhawk: cannot read the version of EmuHawk.exe', error)
      return null
    }
  }

  const versionOf = async (found: Located): Promise<string | null> =>
    found.managed
      ? normalizeVersion(await readText(path.join(found.dir, VERSION_FILE)))
      : readExeVersion(found.launcher)

  async function platformPrereqs(): Promise<Prereq[]> {
    if (os === 'win32') return checkPrereqsWindows(ctx.exec)
    const prereqs = await checkPrereqsLinux(ctx.exec)
    const missing = prereqs.filter((p) => !p.ok).map((p) => p.name)
    if (missing.length === 0) return prereqs
    // One command for all that is missing, on every missing one: the screen shows it once.
    const hint = linuxInstallHint(await readOsRelease(), missing)
    return hint === '' ? prereqs : prereqs.map((p) => (p.ok ? p : { ...p, hint }))
  }

  async function state(): Promise<BizhawkState> {
    const [{ found, ap }, prereqs] = await Promise.all([inspect(), platformPrereqs()])
    if (!found) {
      return { installed: false, managed: false, version: null, path: null, configuredInAp: false, prereqs }
    }
    const version = await versionOf(found)
    return {
      installed: true,
      managed: found.managed,
      version,
      path: found.dir,
      configuredInAp: isConfigured(ap, found),
      // Out of range, or unknown (Linux): accepted, with a warning.
      prereqs: [...prereqs, { name: PREREQ.version, ok: supportedVersion(version), hint: null }],
    }
  }

  // --- install ----------------------------------------------------------------------------------

  /** Replaces the install of the app by the content of `archive`; leaves nothing half-written. */
  async function unpack(archive: string, task: TaskHandle): Promise<void> {
    task.progress('extract', null)
    try {
      await rm(managedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      // A running EmuHawk holds its files under Windows. The old install is still whole.
      const detail = error instanceof Error ? error.message : String(error)
      throw new AppError('INSTALL_FAILED', { reason: 'remove-old' }, { detail, cause: error })
    }
    try {
      if (os === 'win32') {
        await extractZipSafe(archive, managedDir, { limits: { maxUncompressed: MAX_UNPACKED } })
      } else {
        await extractTarGzSafe(archive, managedDir)
      }
      const launcher = path.join(managedDir, LAUNCHER[os])
      if (!(await isFile(launcher))) {
        throw new AppError('INSTALL_FAILED', { reason: 'launcher-missing' }, { detail: LAUNCHER[os] })
      }
      // Archipelago runs it directly: it must not depend on the modes the archive happened to keep.
      if (os === 'linux') await chmod(launcher, 0o755)
      throwIfCancelled(task.signal)
      await writeFileAtomic(path.join(managedDir, VERSION_FILE), `${BIZHAWK_TAG}\n`)
    } catch (error) {
      await rm(managedDir, { recursive: true, force: true }).catch(() => undefined)
      throw installFailure(error)
    }
  }

  async function runInstall(task: TaskHandle): Promise<BizhawkState> {
    const assetName = BIZHAWK_ASSETS[os]
    throwIfCancelled(task.signal)
    task.progress('release', null)
    const { assets } = await fetchReleaseByTag(ctx.http, BIZHAWK_REPO, BIZHAWK_TAG)
    const asset = assets.find((a) => a.name === assetName)
    if (!asset) throw new AppError('NOT_FOUND', undefined, { detail: assetName })
    // The archive is executed afterwards: without the digest of the API there is nothing to trust it by.
    if (asset.sha256 === null) {
      throw new AppError('INSTALL_FAILED', { reason: 'no-digest' }, { detail: assetName })
    }

    const archive = path.join(dataRoot, 'downloads', 'bizhawk', assetName)
    task.progress('download', 0)
    try {
      await download(ctx.http, {
        url: asset.url,
        dest: archive,
        sha256: asset.sha256,
        expectedSize: asset.size,
        signal: task.signal,
        onProgress: ({ received, total }) =>
          task.progress('download', total ? Math.min(100, Math.round((received * 100) / total)) : null),
      })
      throwIfCancelled(task.signal)
      await unpack(archive, task)
    } finally {
      await rm(archive, { force: true }).catch(() => undefined)
    }

    // Installing is choosing the install of the app over a folder picked before.
    await rm(choiceFile, { force: true })
    ctx.log.info('bizhawk: installed', { dir: managedDir, version: BIZHAWK_TAG })
    return state()
  }

  // Two installs at once would remove each other's files: the second one joins the first.
  let installing: Promise<BizhawkState> | null = null

  return {
    state,

    install(task) {
      installing ??= runInstall(task).finally(() => {
        installing = null
      })
      return installing
    },

    async setPath(p) {
      if (p === null) {
        const { found, ap } = await inspect()
        // Archipelago first: when it cannot be changed (a program runs) the choice is kept, to try again.
        if (
          found &&
          !found.managed &&
          ap.emuhawkPath !== null &&
          same(resolveExe(ap.emuhawkPath), found.launcher)
        ) {
          await settings.set([{ path: SETTINGS_KEYS.emuhawkPath, value: null }])
        }
        await rm(choiceFile, { force: true })
        return state()
      }
      const dir = await assertUserPath(p, { kind: 'dir' })
      if ((await launcherIn(dir)) === null) {
        throw new AppError('NOT_FOUND', { file: LAUNCHER[os] }, { detail: dir })
      }
      await writeFileAtomic(choiceFile, `${JSON.stringify({ path: dir })}\n`)
      return state()
    },

    async configureAp() {
      const { found } = await inspect()
      if (!found) throw new AppError('NOT_FOUND', undefined, { detail: 'bizhawk' })
      await settings.set([
        { path: SETTINGS_KEYS.emuhawkPath, value: path.resolve(found.launcher) },
        { path: SETTINGS_KEYS.romStart, value: true },
      ])
      return state()
    },
  }
}
