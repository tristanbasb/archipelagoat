// Installation of APWorlds (spec §3.9): from a file, a link or the catalog. `prepare` stages a copy,
// inspects it and builds the plan the trust screen shows; `confirm` installs exactly what was
// inspected. Also switches worlds on and off and removes them. Nothing here ever runs a world.
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CoreContext } from '@main/core/context'
import type { Locator } from '@main/core/ap/locator'
import { listApProcesses, type ProcessInfo } from '@main/core/ap/processes'
import { sha256File } from '@main/core/system/archive'
import { download } from '@main/core/system/downloads'
import { backupFile, moveFile, pathExists, safeJoin, writeStreamAtomic } from '@main/core/system/fsx'
import { assertUserPath } from '@main/core/system/user-path'
import type { TaskHandle } from '@main/core/tasks'
import type { IssueCode } from '@shared/codes'
import { AppError } from '@shared/errors'
import type {
  ApInstall,
  CatalogEntry,
  TrustTier,
  WorldInfo,
  WorldInstallPlan,
  WorldSource,
} from '@shared/types'
import {
  AP_CONTAINER_VERSION,
  inspectApworld,
  isPortableFileName,
  isSafeModule,
  readApworld,
  type ApworldInspection,
} from './apworld'
import {
  apRangeViolation,
  computeStates,
  disabledWorldsDir,
  NOT_LOADED_STATES,
  scanWorlds,
  worldId,
} from './inventory'
import type { WikiReleaseResolver } from './wiki-release'

/** A plan not confirmed within this delay is dropped, with its staged file. */
export const PLAN_TTL_MS = 60 * 60 * 1000

export interface WorldInstallerDeps {
  locator: Pick<Locator, 'detect'>
  /** The catalog entry of an id, null when unknown (Task 11 provides it). */
  lookupCatalog: (id: string) => CatalogEntry | null
  /** The release of a world the wiki alone lists (`resolveWikiRelease`), asked when it is installed. */
  resolveWikiRelease: WikiReleaseResolver
  /** The Archipelago programs running (`restartNeeded`). Default: `listApProcesses`. */
  listProcesses?: () => Promise<ProcessInfo[]>
  /** The clock of plan expiry. Default: `Date.now`. */
  now?: () => number
}

export interface WorldInstaller {
  /** Every world, with its states; [] when Archipelago is not installed. */
  list(): Promise<WorldInfo[]>
  /** Stages and inspects the world; the plan stays valid for `PLAN_TTL_MS`. */
  prepare(source: WorldSource, task: TaskHandle): Promise<WorldInstallPlan>
  confirm(planId: string): Promise<{ world: WorldInfo; restartNeeded: boolean }>
  /** Moves a world between `customWorlds` and `dataRoot/disabled-worlds`. */
  setEnabled(worldId: string, enabled: boolean): Promise<WorldInfo>
  /** Moves a world to `dataRoot/backups` (it can be put back from there). */
  remove(worldId: string): Promise<void>
}

interface PendingPlan {
  plan: WorldInstallPlan
  staged: string
  expiresAt: number
}

interface Staged {
  file: string
  source: WorldSource
  entry: CatalogEntry | null
  /** The link a catalog world was downloaded from. */
  origin: string | null
}

const forbidden = (reason: string, detail: string): AppError =>
  new AppError('PATH_FORBIDDEN', { reason }, { detail })

/** Downloads are code: https only. */
function httpsUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError('INVALID_INPUT', undefined, { detail: 'not a url' })
  }
  if (url.protocol !== 'https:') {
    throw new AppError('INVALID_INPUT', undefined, { detail: `unsupported protocol ${url.protocol}` })
  }
  return raw
}

/**
 * The asset name of a link (`…/foo-v1.2.apworld` → `foo-v1.2.apworld`): the inspection checks that
 * it holds the module name, as Archipelago checks the file name.
 */
function assetName(raw: string): string {
  const segment = new URL(raw).pathname.split('/').at(-1) ?? ''
  let name: string
  try {
    name = decodeURIComponent(segment)
  } catch {
    name = segment
  }
  name = name.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').replace(/[. ]+$/, '')
  if (!/\.apworld$/i.test(name)) name = `${name}.apworld`
  // `con.apworld` names a device on Windows: such a link gets a neutral name (and fails the name check).
  return isPortableFileName(name) ? name : 'world.apworld'
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('TASK_CANCELLED')
}

/** Checks Archipelago does not make on install (spec §3.9). */
function checkCompatibility({ manifest }: ApworldInspection, apVersion: string | null): void {
  const compatible = manifest?.compatibleVersion ?? null
  if (compatible !== null && compatible > AP_CONTAINER_VERSION) {
    throw new AppError('WORLD_INCOMPATIBLE', { reason: 'compatible-version', value: compatible })
  }
  const violation = apRangeViolation(manifest, apVersion)
  if (violation && apVersion !== null) {
    throw new AppError('WORLD_INCOMPATIBLE', {
      reason: 'ap-version',
      ...(violation.min === null ? {} : { min: violation.min }),
      ...(violation.max === null ? {} : { max: violation.max }),
      installed: apVersion,
    })
  }
}

