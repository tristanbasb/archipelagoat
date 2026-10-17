// Finds the Archipelago install and the folders it uses (spec §3.1). The path rules reimplement
// Utils.local_path / user_path / home_path / cache_path, worlds/__init__.py and settings.py:885-907 of
// Archipelago 0.6.8 (research brief §1.4).
import { constants, cpSync, existsSync, mkdtempSync } from 'node:fs'
import { access, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { AP_EXES, AP_UNINSTALL_KEY, apExeFileName } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { ApInstall, ApInstallKind, ApPaths, ExeRef, OS } from '@shared/types'
import type { CoreContext } from '../context'
import { readRegistryValues } from '../system/registry'

/** The archipelago:// handler the installer registers: `"{app}\ArchipelagoLauncher.exe" "%1"`. */
const PROTOCOL_KEY = 'HKLM\\SOFTWARE\\Classes\\archipelago\\shell\\open\\command'

const SETTINGS_FILES = ['options.yaml', 'host.yaml'] as const

/** `Archipelago_0.6.8_linux-x86_64.AppImage`, or a renamed copy; never ArchipelaGOAT's own AppImage. */
const AP_APPIMAGE = /^archipelago.*\.appimage$/i
const OWN_NAME = /^archipelagoat/i

/** What the locator reads from the disk; tests inject their own. */
export interface LocatorFs {
  exists(p: string): boolean
  /** The file's text; null when it cannot be read. */
  readText(p: string): Promise<string | null>
  /** Names in a folder; [] when it cannot be read. */
  list(dir: string): Promise<string[]>
  /**
   * True when the folder grants write access, the check of AP's `os.access(local_path(), os.W_OK)`.
   * It must write nothing: nothing is ever written to AP's folder.
   */
  isWritableDir(dir: string): Promise<boolean>
}

export const nodeLocatorFs: LocatorFs = {
  exists: existsSync,
  readText: (p) => readFile(p, 'utf8').catch(() => null),
  list: (dir) => readdir(dir).catch(() => []),
  isWritableDir: (dir) =>
    access(dir, constants.W_OK).then(
      () => true,
      () => false,
    ),
}

export interface LocatorOptions {
  /** Replaces an executable (fake executables of the tests); null keeps the real one. */
  exeOverride?: (name: string) => ExeRef | null
  /** A fake install (copy of GOAT_FAKE_AP_DIR): `detect()` returns it and looks nowhere else. */
  fakeRoot?: string
  /**
   * No system detection at all (GOAT_FAKE_AP_DIR=none, test environment only): no registry, no
   * ProgramData, no managed folder or AppImage search, so a test run sees no Archipelago whatever the
   * machine has. A folder the user picks (ap:setCustomPath) still counts.
   */
  noDetection?: boolean
  fs?: LocatorFs
  /** XDG_DATA_HOME, XDG_CACHE_HOME, LOCALAPPDATA, ProgramData; process.env by default. */
  env?: NodeJS.ProcessEnv
  /** Default: Date.now. */
  now?: () => number
}

/**
 * Next to an install folder the app filled from the Linux tar.gz: the files its releases brought
 * (installer-linux.ts). It tells an install the app made, and keeps updating and uninstalling, from a
 * folder the user picked by hand.
 */
export const LINUX_INSTALL_RECORD = 'archipelagoat-files.json'

/** How long an answer is trusted before `detect()` looks again, in the background. */
const FOUND_TTL_MS = 30_000
/** Nothing found: looked for again sooner (an install made outside the app while it is open). */
const MISSING_TTL_MS = 5_000

/** The same install, as the app sees it: folder, kind, version. */
function sameInstall(a: ApInstall | null, b: ApInstall | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.root === b.root && a.kind === b.kind && a.version === b.version && a.appImagePath === b.appImagePath
  )
}

