// Steps the Windows and Linux installers share (spec §3.4-3.5): the verified download of a release
// asset, the backup of Archipelago's settings and list of worlds, the quarantine of corrupt worlds,
// and the removal of the user data a full uninstall promises to delete. Backups and quarantined
// worlds go to the app's own folders, never into Archipelago's.
import { copyFile, cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CoreContext } from '@main/core/context'
import { sha256File } from '@main/core/system/archive'
import { download } from '@main/core/system/downloads'
import { backupFile, moveFile, pathExists, safeJoin } from '@main/core/system/fsx'
import type { TaskHandle } from '@main/core/tasks'
import { disabledWorldsDir, scanWorlds } from '@main/core/worlds/inventory'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths, ReleaseAsset } from '@shared/types'

/** The settings files Archipelago may load from its user folder (brief C3). */
const SETTINGS_FILES = ['host.yaml', 'options.yaml'] as const

/** In each backup: the names in the custom worlds folder, as `{ "customWorlds": [...] }`. */
const WORLD_LIST_FILE = 'custom-worlds.json'

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('TASK_CANCELLED')
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then(
    (info) => info.isFile(),
    () => false,
  )
}

/**
 * Downloads a release asset to `dataRoot/downloads/<name>` (task stages `download`, then `verify`)
 * and returns its path. A copy already there whose SHA-256 is the release's is used as is. An asset
 * without a digest (GitHub has none for older uploads) is checked by size only: it still comes from
 * the official release, over https.
 */
export async function fetchReleaseAsset(
  ctx: CoreContext,
  asset: ReleaseAsset,
  task: TaskHandle,
): Promise<string> {
  const dest = safeJoin(path.join(ctx.platform.paths.dataRoot, 'downloads'), asset.name)
  task.progress('download', 0)
  if (asset.sha256 !== null && (await pathExists(dest)) && (await sha256File(dest)) === asset.sha256) {
    task.progress('verify', 100)
    return dest
  }
  if (asset.sha256 === null)
    ctx.log.warn('installer: the release gives no sha256, checking the size only', asset)
  await download(ctx.http, {
    url: asset.url,
    dest,
    sha256: asset.sha256,
    expectedSize: asset.size,
    signal: task.signal,
    onProgress: ({ received, total }) => {
      // Once every byte is in, download() is hashing the file.
      if (total !== null && received >= total) task.progress('verify', null)
      else task.progress('download', total ? Math.floor((received * 100) / total) : null)
    },
  })
  task.progress('verify', 100)
  return dest
}

/** What Archipelago would pick up in its custom worlds folder: names starting with `.` or `_` are skipped. */
async function customWorldNames(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((name) => !name.startsWith('.') && !name.startsWith('_')).sort()
}

/**
 * Backs up the settings files of `install` (`host.yaml` and `options.yaml` of its user folder, and
 * the file it loads) and the list of its custom worlds, into one `dataRoot/backups/<stamp>-<label>`
 * folder whose path is returned. `worldFiles` copies the worlds themselves too, under
 * `custom_worlds/`. Returns null, and writes nothing, when there is nothing to back up.
 */
export async function backupApData(
  ctx: CoreContext,
  install: ApInstall,
  opts: { label: string; worldFiles?: boolean },
): Promise<string | null> {
  const { paths } = install
  const candidates = [...SETTINGS_FILES.map((name) => path.join(paths.userPath, name)), paths.settingsFile]
  const unique = [...new Map(candidates.map((file) => [path.resolve(file), file])).values()]
  const settings: string[] = []
  for (const file of unique) if (await isFile(file)) settings.push(file)
  const worlds = await customWorldNames(paths.customWorlds)
  if (settings.length === 0 && worlds.length === 0) return null

  // backupFile makes the timestamped folder: the list goes first, the rest joins it.
  const tmp = await mkdtemp(path.join(ctx.platform.paths.temp, 'goat-backup-'))
  try {
    const list = path.join(tmp, WORLD_LIST_FILE)
    await writeFile(list, `${JSON.stringify({ customWorlds: worlds }, null, 2)}\n`)
    const dir = path.dirname(
      await backupFile(list, path.join(ctx.platform.paths.dataRoot, 'backups'), opts.label),
    )
    const taken = new Set<string>([WORLD_LIST_FILE])
    for (const file of settings) {
      const name = path.basename(file)
      if (taken.has(name)) continue
      taken.add(name)
      await copyFile(file, path.join(dir, name))
    }
    if (opts.worldFiles) {
      for (const name of worlds) {
        await cp(path.join(paths.customWorlds, name), path.join(dir, 'custom_worlds', name), {
          recursive: true,
          verbatimSymlinks: true,
        })
      }
    }
    return dir
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Moves the custom worlds that cannot be read as zips to `dataRoot/disabled-worlds`, where the app
 * lists them as disabled: the hidden `--update_settings` step of the installer would otherwise stop
 * on them behind an invisible dialog (brief §4.3). Returns their new paths.
 */
export async function quarantineCorruptWorlds(ctx: CoreContext, install: ApInstall): Promise<string[]> {
  const disabledDir = disabledWorldsDir(ctx.platform.paths.dataRoot)
  const worlds = await scanWorlds(install.paths, disabledDir, install.version)
  const moved: string[] = []
  for (const world of worlds) {
    if (world.location !== 'custom' || !world.states.includes('corrupt')) continue
    const dest = await moveFile(world.path, disabledDir)
    ctx.log.warn('installer: corrupt world moved out of the way', { from: world.path, to: dest })
    moved.push(dest)
  }
  return moved
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * What a full uninstall deletes, as the install screen promises, and nothing else: the player YAMLs
 * (`Players/`), the generated games (`output/`), the added worlds, the logs and the settings files
 * of the user folder. ROMs and any other file stay. Throws PATH_FORBIDDEN when one of them is not
 * inside the user folder; the uninstallers call it before they change anything.
 */
export function userDataTargets(paths: ApPaths): string[] {
  const targets = [
    paths.players,
    paths.output,
    paths.customWorlds,
    paths.logs,
    ...SETTINGS_FILES.map((name) => path.join(paths.userPath, name)),
  ]
  const outside = path.isAbsolute(paths.userPath)
    ? targets.find((target) => !isInside(target, paths.userPath))
    : paths.userPath
  if (outside !== undefined)
    throw new AppError('PATH_FORBIDDEN', { reason: 'traversal' }, { detail: outside })
  return targets
}

/** Deletes the `userDataTargets` of `paths`. */
export async function purgeApUserData(paths: ApPaths): Promise<void> {
  for (const target of userDataTargets(paths))
    await rm(target, { recursive: true, force: true, maxRetries: 3 })
}
