// app:* handlers (app:pendingOpenRequests belongs to Task 21 and lives in ipc/system.ts).
import { readdir, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { assertUserPath } from '@main/core/system/user-path'
import type { ServiceContainer } from '@main/services/registry'
import type {} from '@main/services/updater.service'
import { AppError } from '@shared/errors'
import { isAllowedExternalUrl } from '@shared/external-url'
import type { RegisterHandler } from './registry'

const GITHUB_TOKEN = 'github.token'

/** Files that app:openPath hands to the OS: documents only, never anything it could execute. */
const OPENABLE_FILES = new Set(['.txt', '.log', '.yaml', '.yml', '.json', '.zip'])

async function emptyDir(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await Promise.all(names.map((name) => rm(join(dir, name), { recursive: true, force: true, maxRetries: 3 })))
}

export default function registerAppHandlers(register: RegisterHandler, services: ServiceContainer): void {
  const { ctx } = services
  const { platform, config, secrets, paths, lifecycle } = ctx

  register('app:getInfo', () =>
    Promise.resolve({
      version: platform.appVersion,
      os: platform.os,
      locale: platform.locale,
      isPackaged: platform.isPackaged,
      userData: platform.paths.userData,
      dataRoot: platform.paths.dataRoot,
      // What About says of the automatic updates (spec §8).
      updater: services.get('updater').state,
    }),
  )

  register('app:getConfig', () => Promise.resolve(config.get()))

  register('app:setConfig', (patch) => Promise.resolve(config.update(patch)))

  register('app:openPath', async (input) => {
    const path = await assertUserPath(input.path, { mustExist: false })
    if (!(await paths.isAllowed(path))) {
      throw new AppError('PATH_FORBIDDEN', { reason: 'outside-allowed-roots' }, { detail: path })
    }
    const info = await stat(path).catch(() => null)
    if (!info) throw new AppError('NOT_FOUND', undefined, { detail: path })
    if (!info.isDirectory() && !OPENABLE_FILES.has(extname(path).toLowerCase())) {
      throw new AppError('PATH_FORBIDDEN', { reason: 'file-type' }, { detail: path })
    }
    await platform.openPath(path)
  })

  register('app:openExternal', async ({ url }) => {
    if (!isAllowedExternalUrl(url)) throw new AppError('PATH_FORBIDDEN', { reason: 'url' }, { detail: url })
    await platform.openExternal(new URL(url).href)
  })

  register('app:pickPaths', (opts) => platform.showOpenDialog(opts))

  register('app:savePath', (opts) => platform.showSaveDialog(opts))

  register('app:confirmQuit', ({ requestId, confirm }) => {
    lifecycle.confirmQuit(requestId, confirm)
    return Promise.resolve()
  })

  register('app:setGithubToken', ({ token }) => {
    secrets.set(GITHUB_TOKEN, token)
    return Promise.resolve({ hasToken: secrets.has(GITHUB_TOKEN) })
  })

  register('app:secretsStatus', () =>
    Promise.resolve({ canEncrypt: platform.canEncrypt(), hasGithubToken: secrets.has(GITHUB_TOKEN) }),
  )

  register('app:clearData', async ({ targets }) => {
    for (const target of new Set(targets)) await emptyDir(join(platform.paths.dataRoot, target))
  })
}