export interface Locator {
  /**
   * The install the app uses, or null. Cached; past 30 s (5 s while nothing is found) the cached
   * answer is still returned at once while the detection runs again in the background: when it finds
   * another install (installed, updated or removed outside the app), the cache follows and
   * `ap:installed` is emitted with it (null when none is left). `invalidate()` drops the cache.
   */
  detect(): Promise<ApInstall | null>
  /** The install in `root`; AP_NOT_INSTALLED when `root` holds no ArchipelagoLauncher. */
  fromRoot(root: string, kind?: ApInstallKind): Promise<ApInstall>
  /** How to run one of Archipelago's programs (`AP_EXES`). */
  exe(install: ApInstall, name: string): ExeRef
  invalidate(): void
}

export interface ApPathsInput {
  /** Archipelago's folder; '' when it cannot be read (an AppImage, whose folder is inside its mount). */
  localPath: string
  os: OS
  home: string
  /** Linux; ignored unless absolute, like the app's own data folder. */
  xdgDataHome?: string | null
  xdgCacheHome?: string | null
  /** Windows: %LOCALAPPDATA%. */
  localAppData?: string | null
  /** Whether Archipelago can write in `localPath` (Linux; on Windows its data always stays there). */
  localWritable: boolean
  /** The folder Archipelago runs in, which decides the settings file it loads. */
  cwd: string
}

const lib = (os: OS): path.PlatformPath => (os === 'win32' ? path.win32 : path.posix)

/** Normalized, without a trailing separator (except at the root). */
function normalizeDir(p: string, os: OS): string {
  const normalized = lib(os).normalize(p)
  if (normalized.length <= lib(os).parse(normalized).root.length) return normalized
  return normalized.replace(os === 'win32' ? /[\\/]+$/ : /\/+$/, '')
}

/** Same file or folder, compared without case on Windows. */
function samePath(a: string, b: string, os: OS): boolean {
  const x = normalizeDir(a, os)
  const y = normalizeDir(b, os)
  return os === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

const absoluteOr = (value: string | null | undefined, fallback: string, os: OS): string =>
  value && lib(os).isAbsolute(value) ? value : fallback

/** Utils.home_path on Linux: `${XDG_DATA_HOME:-~/.local/share}/Archipelago`. */
function linuxHomePath(home: string, xdgDataHome: string | null | undefined): string {
  return path.posix.join(
    absoluteOr(xdgDataHome, path.posix.join(home, '.local', 'share'), 'linux'),
    'Archipelago',
  )
}

/** platformdirs.user_cache_dir('Archipelago', False). */
function cachePath({ os, home, localAppData, xdgCacheHome }: ApPathsInput): string {
  if (os === 'win32') {
    const base = absoluteOr(localAppData, path.win32.join(home, 'AppData', 'Local'), 'win32')
    return path.win32.join(base, 'Archipelago', 'Cache')
  }
  return path.posix.join(absoluteOr(xdgCacheHome, path.posix.join(home, '.cache'), 'linux'), 'Archipelago')
}

/** `{"version": [0, 6, 8], …}` (manifest.json) → `'0.6.8'`; null for anything else. */
export function readManifestVersion(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null
  const { version } = json as { version?: unknown }
  if (!Array.isArray(version) || version.length < 2 || version.length > 4) return null
  const parts: unknown[] = version
  if (!parts.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return null
  return parts.join('.')
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
  } catch {
    return null
  }
}

/** The first `x.y.z` of a text (`Archipelago 0.6.8`, an AppImage name). */
function versionIn(text: string | undefined): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text ?? '')?.[1] ?? null
}

