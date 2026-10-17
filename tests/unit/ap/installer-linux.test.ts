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
import { dirname, join, posix } from 'node:path'
import { applyLinuxUpdate, checkGlibc, installLinux, uninstallLinux } from '@main/core/ap/installer-linux'
import type { ExecFn } from '@main/core/exec'
import { createHttp } from '@main/core/system/http'
import type { TaskHandle } from '@main/core/tasks'
import { AppError } from '@shared/errors'
import type { ApRelease } from '@shared/types'
import { createTestContext, silentLogger, type TestCore } from '../../helpers/core'
import { fetchVia, reply, startTestServer, type TestServer } from '../../helpers/http-server'
import { AP_LINUX_RELEASE_ITEMS as RELEASE_ITEMS, tarGz } from '../../helpers/make-targz'

const TGZ_URL =
  'https://github.com/ArchipelagoMW/Archipelago/releases/download/0.6.8/Archipelago_0.6.8_linux-x86_64.tar.gz'

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Files below `dir`, as sorted paths relative to it with `/` separators. */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(dir, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
    .sort()
}

function write(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

const ok = (stdout: string): ReturnType<ExecFn> => Promise.resolve({ code: 0, stdout, stderr: '' })

describe('checkGlibc', () => {
  it('reads the version from ldd --version and requires 2.35', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const exec =
      (stdout: string): ExecFn =>
      (cmd, args) => {
        calls.push({ cmd, args })
        return ok(stdout)
      }
    const ubuntu =
      'ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35\nCopyright (C) 2022 Free Software Foundation, Inc.\n'
    expect(await checkGlibc(exec(ubuntu))).toEqual({ version: '2.35', ok: true })
    expect(calls[0]).toEqual({ cmd: 'ldd', args: ['--version'] })
    expect(await checkGlibc(exec('ldd (GNU libc) 2.40\nCopyright (C) 2024\n'))).toEqual({
      version: '2.40',
      ok: true,
    })
    expect(await checkGlibc(exec('ldd (Debian GLIBC 2.31-13+deb11u11) 2.31\n'))).toEqual({
      version: '2.31',
      ok: false,
    })
    expect(await checkGlibc(exec('ldd (GNU libc) 3.1\n'))).toEqual({ version: '3.1', ok: true })
  })

  it('reports an unknown version for musl and for a missing ldd', async () => {
    // musl's ldd prints its own version on stderr and exits with 1: that is not a glibc version.
    const musl: ExecFn = () =>
      Promise.resolve({ code: 1, stdout: '', stderr: 'musl libc (x86_64)\nVersion 1.2.4\n' })
    expect(await checkGlibc(musl)).toEqual({ version: null, ok: false })
    const missing: ExecFn = () =>
      Promise.reject(Object.assign(new Error('spawn ldd ENOENT'), { code: 'ENOENT' }))
    expect(await checkGlibc(missing)).toEqual({ version: null, ok: false })
  })
})

describe('applyLinuxUpdate', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goat linux update é-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('linux update preserves Players, custom_worlds and host.yaml and replaces lib', async () => {
    const target = join(root, 'archipelago', 'Archipelago')
    write(join(target, 'ArchipelagoLauncher'), 'launcher 0.6.7')
    write(join(target, 'ArchipelagoRetiredTool'), 'gone in 0.6.8')
    write(join(target, 'lib', 'libold.so'), 'old')
    write(join(target, 'lib', 'worlds', 'override', '__init__.py'), 'deleted like deletelib does')
    write(join(target, 'data', 'old.txt'), 'kept, like the Windows installer keeps it')
    write(join(target, 'Players', 'Ann.yaml'), 'name: Ann')
    write(join(target, 'Players', 'Templates', 'A Link to the Past.yaml'), 'old template')
    write(join(target, 'custom_worlds', 'foo.apworld'), 'world')
    write(join(target, 'output', 'AP_123.zip'), 'game')
    write(join(target, 'logs', 'Launcher.txt'), 'log')
    write(join(target, 'host.yaml'), 'mine: true')
    write(join(target, 'options.yaml'), 'mine: too')
    write(join(target, 'Zelda.sfc'), 'rom')

    const staging = join(root, 'archipelago', '.staging-0.6.8', 'Archipelago')
    write(join(staging, 'ArchipelagoLauncher'), 'launcher 0.6.8')
    write(join(staging, 'lib', 'libssl.so.3'), 'ssl 3')
    write(join(staging, 'data', 'new.txt'), 'new')
    write(join(staging, 'Players', 'Templates', 'A Link to the Past.yaml'), 'new template')
    // A release never ships a settings file; if one did, the user's own would still win.
    write(join(staging, 'host.yaml'), 'shipped: true')

    await applyLinuxUpdate(staging, target)

    expect(tree(target)).toEqual([
      'ArchipelagoLauncher',
      'Players/',
      'Players/Ann.yaml',
      'Players/Templates/',
      'Players/Templates/A Link to the Past.yaml',
      'Zelda.sfc',
      'custom_worlds/',
      'custom_worlds/foo.apworld',
      'data/',
      'data/new.txt',
      'data/old.txt',
      'host.yaml',
      'lib/',
      'lib/libssl.so.3',
      'logs/',
      'logs/Launcher.txt',
      'options.yaml',
      'output/',
      'output/AP_123.zip',
    ])
    expect(readFileSync(join(target, 'ArchipelagoLauncher'), 'utf8')).toBe('launcher 0.6.8')
    expect(readFileSync(join(target, 'Players', 'Templates', 'A Link to the Past.yaml'), 'utf8')).toBe(
      'new template',
    )
    expect(readFileSync(join(target, 'host.yaml'), 'utf8')).toBe('mine: true')
    expect(readFileSync(join(target, 'options.yaml'), 'utf8')).toBe('mine: too')
    // The staging copy is left for the caller to remove.
    expect(existsSync(join(staging, 'ArchipelagoLauncher'))).toBe(true)
  })

  it('creates the install folder when there is none yet', async () => {
    const staging = join(root, 'staging', 'Archipelago')
    write(join(staging, 'ArchipelagoLauncher'), 'launcher')
    write(join(staging, 'host.yaml'), 'shipped: true')
    const target = join(root, 'fresh', 'Archipelago')
    await applyLinuxUpdate(staging, target)
    expect(tree(target)).toEqual(['ArchipelagoLauncher', 'host.yaml'])
  })
})

