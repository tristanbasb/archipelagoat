// Installs, updates and uninstalls the managed copy of Archipelago on Linux (spec §3.5, brief C6 mode
// a): the official tar.gz, extracted to one stable folder updated in place the way the Windows
// installer does it. No FUSE, no mount path, no root. The files a release brought are recorded next
// to the install folder (never inside it), so that an uninstall removes those and nothing else:
// Archipelago's user folder is the install folder here, and holds YAMLs, games and ROMs.
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
} from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CoreContext } from '@main/core/context'
import type { ExecFn } from '@main/core/exec'
import { extractTarGzSafe } from '@main/core/system/archive'
import { pathExists, safeJoin, writeFileAtomic } from '@main/core/system/fsx'
import type { TaskHandle } from '@main/core/tasks'
import { AppError } from '@shared/errors'
import type { ApInstall, ApRelease } from '@shared/types'
import {
  backupApData,
  fetchReleaseAsset,
  purgeApUserData,
  throwIfCancelled,
  userDataTargets,
} from './install-steps'
import { createLocator, type Locator } from './locator'

/** The release's single top folder (brief §1.3), also the install folder inside `targetRoot`. */
const AP_FOLDER = 'Archipelago'

/** Next to the install folder: `{ "files": [...] }`, the paths (with `/`) the releases installed. */
const RECORD_FILE = 'archipelagoat-files.json'

/** The oldest glibc the builds of Archipelago are made for. */
const MIN_GLIBC: readonly [number, number] = [2, 35]

/** Files at the root that an update never replaces once they exist (a release ships none of them). */
const KEPT_FILES = new Set(['host.yaml', 'options.yaml'])
/** Folders that only ever hold user data: nothing in them is recorded, so nothing is uninstalled. */
const USER_FOLDERS = new Set(['custom_worlds', 'output', 'logs'])

const recordSchema = z.object({ files: z.array(z.string().min(1)) })

/** Frozen programs sit at the root, all named `Archipelago<Component>` (brief §1.5). */
const isProgram = (name: string): boolean => name.startsWith('Archipelago')

/**
 * The version of glibc (`ldd --version`) and whether it is 2.35 or newer. An ldd that is not
 * glibc's (musl) or that cannot run gives `{ version: null, ok: false }`.
 */
export async function checkGlibc(exec: ExecFn): Promise<{ version: string | null; ok: boolean }> {
  let output: string
  try {
    const result = await exec('ldd', ['--version'], { timeoutMs: 10_000 })
    output = `${result.stdout}\n${result.stderr}`.trim()
  } catch {
    return { version: null, ok: false }
  }
  // `ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35`, `ldd (GNU libc) 2.40`.
  const first = output.split('\n')[0] ?? ''
  const match = /(?:glibc|gnu libc).*?\s(\d+)\.(\d+)\s*$/i.exec(first)
  if (!match) return { version: null, ok: false }
  const major = Number(match[1])
  const minor = Number(match[2])
  const ok = major > MIN_GLIBC[0] || (major === MIN_GLIBC[0] && minor >= MIN_GLIBC[1])
  return { version: `${match[1]}.${match[2]}`, ok }
}

/** What every release replaces for sure: `lib/` and the programs at the root. */
async function removePrograms(installRoot: string): Promise<void> {
  await rm(path.join(installRoot, 'lib'), { recursive: true, force: true })
  for (const name of await readdir(installRoot).catch(() => [] as string[])) {
    if (isProgram(name) && !(await lstat(path.join(installRoot, name))).isDirectory()) {
      await rm(path.join(installRoot, name), { force: true })
    }
  }
}

/** Copies `src` over `dest`, folder by folder; the root settings files already in `dest` stay. */
async function mergeTree(src: string, dest: string, rel: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await mergeTree(from, to, relPath)
      continue
    }
    if (KEPT_FILES.has(relPath) && (await pathExists(to))) continue
    // A new file rather than the old one rewritten in place.
    await rm(to, { force: true })
    if (entry.isSymbolicLink()) await symlink(await readlink(from), to)
    else await copyFile(from, to)
  }
}

/**
 * Updates the install folder `targetRoot` from the extracted release `stagingRoot` (both are
 * `Archipelago` folders), as the Windows installer does (brief §1.2): `lib/` and the programs at
 * the root go, then everything else is copied over. Files of the old version that the new one does
 * not ship stay, and so do `Players/`, `output/`, `custom_worlds/`, `logs/`, `host.yaml` and
 * `options.yaml` (the shipped templates of `Players/Templates` are replaced). Creates `targetRoot`
 * when missing; `stagingRoot` is left for the caller to remove.
 */
export async function applyLinuxUpdate(stagingRoot: string, targetRoot: string): Promise<void> {
  await removePrograms(targetRoot)
  await mergeTree(stagingRoot, targetRoot, '')
}

/** Files and links below `dir`, as paths relative to it with `/` separators. */
async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), relPath)))
    else files.push(relPath)
  }
  return files
}

/** A path of a release that an uninstall may delete: never a settings file or user data. */
function isRecordable(relPath: string): boolean {
  const [first = ''] = relPath.split('/')
  return !KEPT_FILES.has(relPath) && !USER_FOLDERS.has(first)
}

async function readRecord(file: string): Promise<string[] | null> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return recordSchema.parse(JSON.parse(text)).files
  } catch {
    return null
  }
}