/** Orders versions numerically; a missing version comes first. */
function compareVersions(a: string | null, b: string | null): number {
  if (a === null || b === null) return (a === null ? 0 : 1) - (b === null ? 0 : 1)
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The one settings file Archipelago loads (settings.py:885-907): `options.yaml` then `host.yaml` in
 * the cwd, unless the cwd is the install folder, then the same two in user_path. When none exists,
 * the `host.yaml` it would create in user_path.
 */
export function resolveSettingsFile(
  localPath: string,
  userPath: string,
  cwd: string,
  exists: (p: string) => boolean,
): string {
  // Windows paths start with a drive letter (or \\ for a network share).
  const os: OS = /^([a-z]:|\\\\)/i.test(userPath) ? 'win32' : 'linux'
  const paths = lib(os)
  const dirs = localPath !== '' && samePath(cwd, localPath, os) ? [userPath] : [cwd, userPath]
  const candidates = dirs.flatMap((dir) => SETTINGS_FILES.map((name) => paths.join(dir, name)))
  return candidates.find((file) => exists(file)) ?? paths.join(userPath, 'host.yaml')
}

/** The folders of an install (Utils.user_path and friends, research brief §1.4). */
export function resolveApPaths(input: ApPathsInput, exists: (p: string) => boolean): ApPaths {
  const { localPath, os, home } = input
  const paths = lib(os)
  // On Windows, home_path() is local_path(): the data stays in the install whatever its permissions.
  const userPath =
    os === 'win32' || (input.localWritable && localPath !== '')
      ? localPath
      : linuxHomePath(home, input.xdgDataHome)
  return {
    localPath,
    userPath,
    customWorlds: paths.join(userPath, userPath === localPath ? 'custom_worlds' : 'worlds'),
    coreWorlds: localPath === '' ? '' : paths.join(localPath, 'lib', 'worlds'),
    players: paths.join(userPath, 'Players'),
    templates: paths.join(userPath, 'Players', 'Templates'),
    output: paths.join(userPath, 'output'),
    logs: paths.join(userPath, 'logs'),
    cache: cachePath(input),
    settingsFile: resolveSettingsFile(localPath, userPath, input.cwd, exists),
  }
}

/** The program of a shell command line: `"C:\AP\ArchipelagoLauncher.exe" "%1"` → `C:\AP\…exe`. */
function commandProgram(command: string): string | null {
  const match = /^\s*(?:"([^"]+)"|(\S.*?\.exe)(?=\s|$))/i.exec(command)
  return match?.[1] ?? match?.[2] ?? null
}