export function createWorldInstaller(ctx: CoreContext, deps: WorldInstallerDeps): WorldInstaller {
  const { dataRoot } = ctx.platform.paths
  const disabledDir = disabledWorldsDir(dataRoot)
  const backupsDir = path.join(dataRoot, 'backups')
  const stagingRoot = path.join(dataRoot, 'downloads', 'worlds')
  const now = deps.now ?? Date.now
  const listProcesses = deps.listProcesses ?? (() => listApProcesses(ctx.exec, ctx.platform.os))
  const plans = new Map<string, PendingPlan>()
  // Plans live in memory: whatever an earlier run staged is stale.
  const cleaned = rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)

  const fold = (p: string): string => (ctx.platform.os === 'win32' ? p.toLowerCase() : p)
  const samePath = (a: string, b: string): boolean => fold(a) === fold(b)

  async function requireInstall(): Promise<ApInstall> {
    const install = await deps.locator.detect()
    if (!install) throw new AppError('AP_NOT_INSTALLED')
    return install
  }

  const scan = (install: ApInstall): Promise<WorldInfo[]> =>
    scanWorlds(install.paths, disabledDir, install.version)

  async function findWorld(id: string): Promise<{ install: ApInstall; world: WorldInfo }> {
    const install = await requireInstall()
    const world = (await scan(install)).find((w) => w.id === id)
    if (!world) throw new AppError('NOT_FOUND', undefined, { detail: id })
    return { install, world }
  }

  /** The world now at `file`, after a change. */
  async function worldAt(install: ApInstall, file: string): Promise<WorldInfo> {
    const world = (await scan(install)).find((w) => w.id === worldId(file))
    if (!world) throw new AppError('NOT_FOUND', undefined, { detail: file })
    return world
  }

  async function discard(planId: string): Promise<void> {
    plans.delete(planId)
    await rm(path.join(stagingRoot, planId), { recursive: true, force: true }).catch(() => undefined)
  }

  async function dropExpired(): Promise<void> {
    for (const [planId, pending] of plans) if (pending.expiresAt <= now()) await discard(planId)
  }

  async function fetchTo(dir: string, url: string, sha256: string | null, task: TaskHandle): Promise<string> {
    task.progress('download', 0)
    const dest = safeJoin(dir, assetName(url))
    await download(ctx.http, {
      url,
      dest,
      sha256,
      signal: task.signal,
      onProgress: ({ received, total }) =>
        task.progress('download', total ? Math.min(100, Math.round((received * 100) / total)) : null),
    })
    return dest
  }

  /** Puts the world in `dir`, under its original name (the inspection checks that name). */
  async function stage(source: WorldSource, dir: string, task: TaskHandle): Promise<Staged> {
    if (source.kind === 'file') {
      const file = await assertUserPath(source.path, { kind: 'file', exts: ['.apworld'] })
      const staged = path.join(dir, path.basename(file))
      await copyFile(file, staged)
      return { file: staged, source: { kind: 'file', path: file }, entry: null, origin: null }
    }
    if (source.kind === 'url') {
      const url = httpsUrl(source.url)
      return { file: await fetchTo(dir, url, null, task), source, entry: null, origin: null }
    }
    const entry = deps.lookupCatalog(source.id)
    let release = entry?.latest ?? null
    // A world only the wiki lists: the latest release its page points to, asked now.
    if (entry && release === null && entry.download?.kind === 'github-latest') {
      task.progress('download', null)
      const { repo, pageUrl } = entry.download
      release = await deps.resolveWikiRelease(repo, entry.game, pageUrl)
      throwIfCancelled(task.signal)
    }
    if (!entry || release === null) throw new AppError('NOT_FOUND', undefined, { detail: source.id })
    const url = httpsUrl(release.url)
    return { file: await fetchTo(dir, url, release.sha256, task), source, entry, origin: url }
  }

  /**
   * The existing worlds the new one replaces or competes with and, for each one, which of the two
   * Archipelago loads. The winner is decided head to head: Archipelago's load order ranks any two
   * worlds the same way whatever else is installed. A rival Archipelago never loads (disabled,
   * corrupt, outside its AP range) competes with nothing and is left out.
   */
  function findConflicts(
    worlds: WorldInfo[],
    candidate: WorldInfo,
    apVersion: string | null,
  ): WorldInstallPlan['conflicts'] {
    type Conflict = WorldInstallPlan['conflicts'][number]
    const conflict = (world: WorldInfo, winner: Conflict['winner']): Conflict => ({
      worldId: world.id,
      version: world.manifest?.worldVersion ?? null,
      winner,
    })
    const replaced: Conflict[] = []
    const rivals: Conflict[] = []
    for (const world of worlds) {
      if (world.location === 'custom' && samePath(world.path, candidate.path)) {
        replaced.push(conflict(world, 'new'))
        continue
      }
      if (candidate.game === null || world.game !== candidate.game) continue
      const [rival, challenger] = computeStates([world, candidate], apVersion)
      // A rival Archipelago never loads cannot conflict with the new world.
      if (!rival || !challenger || rival.states.some((state) => NOT_LOADED_STATES.has(state))) continue
      rivals.push(conflict(world, challenger.states.includes('shadowed') ? 'existing' : 'new'))
    }
    return [...replaced, ...rivals]
  }

  async function isApRunning(): Promise<boolean> {
    try {
      return (await listProcesses()).length > 0
    } catch (error) {
      ctx.log.warn('worlds: cannot list the archipelago programs', error)
      return false
    }
  }

  /** Copies `src` to `dest` atomically, then deletes `src` (works across volumes). */
  async function place(src: string, dest: string): Promise<void> {
    await writeStreamAtomic(dest, createReadStream(src))
    await rm(src)
  }

  const changed = (): void => ctx.bus.emit('worlds:changed', null)

  return {
    async list() {
      const install = await deps.locator.detect()
      return install ? scan(install) : []
    },

    async prepare(source, task) {
      await cleaned
      await dropExpired()
      const install = await requireInstall()
      const planId = randomUUID()
      const dir = path.join(stagingRoot, planId)
      await mkdir(dir, { recursive: true })
      try {
        const staged = await stage(source, dir, task)
        throwIfCancelled(task.signal)
        task.progress('inspect', null)
        const inspection = await inspectApworld(staged.file)
        checkCompatibility(inspection, install.version)

        const targetFileName = `${inspection.module}.apworld`
        const target = path.join(install.paths.customWorlds, targetFileName)
        const valid = inspection.manifestError === null ? inspection.manifest : null
        const candidate: WorldInfo = {
          id: worldId(target),
          fileName: targetFileName,
          path: target,
          location: 'custom',
          module: inspection.module,
          game: inspection.manifest?.game ?? null,
          manifest: valid,
          states: [],
          sizeBytes: inspection.sizeBytes,
        }
        const conflicts = findConflicts(await scan(install), candidate, install.version)
        const warnings: IssueCode[] = []
        if (valid === null) warnings.push('world-no-manifest')
        if (conflicts.length > 0) warnings.push('world-version-conflict')
        const trust: TrustTier = staged.entry?.trust ?? 'unknown'

        const plan: WorldInstallPlan = {
          planId,
          source: staged.source,
          module: inspection.module,
          targetFileName,
          manifest: inspection.manifest,
          sha256: inspection.sha256,
          trust,
          homepage: staged.entry?.homepage ?? null,
          origin: staged.origin,
          conflicts,
          warnings,
        }
        plans.set(planId, { plan, staged: staged.file, expiresAt: now() + PLAN_TTL_MS })
        return plan
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    },

    async confirm(planId) {
      await dropExpired()
      const pending = plans.get(planId)
      if (!pending) throw new AppError('NOT_FOUND', undefined, { detail: planId })
      // A plan is used once, whatever happens next.
      plans.delete(planId)
      const { plan, staged } = pending
      try {
        const install = await requireInstall()
        const actual = await sha256File(staged)
        if (actual !== plan.sha256) {
          throw new AppError(
            'DOWNLOAD_HASH_MISMATCH',
            { expected: plan.sha256, actual },
            { detail: 'staged' },
          )
        }
        // The module was checked by the inspection: the name stays inside customWorlds.
        const target = path.join(install.paths.customWorlds, plan.targetFileName)
        if (await pathExists(target)) await backupFile(target, backupsDir, `world-${plan.module}`)
        await writeStreamAtomic(target, createReadStream(staged))
        changed()
        const restartNeeded = await isApRunning()
        return { world: await worldAt(install, target), restartNeeded }
      } finally {
        await discard(planId)
      }
    },

    async setEnabled(id, enabled) {
      const { install, world } = await findWorld(id)
      if (world.location === 'core') throw forbidden('core', world.path || world.fileName)
      // Enabling a world Archipelago cannot import for its file name puts it back under its module.
      const misnamed = enabled && world.location === 'custom' && world.states.includes('bad-name')
      if (enabled === (world.location === 'custom') && !misnamed) return world
      if (!world.fileName.endsWith('.apworld')) throw forbidden('not-a-file', world.path)

      let dest: string
      if (enabled) {
        // A corrupt file stays out: Archipelago would stop on it.
        await readApworld(world.path)
        if (!isSafeModule(world.module)) {
          throw new AppError('WORLD_INVALID', { reason: 'traversal' }, { detail: world.module })
        }
        // Back under the name its module needs; a world already there takes its place outside.
        dest = path.join(install.paths.customWorlds, `${world.module}.apworld`)
        if (await pathExists(dest)) await moveFile(dest, disabledDir)
        await place(world.path, dest)
      } else {
        dest = await moveFile(world.path, disabledDir)
      }
      changed()
      return worldAt(install, dest)
    },

    async remove(id) {
      const { world } = await findWorld(id)
      if (world.location === 'core') throw forbidden('core', world.path || world.fileName)
      if (!world.fileName.endsWith('.apworld')) throw forbidden('not-a-file', world.path)
      await backupFile(world.path, backupsDir, `world-${world.module}`)
      await rm(world.path)
      changed()
    },
  }
}