/** The tar.gz keeps the modes, but the programs must run whatever happened on the way. */
async function ensureExecutables(installRoot: string): Promise<void> {
  const programs = (await readdir(installRoot)).filter(isProgram).map((name) => path.join(installRoot, name))
  for (const file of [...programs, path.join(installRoot, 'SNI', 'sni')]) {
    const info = await stat(file).catch(() => null)
    if (info?.isFile() && (info.mode & 0o111) !== 0o111) await chmod(file, (info.mode & 0o777) | 0o755)
  }
}

export interface LinuxInstallOptions {
  release: ApRelease
  /** The folder that receives `Archipelago/`. Default: `dataRoot/archipelago`, the managed copy. */
  targetRoot?: string
  /** Default: a locator of `ctx`. */
  locator?: Pick<Locator, 'fromRoot'>
  /** Runs right before the files change (the service checks that no Archipelago program runs). */
  beforeInstall?: () => Promise<void>
}

/**
 * Downloads and verifies the tar.gz (task stages `download`, `verify`), backs up the settings of the
 * install already in `targetRoot/Archipelago` (`backup`), then extracts the release to
 * `targetRoot/.staging-<version>` and applies it (`install`). Returns the install, of kind
 * `linux-managed` in the default folder and `custom` anywhere else.
 */
export async function installLinux(
  ctx: CoreContext,
  opts: LinuxInstallOptions,
  task: TaskHandle,
): Promise<ApInstall> {
  const managedRoot = path.join(ctx.platform.paths.dataRoot, 'archipelago')
  const targetRoot = opts.targetRoot ?? managedRoot
  const kind = path.resolve(targetRoot) === path.resolve(managedRoot) ? 'linux-managed' : 'custom'
  const locator = opts.locator ?? createLocator(ctx)
  const installRoot = path.join(targetRoot, AP_FOLDER)

  const asset = opts.release.linuxTarGz
  if (!asset) throw new AppError('NOT_FOUND', undefined, { detail: 'the release has no Linux tar.gz' })
  const archive = await fetchReleaseAsset(ctx, asset, task)

  task.progress('backup', null)
  const existing = await locator.fromRoot(installRoot, kind).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'AP_NOT_INSTALLED') return null
    throw error
  })
  if (existing) await backupApData(ctx, existing, { label: 'ap-install' })

  await opts.beforeInstall?.()
  throwIfCancelled(task.signal)
  task.progress('install', null)
  const glibc = await checkGlibc(ctx.exec)
  if (!glibc.ok) ctx.log.warn('installer: Archipelago needs glibc 2.35 or newer', { glibc: glibc.version })

  const staging = path.join(targetRoot, `.staging-${opts.release.version.replace(/[^\w.-]/g, '_')}`)
  await rm(staging, { recursive: true, force: true })
  try {
    await extractTarGzSafe(archive, staging)
    const staged = path.join(staging, AP_FOLDER)
    if (
      !(await stat(staged).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    ) {
      throw new AppError('INSTALL_FAILED', undefined, { detail: `the archive has no ${AP_FOLDER} folder` })
    }
    const shipped = (await listFiles(staged)).filter(isRecordable)
    await applyLinuxUpdate(staged, installRoot)
    await ensureExecutables(installRoot)
    // Files an older release brought and this one does not are still there: keep them recorded.
    const recordFile = path.join(targetRoot, RECORD_FILE)
    const files = [...new Set([...((await readRecord(recordFile)) ?? []), ...shipped])]
    await writeFileAtomic(recordFile, JSON.stringify({ files }))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
  return locator.fromRoot(installRoot, kind)
}

/**
 * The absolute path of a file of the record, which is read back from disk: PATH_FORBIDDEN for a path
 * that is empty, absolute, or holds `.` or `..`, so that it can only name a file inside the install.
 */
function recordedPath(installRoot: string, file: string): string {
  if (file.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new AppError('PATH_FORBIDDEN', { reason: 'traversal' }, { detail: file })
  }
  return safeJoin(installRoot, file)
}

/** Removes the folders the record leads through, deepest first, when they are left empty. */
async function pruneEmptyFolders(installRoot: string, files: string[]): Promise<void> {
  const folders = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    for (let i = parts.length - 1; i > 0; i--) folders.add(parts.slice(0, i).join('/'))
  }
  const deepestFirst = [...folders].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const folder of deepestFirst) await rmdir(recordedPath(installRoot, folder)).catch(() => undefined)
}

/**
 * Uninstalls the copy the app installed: the files its record lists go (without a record, `lib/` and
 * the programs), the rest stays. `purgeUserData` backs up the settings and the added worlds, then
 * deletes what `purgeApUserData` lists. The folders left empty are removed.
 */
export async function uninstallLinux(
  ctx: CoreContext,
  install: ApInstall,
  { purgeUserData }: { purgeUserData: boolean },
): Promise<void> {
  const installRoot = install.root
  const container = path.dirname(installRoot)
  const recordFile = path.join(container, RECORD_FILE)
  const recorded = await readRecord(recordFile)
  // Every path is checked before anything is deleted.
  for (const file of recorded ?? []) recordedPath(installRoot, file)
  const files = (recorded ?? []).filter(isRecordable)
  if (purgeUserData) {
    userDataTargets(install.paths)
    await backupApData(ctx, install, { label: 'ap-uninstall', worldFiles: true })
  }

  if (recorded === null) {
    await removePrograms(installRoot)
  } else {
    for (const file of files) await rm(recordedPath(installRoot, file), { force: true })
    await pruneEmptyFolders(installRoot, files)
  }
  await rm(recordFile, { force: true })

  if (purgeUserData) await purgeApUserData(install.paths)
  await rmdir(installRoot).catch(() => undefined)
  await rmdir(container).catch(() => undefined)
}