export function createLocator(ctx: CoreContext, opts: LocatorOptions = {}): Locator {
  const { platform, log } = ctx
  const { os } = platform
  const paths = lib(os)
  const fs = opts.fs ?? nodeLocatorFs
  const env = opts.env ?? process.env
  const now = opts.now ?? Date.now
  let cached: Promise<ApInstall | null> | null = null
  /** When the cached answer was found, and what it is (once found). */
  let checked: { at: number; install: ApInstall | null } | null = null
  let refreshing: Promise<void> | null = null

  const pathsFor = (localPath: string, localWritable: boolean, cwd: string): ApPaths =>
    resolveApPaths(
      {
        localPath,
        os,
        home: platform.paths.home,
        xdgDataHome: env.XDG_DATA_HOME,
        xdgCacheHome: env.XDG_CACHE_HOME,
        localAppData: env.LOCALAPPDATA,
        localWritable,
        cwd,
      },
      (p) => fs.exists(p),
    )

  const readManifest = async (file: string): Promise<string | null> =>
    readManifestVersion(parseJson(await fs.readText(file)))

  /** `displayName` (the uninstall key's `Archipelago 0.6.8`) gives the version without manifest.json. */
  async function build(root: string, kind: ApInstallKind, displayName?: string): Promise<ApInstall> {
    const localPath = normalizeDir(root, os)
    const launcher = paths.join(localPath, apExeFileName(AP_EXES.launcher, os))
    const fakeLauncher = paths.join(localPath, `${AP_EXES.launcher}.mjs`)
    if (!fs.exists(launcher) && !(opts.exeOverride && fs.exists(fakeLauncher))) {
      throw new AppError('AP_NOT_INSTALLED', undefined, { detail: localPath })
    }
    const version = (await readManifest(paths.join(localPath, 'manifest.json'))) ?? versionIn(displayName)
    // user_path(): Linux checks os.access(W_OK), which writes nothing. Windows needs no check, since
    // home_path() is local_path() there.
    const localWritable = os === 'win32' || (await fs.isWritableDir(localPath))
    // Archipelago runs in its own folder unless a session says otherwise (Task 8).
    const appPaths = pathsFor(localPath, localWritable, localPath)
    return { kind, version, root: localPath, appImagePath: null, paths: appPaths }
  }

  /** The install in `root`, or null (logged) when there is none. */
  async function attempt(root: string, kind: ApInstallKind, displayName?: string): Promise<ApInstall | null> {
    try {
      return await build(root, kind, displayName)
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'AP_NOT_INSTALLED')) {
        log.warn(`locator: cannot read ${root}`, error)
      }
      return null
    }
  }

  async function readKey(key: string): Promise<Record<string, string> | null> {
    try {
      return await readRegistryValues(ctx.exec, key, { view64: true })
    } catch (error) {
      log.warn(`locator: cannot read ${key}`, error)
      return null
    }
  }

  /** A command line that runs ArchipelaGOAT (its own archipelago:// handler) is no Archipelago. */
  function isOwnProgram(program: string): boolean {
    return samePath(program, platform.paths.exe, 'win32') || OWN_NAME.test(path.win32.basename(program))
  }

  async function findWindows(): Promise<ApInstall | null> {
    const uninstall = await readKey(AP_UNINSTALL_KEY)
    const location = uninstall?.InstallLocation || uninstall?.['Inno Setup: App Path']
    if (location) {
      const install = await attempt(location, 'windows-installer', uninstall?.DisplayName)
      if (install) return install
    }
    const command = (await readKey(PROTOCOL_KEY))?.['']
    const program = command ? commandProgram(command) : null
    if (program && !isOwnProgram(program)) {
      const install = await attempt(path.win32.dirname(program), 'windows-installer')
      if (install) return install
    }
    // Inno's {commonappdata}\Archipelago, the installer's default folder.
    return attempt(path.win32.join(env.ProgramData || 'C:\\ProgramData', 'Archipelago'), 'windows-installer')
  }

  /** The AppImage with the highest version in its name, in the usual folders. */
  async function newestAppImage(): Promise<string | null> {
    const { home, downloads } = platform.paths
    const dirs = new Set([
      path.posix.join(home, 'Applications'),
      path.posix.join(home, 'Downloads'),
      // The XDG downloads folder, which may be localized (~/Téléchargements).
      downloads,
      path.posix.join(home, '.local', 'bin'),
    ])
    let best: { file: string; version: string | null } | null = null
    for (const dir of dirs) {
      for (const name of (await fs.list(dir)).sort()) {
        if (!AP_APPIMAGE.test(name) || OWN_NAME.test(name)) continue
        const version = versionIn(name)
        if (!best || compareVersions(version, best.version) > 0)
          best = { file: path.posix.join(dir, name), version }
      }
    }
    return best?.file ?? null
  }

  /**
   * An AppImage's folder is inside its mount: `localPath` and `coreWorlds` are '' (the core worlds come
   * from `coreWorldsFor(version)`), and its data lives in ~/.local/share/Archipelago, where it runs.
   */
  async function fromAppImage(file: string): Promise<ApInstall> {
    const userPath = linuxHomePath(platform.paths.home, env.XDG_DATA_HOME)
    const version =
      versionIn(path.posix.basename(file)) ?? (await readManifest(path.posix.join(userPath, 'manifest.json')))
    return {
      kind: 'linux-appimage',
      version,
      root: path.posix.dirname(file),
      appImagePath: file,
      paths: pathsFor('', false, userPath),
    }
  }

  async function findLinux(): Promise<ApInstall | null> {
    const managedRoot = path.posix.join(platform.paths.dataRoot, 'archipelago', 'Archipelago')
    const managed = await attempt(managedRoot, 'linux-managed')
    if (managed) return managed
    const appImage = await newestAppImage()
    return appImage ? fromAppImage(appImage) : null
  }

  async function find(): Promise<ApInstall | null> {
    if (opts.fakeRoot !== undefined) return build(opts.fakeRoot, 'custom')
    // A folder the user chose wins: it is an explicit choice.
    const override = ctx.config.get().apPathOverride
    if (override) {
      // A folder the app installed the tar.gz into (a custom install folder on Linux) stays its own.
      // (The folder is a path of this machine: the host's own path rules read it.)
      const madeByApp = os === 'linux' && fs.exists(path.join(path.dirname(override), LINUX_INSTALL_RECORD))
      const install = await attempt(override, madeByApp ? 'linux-targz' : 'custom')
      if (install) return install
      log.warn('locator: the chosen Archipelago folder holds no install, looking elsewhere', {
        path: override,
      })
    }
    if (opts.noDetection === true) return null
    return os === 'win32' ? findWindows() : findLinux()
  }

  /** Looks again in the background; a different install replaces the cached one and is announced. */
  function refresh(previous: Promise<ApInstall | null>, old: ApInstall | null): void {
    refreshing = find().then(
      (install) => {
        // Invalidated meanwhile: the newer detection wins.
        if (cached !== previous) return
        checked = { at: now(), install }
        if (sameInstall(old, install)) return
        log.info('locator: the install changed outside the app', { from: old?.root, to: install?.root })
        cached = Promise.resolve(install)
        ctx.bus.emit('ap:installed', install)
      },
      (error: unknown) => log.warn('locator: detecting again failed', error),
    )
    void refreshing.finally(() => {
      refreshing = null
    })
  }

  return {
    detect() {
      if (!cached) {
        const pending: Promise<ApInstall | null> = find().then(
          (install) => {
            if (cached === pending) checked = { at: now(), install }
            return install
          },
          (error: unknown) => {
            if (cached === pending) cached = null
            throw error
          },
        )
        cached = pending
        checked = null
        return pending
      }
      if (checked && !refreshing) {
        const ttl = checked.install === null ? MISSING_TTL_MS : FOUND_TTL_MS
        if (now() - checked.at >= ttl) refresh(cached, checked.install)
      }
      return cached
    },

    fromRoot: (root, kind = 'custom') => build(root, kind),

    exe(install, name) {
      const override = opts.exeOverride?.(name)
      if (override) return override
      if (install.appImagePath) return { command: install.appImagePath, argsPrefix: [`--executable=${name}`] }
      return { command: paths.join(install.root, apExeFileName(name, os)), argsPrefix: [] }
    },

    invalidate() {
      cached = null
      checked = null
    },
  }
}