describe('installLinux and uninstallLinux', () => {
  let root: string
  let core: TestCore
  let server: TestServer
  let archive: Buffer
  let task: TaskHandle & { progress: ReturnType<typeof vi.fn<TaskHandle['progress']>> }

  const dataRoot = (): string => core.ctx.platform.paths.dataRoot
  const container = (): string => join(dataRoot(), 'archipelago')
  const installRoot = (): string => join(container(), 'Archipelago')

  function release(tgz: Buffer, digest: string | null = sha256(tgz)): ApRelease {
    return {
      tag: '0.6.8',
      version: '0.6.8',
      publishedAt: '2026-10-04T16:20:11Z',
      notes: '',
      windows: null,
      appImage: null,
      linuxTarGz: {
        name: 'Archipelago_0.6.8_linux-x86_64.tar.gz',
        url: TGZ_URL,
        size: tgz.length,
        sha256: digest,
      },
    }
  }

  const stages = (): string[] =>
    task.progress.mock.calls.map(([stage]) => stage).filter((stage, i, all) => stage !== all[i - 1])

  const backups = (): string[] => {
    const dir = join(dataRoot(), 'backups')
    return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'goat linux install é-'))
    core = createTestContext(root, { os: 'linux' })
    archive = tarGz(RELEASE_ITEMS)
    server = await startTestServer((req, res) => {
      if (req.url === new URL(TGZ_URL).pathname) return reply(res, 200, archive)
      reply(res, 404)
    })
    core.ctx.http = createHttp({
      userAgent: 'Test/1.0 (unit)',
      cacheDir: join(root, 'cache'),
      log: silentLogger,
      githubToken: () => null,
      fetch: fetchVia(server, 'github.com'),
    })
    core.ctx.exec = () => ok('ldd (GNU libc) 2.39\n')
    task = {
      id: 'task-1',
      signal: new AbortController().signal,
      progress: vi.fn<TaskHandle['progress']>(),
      log: vi.fn<TaskHandle['log']>(),
    }
  })

  afterEach(async () => {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('linux install end-to-end from local tar.gz with sha256', async () => {
    const install = await installLinux(core.ctx, { release: release(archive) }, task)

    expect(install).toMatchObject({
      kind: 'linux-managed',
      version: '0.6.8',
      // The locator joins with `/` for Linux; on a Windows test host the root keeps its own separators.
      root: posix.normalize(installRoot()),
      appImagePath: null,
    })
    expect(tree(installRoot())).toEqual([
      'ArchipelagoGenerate',
      'ArchipelagoLauncher',
      'LICENSE',
      'Players/',
      'Players/Templates/',
      'Players/Templates/A Link to the Past.yaml',
      'SNI/',
      'SNI/sni',
      'data/',
      'data/sprites.txt',
      'lib/',
      'lib/libssl.so.3',
      'manifest.json',
    ])
    // The verified download stays in the cache; the staging folder is gone.
    const cached = join(dataRoot(), 'downloads', 'Archipelago_0.6.8_linux-x86_64.tar.gz')
    expect(readFileSync(cached)).toEqual(archive)
    expect(readdirSync(container()).filter((name) => name.startsWith('.staging'))).toEqual([])
    expect(stages()).toEqual(['download', 'verify', 'backup', 'install'])
    // Nothing to back up on a first install.
    expect(backups()).toEqual([])
    // Nothing was written in Archipelago's folder besides the release itself.
    expect(readdirSync(container()).sort()).toEqual(['Archipelago', 'archipelagoat-files.json'])
  })

  it('refuses a tar.gz whose sha256 differs, and installs nothing', async () => {
    const error = await failure(installLinux(core.ctx, { release: release(archive, 'ab'.repeat(32)) }, task))
    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(existsSync(installRoot())).toBe(false)
    expect(existsSync(join(dataRoot(), 'downloads', 'Archipelago_0.6.8_linux-x86_64.tar.gz'))).toBe(false)
  })

  it('checks the size alone when GitHub gives no digest', async () => {
    const install = await installLinux(core.ctx, { release: release(archive, null) }, task)
    expect(install.version).toBe('0.6.8')

    rmSync(container(), { recursive: true })
    rmSync(join(dataRoot(), 'downloads'), { recursive: true })
    const wrongSize = release(Buffer.alloc(archive.length + 1), null)
    const error = await failure(installLinux(core.ctx, { release: wrongSize }, task))
    expect(error.code).toBe('DOWNLOAD_HASH_MISMATCH')
    expect(existsSync(installRoot())).toBe(false)
  })

  it('refuses a release without a Linux archive', async () => {
    const error = await failure(
      installLinux(core.ctx, { release: { ...release(archive), linuxTarGz: null } }, task),
    )
    expect(error.code).toBe('NOT_FOUND')
    expect(server.requests).toEqual([])
  })

  it('refuses an archive without its Archipelago folder and leaves no staging behind', async () => {
    archive = tarGz([
      { path: 'Other/', type: 'Directory' },
      { path: 'Other/file', data: 'x' },
    ])
    const error = await failure(installLinux(core.ctx, { release: release(archive) }, task))
    expect(error.code).toBe('INSTALL_FAILED')
    expect(existsSync(installRoot())).toBe(false)
    expect(readdirSync(container())).toEqual([])
  })

  it('updates an existing install in place after backing up its settings', async () => {
    write(join(installRoot(), 'ArchipelagoLauncher'), 'launcher 0.6.7')
    write(join(installRoot(), 'manifest.json'), JSON.stringify({ version: [0, 6, 7] }))
    write(join(installRoot(), 'lib', 'libold.so'), 'old')
    write(join(installRoot(), 'host.yaml'), 'general_options: {}\n')
    write(join(installRoot(), 'Players', 'Ann.yaml'), 'name: Ann')
    write(join(installRoot(), 'custom_worlds', 'foo.apworld'), 'world')
    const beforeInstall = vi.fn(() => {
      // Runs once the backup is taken, before any file changes.
      expect(backups()).toHaveLength(1)
      expect(existsSync(join(installRoot(), 'lib', 'libold.so'))).toBe(true)
      return Promise.resolve()
    })

    const install = await installLinux(core.ctx, { release: release(archive), beforeInstall }, task)

    expect(beforeInstall).toHaveBeenCalledOnce()
    expect(install.version).toBe('0.6.8')
    expect(existsSync(join(installRoot(), 'lib', 'libold.so'))).toBe(false)
    expect(readFileSync(join(installRoot(), 'host.yaml'), 'utf8')).toBe('general_options: {}\n')
    expect(readFileSync(join(installRoot(), 'Players', 'Ann.yaml'), 'utf8')).toBe('name: Ann')
    expect(existsSync(join(installRoot(), 'custom_worlds', 'foo.apworld'))).toBe(true)
    const [backup] = backups()
    expect(backup).toMatch(/-ap-install$/)
    expect(readdirSync(backup ?? '').sort()).toEqual(['custom-worlds.json', 'host.yaml'])
    expect(JSON.parse(readFileSync(join(backup ?? '', 'custom-worlds.json'), 'utf8'))).toEqual({
      customWorlds: ['foo.apworld'],
    })
  })

  it('installs into another folder, under its Archipelago subfolder', async () => {
    const chosen = join(root, 'Jeux é')
    const install = await installLinux(core.ctx, { release: release(archive), targetRoot: chosen }, task)
    expect(install).toMatchObject({ kind: 'linux-targz', root: posix.normalize(join(chosen, 'Archipelago')) })
    expect(existsSync(join(chosen, 'Archipelago', 'ArchipelagoLauncher'))).toBe(true)
    expect(existsSync(installRoot())).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('makes the programs executable', async () => {
    archive = tarGz(
      RELEASE_ITEMS.map((item) =>
        item.path === 'Archipelago/ArchipelagoLauncher' || item.path === 'Archipelago/SNI/sni'
          ? { ...item, mode: 0o644 }
          : item,
      ),
    )
    await installLinux(core.ctx, { release: release(archive) }, task)
    expect(statSync(join(installRoot(), 'ArchipelagoLauncher')).mode & 0o777).toBe(0o755)
    expect(statSync(join(installRoot(), 'SNI', 'sni')).mode & 0o777).toBe(0o755)
    expect(statSync(join(installRoot(), 'LICENSE')).mode & 0o111).toBe(0)
  })

  describe('uninstallLinux', () => {
    async function installWithUserData(): Promise<Awaited<ReturnType<typeof installLinux>>> {
      const install = await installLinux(core.ctx, { release: release(archive) }, task)
      write(join(installRoot(), 'host.yaml'), 'general_options: {}\n')
      write(join(installRoot(), 'options.yaml'), 'generator: {}\n')
      write(join(installRoot(), 'Players', 'Ann.yaml'), 'name: Ann')
      write(join(installRoot(), 'custom_worlds', 'foo.apworld'), 'world')
      write(join(installRoot(), 'output', 'AP_123.zip'), 'game')
      write(join(installRoot(), 'logs', 'Launcher.txt'), 'log')
      // A ROM next to Archipelago, where its ROM paths resolve.
      write(join(installRoot(), 'Zelda.sfc'), 'rom')
      return install
    }

    it('removes the files it installed and keeps the user data', async () => {
      const install = await installWithUserData()

      await uninstallLinux(core.ctx, install, { purgeUserData: false })

      expect(tree(installRoot())).toEqual([
        'Players/',
        'Players/Ann.yaml',
        'Zelda.sfc',
        'custom_worlds/',
        'custom_worlds/foo.apworld',
        'host.yaml',
        'logs/',
        'logs/Launcher.txt',
        'options.yaml',
        'output/',
        'output/AP_123.zip',
      ])
      expect(existsSync(join(container(), 'archipelagoat-files.json'))).toBe(false)
      expect(backups()).toEqual([])
    })

    it('purge backs up, then removes the user data the screen lists and nothing else', async () => {
      const install = await installWithUserData()

      await uninstallLinux(core.ctx, install, { purgeUserData: true })

      expect(tree(installRoot())).toEqual(['Zelda.sfc'])
      const [backup] = backups()
      expect(backup).toMatch(/-ap-uninstall$/)
      expect(tree(backup ?? '')).toEqual([
        'custom-worlds.json',
        'custom_worlds/',
        'custom_worlds/foo.apworld',
        'host.yaml',
        'options.yaml',
      ])
    })

    it('leaves no folder behind when everything goes', async () => {
      const install = await installLinux(core.ctx, { release: release(archive) }, task)
      write(join(installRoot(), 'Players', 'Ann.yaml'), 'name: Ann')
      await uninstallLinux(core.ctx, install, { purgeUserData: true })
      expect(existsSync(container())).toBe(false)
    })

    it('without its record, removes lib and the programs only', async () => {
      const install = await installWithUserData()
      rmSync(join(container(), 'archipelagoat-files.json'))

      await uninstallLinux(core.ctx, install, { purgeUserData: false })

      expect(existsSync(join(installRoot(), 'lib'))).toBe(false)
      expect(existsSync(join(installRoot(), 'ArchipelagoLauncher'))).toBe(false)
      expect(existsSync(join(installRoot(), 'ArchipelagoGenerate'))).toBe(false)
      expect(existsSync(join(installRoot(), 'Players', 'Ann.yaml'))).toBe(true)
    })

    it('never deletes a path its record would lead out of the install', async () => {
      const install = await installWithUserData()
      write(join(root, 'outside.txt'), 'precious')
      const record = join(container(), 'archipelagoat-files.json')
      for (const evil of ['../../../outside.txt', 'logs/../../../../outside.txt', 'lib/..', '/etc/passwd']) {
        writeFileSync(record, JSON.stringify({ files: ['ArchipelagoLauncher', 'lib/libssl.so.3', evil] }))
        const error = await failure(uninstallLinux(core.ctx, install, { purgeUserData: true }))
        expect(error.code).toBe('PATH_FORBIDDEN')
      }
      // Refused before anything was deleted or backed up.
      expect(existsSync(join(root, 'outside.txt'))).toBe(true)
      expect(existsSync(join(installRoot(), 'ArchipelagoLauncher'))).toBe(true)
      expect(existsSync(join(installRoot(), 'lib', 'libssl.so.3'))).toBe(true)
      expect(existsSync(join(installRoot(), 'Players', 'Ann.yaml'))).toBe(true)
      expect(backups()).toEqual([])
    })
  })
})