/** The GOAT_FAKE_AP_DIR value that asks for no Archipelago at all (see LocatorOptions.noDetection). */
export const NO_AP = 'none'

/**
 * GOAT_FAKE_AP_DIR, honoured in the test environment only: a temporary copy of that folder (removed
 * on quit), whose `<name>.mjs` scripts stand in for Archipelago's programs and run with Node; `none`
 * turns the system detection off instead.
 */
export function fakeApFromEnv(
  ctx: CoreContext,
  env: NodeJS.ProcessEnv = process.env,
  versions: { electron?: string } = process.versions,
): LocatorOptions | null {
  const testEnv = !ctx.platform.isPackaged || env.GOAT_E2E === '1'
  const source = testEnv ? env.GOAT_FAKE_AP_DIR : undefined
  if (!source) return null
  if (source === NO_AP) return { noDetection: true }
  const root = mkdtempSync(path.join(ctx.platform.paths.temp, 'goat-fake-ap-'))
  cpSync(source, root, { recursive: true })
  ctx.lifecycle.onBeforeQuit(() => rm(root, { recursive: true, force: true, maxRetries: 3 }), {
    phase: 'late',
  })
  // Under Electron, process.execPath is the app itself: this makes it run the script as Node.
  const runEnv: Record<string, string> = versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
  return {
    fakeRoot: root,
    exeOverride: (name) => ({
      command: process.execPath,
      argsPrefix: [path.join(root, `${name}.mjs`)],
      env: { ...runEnv },
    }),
  }
}
