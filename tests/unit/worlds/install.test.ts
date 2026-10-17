import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessInfo } from '@main/core/ap/processes'
import type { ExecFn } from '@main/core/exec'
import type { TaskHandle } from '@main/core/tasks'
import { createWorldInstaller, type WorldInstaller } from '@main/core/worlds/install'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
// The `worlds` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/worlds.service'
import { apExeFileName } from '@shared/data/ap-constants'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths, CatalogEntry, TaskDone, WorldInfo, WorldInstallPlan } from '@shared/types'
import { createTestContext, hostOs, httpStub, type TestCore } from '../../helpers/core'
import { apworldManifest, makeApworld } from '../../helpers/make-apworld'

const HOUR = 60 * 60 * 1000

let root: string
let core: TestCore
let install: ApInstall | null
let paths: ApPaths
let processes: ProcessInfo[] | Error
let clock: number
let catalog: Map<string, CatalogEntry>
let installer: WorldInstaller
let changes: number

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat install é-'))
  core = createTestContext(root)
  paths = apPaths(join(root, 'Archipelago'))
  install = { kind: 'custom', version: '0.6.8', root: paths.localPath, appImagePath: null, paths }
  mkdirSync(paths.customWorlds, { recursive: true })
  mkdirSync(paths.coreWorlds, { recursive: true })
  processes = []
  clock = 1_000_000
  catalog = new Map()
  changes = 0
  core.ctx.bus.on('worlds:changed', () => changes++)
  installer = createWorldInstaller(core.ctx, {
    locator: { detect: () => Promise.resolve(install) },
    lookupCatalog: (id) => catalog.get(id) ?? null,
    listProcesses: () =>
      processes instanceof Error ? Promise.reject(processes) : Promise.resolve(processes),
    now: () => clock,
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const dataRoot = (): string => core.ctx.platform.paths.dataRoot
const disabledDir = (): string => join(dataRoot(), 'disabled-worlds')
const stagingDir = (): string => join(dataRoot(), 'downloads', 'worlds')
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

function task(): TaskHandle & { progress: ReturnType<typeof vi.fn<TaskHandle['progress']>> } {
  return {
    id: 'task-1',
    signal: new AbortController().signal,
    progress: vi.fn<TaskHandle['progress']>(),
    log: vi.fn<TaskHandle['log']>(),
  }
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

/** An .apworld somewhere the user keeps files, outside Archipelago's folders. */
const userFile = (name: string, opts: Parameters<typeof makeApworld>[1] = {}): Promise<string> =>
  makeApworld(join(root, 'Téléchargements', name), opts)

const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

const byFile = async (fileName: string): Promise<WorldInfo> => {
  const world = (await installer.list()).find((w) => w.fileName === fileName)
  if (!world) throw new Error(`no world ${fileName}`)
  return world
}

describe('prepare', () => {
  it('renames versioned asset foo-v1.2.apworld with root foo/ to foo.apworld', async () => {
    const src = await userFile('foo-v1.2.apworld', {
      module: 'foo',
      manifest: apworldManifest('Foo', { world_version: '1.2.0', authors: ['Ann'] }),
    })
    const plan = await installer.prepare({ kind: 'file', path: src }, task())
    expect(plan).toEqual({
      planId: expect.any(String) as unknown,
      source: { kind: 'file', path: src },
      module: 'foo',
      targetFileName: 'foo.apworld',
      manifest: {
        game: 'Foo',
        worldVersion: '1.2.0',
        minimumApVersion: null,
        maximumApVersion: null,
        authors: ['Ann'],
        version: 7,
        compatibleVersion: 7,
      },
      sha256: sha256(readFileSync(src)),
      trust: 'unknown',
      homepage: null,
      conflicts: [],
      warnings: [],
    })

    const { world, restartNeeded } = await installer.confirm(plan.planId)
    const target = join(paths.customWorlds, 'foo.apworld')
    expect(readFileSync(target)).toEqual(readFileSync(src))
    expect(world).toMatchObject({
      id: sha1(target),
      fileName: 'foo.apworld',
      path: target,
      location: 'custom',
      module: 'foo',
      game: 'Foo',
      states: ['ok'],
    })
    expect(restartNeeded).toBe(false)
    // The user's own file stays where it was.
    expect(existsSync(src)).toBe(true)
  })

  it('keeps module case LostKingdoms2', async () => {
    const src = await userFile('LostKingdoms2.apworld', { game: 'Lost Kingdoms II' })
    const plan = await installer.prepare({ kind: 'file', path: src }, task())
    expect(plan).toMatchObject({ module: 'LostKingdoms2', targetFileName: 'LostKingdoms2.apworld' })
    await installer.confirm(plan.planId)
    expect(filesIn(paths.customWorlds)).toEqual(['LostKingdoms2.apworld'])
  })

  it('checks the path it is given and the archive it points to', async () => {
    const zip = join(root, 'foo.zip')
    writeFileSync(zip, 'x')
    expect(await failure(installer.prepare({ kind: 'file', path: zip }, task()))).toMatchObject({
      code: 'PATH_FORBIDDEN',
      params: { reason: 'extension' },
    })
    const missing = join(root, 'missing.apworld')
    expect(await failure(installer.prepare({ kind: 'file', path: missing }, task()))).toMatchObject({
      code: 'NOT_FOUND',
    })
    const flat = await userFile('flat.apworld', { init: false })
    expect(await failure(installer.prepare({ kind: 'file', path: flat }, task()))).toMatchObject({
      code: 'WORLD_INVALID',
      params: { reason: 'no-init' },
    })
    // Nothing is left behind.
    expect(filesIn(stagingDir())).toEqual([])
  })

  it('prepare rejects compatible_version 8 and AP outside min/max with WORLD_INCOMPATIBLE', async () => {
    const tooNew = await userFile('tn.apworld', { manifest: apworldManifest('G', { compatible_version: 8 }) })
    expect(await failure(installer.prepare({ kind: 'file', path: tooNew }, task()))).toMatchObject({
      code: 'WORLD_INCOMPATIBLE',
      params: { reason: 'compatible-version', value: 8 },
    })

    const future = await userFile('future.apworld', {
      manifest: apworldManifest('G', { minimum_ap_version: '0.7.0' }),
    })
    expect(await failure(installer.prepare({ kind: 'file', path: future }, task()))).toMatchObject({
      code: 'WORLD_INCOMPATIBLE',
      params: { reason: 'ap-version', min: '0.7.0', installed: '0.6.8' },
    })

    const past = await userFile('past.apworld', {
      manifest: apworldManifest('G', { minimum_ap_version: '0.5.0', maximum_ap_version: '0.6.5' }),
    })
    expect(await failure(installer.prepare({ kind: 'file', path: past }, task()))).toMatchObject({
      code: 'WORLD_INCOMPATIBLE',
      params: { reason: 'ap-version', min: '0.5.0', max: '0.6.5', installed: '0.6.8' },
    })
    expect(filesIn(stagingDir())).toEqual([])

    // An install whose version is unknown cannot be compared.
    if (install) install.version = null
    await expect(installer.prepare({ kind: 'file', path: future }, task())).resolves.toMatchObject({
      module: 'future',
    })
  })

  it('names the worlds it conflicts with and which one Archipelago will load', async () => {
    const replaced = await makeApworld(join(paths.customWorlds, 'foo.apworld'), {
      manifest: apworldManifest('Foo', { world_version: '1.0.0' }),
    })
    const legacy = await makeApworld(join(paths.customWorlds, 'legacy.apworld'), {
      manifest: apworldManifest('Foo', { world_version: '2.0.0' }),
    })
    // Disabled worlds are not loaded: no conflict.
    await makeApworld(join(disabledDir(), 'foo.apworld'), {
      manifest: apworldManifest('Foo', { world_version: '3.0.0' }),
    })
    const src = await userFile('foo.apworld', {
      manifest: apworldManifest('Foo', { world_version: '1.5.0' }),
    })
    expect(await installer.prepare({ kind: 'file', path: src }, task())).toMatchObject({
      conflicts: [
        { worldId: sha1(replaced), version: '1.0.0', winner: 'new' },
        { worldId: sha1(legacy), version: '2.0.0', winner: 'existing' },
      ],
      warnings: ['world-version-conflict'],
    })

    // A loose core world can never be replaced; a world without manifest gets a warning.
    const alttp = join(paths.coreWorlds, 'alttp')
    mkdirSync(alttp)
    writeFileSync(join(alttp, '__init__.py'), '')
    const zelda = await userFile('zelda.apworld', { manifest: { game: 'A Link to the Past' } })
    expect(await installer.prepare({ kind: 'file', path: zelda }, task())).toMatchObject({
      manifest: { game: 'A Link to the Past', compatibleVersion: null },
      conflicts: [{ worldId: sha1(alttp), version: null, winner: 'existing' }],
      warnings: ['world-no-manifest', 'world-version-conflict'],
    })
  })

  it('decides the winner against each rival and leaves out the rivals Archipelago never loads', async () => {
    const higher = await makeApworld(join(paths.customWorlds, 'a.apworld'), {
      manifest: apworldManifest('Game', { world_version: '2.0.0' }),
    })
    // Already shadowed by a.apworld, but the new world beats it.
    const lower = await makeApworld(join(paths.customWorlds, 'b.apworld'), {
      manifest: apworldManifest('Game', { world_version: '1.0.0' }),
    })
    // Outside its AP range: never loaded, whatever its version.
    await makeApworld(join(paths.customWorlds, 'inc.apworld'), {
      manifest: apworldManifest('Game', { world_version: '9.0.0', minimum_ap_version: '0.7.0' }),
    })
    expect((await installer.list()).map((w) => [w.fileName, w.states])).toEqual([
      ['a.apworld', ['ok']],
      ['b.apworld', ['shadowed']],
      ['inc.apworld', ['incompatible']],
    ])

    const middle = await userFile('c.apworld', {
      manifest: apworldManifest('Game', { world_version: '1.5.0' }),
    })
    const plan = await installer.prepare({ kind: 'file', path: middle }, task())
    expect(plan.conflicts).toEqual([
      { worldId: sha1(higher), version: '2.0.0', winner: 'existing' },
      { worldId: sha1(lower), version: '1.0.0', winner: 'new' },
    ])
    expect(plan.warnings).toEqual(['world-version-conflict'])

    const top = await userFile('d.apworld', {
      manifest: apworldManifest('Game', { world_version: '3.0.0' }),
    })
    expect((await installer.prepare({ kind: 'file', path: top }, task())).conflicts).toEqual([
      { worldId: sha1(higher), version: '2.0.0', winner: 'new' },
      { worldId: sha1(lower), version: '1.0.0', winner: 'new' },
    ])
  })

  it('downloads a catalog world and checks the sha256 the catalog gives', async () => {
    const src = await userFile('pokemon_crystal.apworld', { game: 'Pokemon Crystal' })
    const bytes = readFileSync(src)
    const url = 'https://github.com/owner/crystal/releases/download/v3.1.0/pokemon_crystal.apworld'
    const fetchRaw = vi.fn((asked: string) =>
      Promise.resolve(asked === url ? new Response(bytes) : new Response('nope', { status: 404 })),
    )
    core.ctx.http = { ...httpStub, fetchRaw }
    const entry: CatalogEntry = {
      id: 'pokemon_crystal',
      game: 'Pokemon Crystal',
      displayName: 'Pokémon Crystal',
      homepage: 'https://github.com/owner/crystal',
      tags: [],
      supported: true,
      afterDark: false,
      requiresRomAtGeneration: true,
      hasPopTracker: false,
      wiki: null,
      latest: { version: '3.1.0', url, sha256: sha256(bytes) },
      installedVersion: null,
      trust: 'indexed-verified',
    }
    catalog.set(entry.id, entry)

    const handle = task()
    const plan = await installer.prepare({ kind: 'catalog', id: entry.id }, handle)
    expect(plan).toMatchObject({
      source: { kind: 'catalog', id: 'pokemon_crystal' },
      targetFileName: 'pokemon_crystal.apworld',
      sha256: sha256(bytes),
      trust: 'indexed-verified',
      homepage: 'https://github.com/owner/crystal',
    })
    expect(handle.progress.mock.calls.map(([stage]) => stage)).toEqual(
      expect.arrayContaining(['download', 'inspect']),
    )
    expect(fetchRaw).toHaveBeenCalledWith(url, expect.anything())
    await installer.confirm(plan.planId)
    expect(readFileSync(join(paths.customWorlds, 'pokemon_crystal.apworld'))).toEqual(bytes)

    catalog.set(entry.id, { ...entry, latest: { version: '3.1.0', url, sha256: '0'.repeat(64) } })
    expect(await failure(installer.prepare({ kind: 'catalog', id: entry.id }, task()))).toMatchObject({
      code: 'DOWNLOAD_HASH_MISMATCH',
    })
    catalog.set(entry.id, { ...entry, latest: null })
    expect(await failure(installer.prepare({ kind: 'catalog', id: entry.id }, task()))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(await failure(installer.prepare({ kind: 'catalog', id: 'unknown' }, task()))).toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(filesIn(stagingDir())).toEqual([])
  })

  it('downloads a world from an https link, keeping the asset name', async () => {
    const src = await userFile('foo-v2.0.0.apworld', { module: 'foo' })
    core.ctx.http = { ...httpStub, fetchRaw: () => Promise.resolve(new Response(readFileSync(src))) }
    const url = 'https://example.test/files/foo-v2.0.0.apworld?raw=1'
    expect(await installer.prepare({ kind: 'url', url }, task())).toMatchObject({
      source: { kind: 'url', url },
      module: 'foo',
      targetFileName: 'foo.apworld',
      trust: 'unknown',
    })
    // A name without the extension gets it; a device name is never written.
    const bare = 'https://example.test/download/foo%20build'
    await expect(installer.prepare({ kind: 'url', url: bare }, task())).resolves.toMatchObject({
      module: 'foo',
    })
    const device = 'https://example.test/con.apworld'
    expect(await failure(installer.prepare({ kind: 'url', url: device }, task()))).toMatchObject({
      code: 'WORLD_INVALID',
      params: { reason: 'name-mismatch' },
    })
    for (const bad of ['http://example.test/foo.apworld', 'not a url']) {
      expect(await failure(installer.prepare({ kind: 'url', url: bad }, task()))).toMatchObject({
        code: 'INVALID_INPUT',
      })
    }
  })

  it('refuses to prepare without Archipelago, and lists nothing', async () => {
    install = null
    const src = await userFile('foo.apworld')
    expect(await failure(installer.prepare({ kind: 'file', path: src }, task()))).toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
    expect(await installer.list()).toEqual([])
  })
})

describe('confirm', () => {
  it('confirm backs up existing file then installs atomically', async () => {
    const target = await makeApworld(join(paths.customWorlds, 'foo.apworld'), {
      manifest: apworldManifest('Foo', { world_version: '1.0.0' }),
    })
    const old = readFileSync(target)
    const src = await userFile('foo.apworld', {
      manifest: apworldManifest('Foo', { world_version: '2.0.0' }),
    })
    const plan = await installer.prepare({ kind: 'file', path: src }, task())
    expect(changes).toBe(0)

    const { world } = await installer.confirm(plan.planId)
    expect(readFileSync(target)).toEqual(readFileSync(src))
    expect(world.manifest?.worldVersion).toBe('2.0.0')
    // The old file went to dataRoot/backups/<timestamp>-world-foo/.
    const backups = join(dataRoot(), 'backups')
    const [dir] = filesIn(backups)
    expect(dir).toMatch(/^\d{8}-\d{6}-world-foo$/)
    expect(readFileSync(join(backups, dir ?? '', 'foo.apworld'))).toEqual(old)
    // No temporary file is left next to the world, nor in the staging folder.
    expect(filesIn(paths.customWorlds)).toEqual(['foo.apworld'])
    expect(filesIn(stagingDir())).toEqual([])
    expect(changes).toBe(1)

    // A plan is used once.
    expect(await failure(installer.confirm(plan.planId))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('confirm reports restartNeeded when an Archipelago process runs', async () => {
    const src = await userFile('foo.apworld')
    processes = [{ pid: 42, name: 'ArchipelagoServer.exe' }]
    const first = await installer.prepare({ kind: 'file', path: src }, task())
    expect((await installer.confirm(first.planId)).restartNeeded).toBe(true)

    // When the programs cannot be listed, nothing says a restart is needed.
    processes = new Error('tasklist failed')
    const second = await installer.prepare({ kind: 'file', path: src }, task())
    expect((await installer.confirm(second.planId)).restartNeeded).toBe(false)
  })

  it('refuses a plan older than one hour', async () => {
    const src = await userFile('foo.apworld')
    const plan = await installer.prepare({ kind: 'file', path: src }, task())
    expect(filesIn(stagingDir())).toEqual([plan.planId])
    clock += HOUR + 1
    expect(await failure(installer.confirm(plan.planId))).toMatchObject({ code: 'NOT_FOUND' })
    expect(filesIn(paths.customWorlds)).toEqual([])
    expect(filesIn(stagingDir())).toEqual([])
    expect(await failure(installer.confirm('no-such-plan'))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a staged file that changed since the user reviewed it', async () => {
    const src = await userFile('foo.apworld')
    const plan = await installer.prepare({ kind: 'file', path: src }, task())
    writeFileSync(join(stagingDir(), plan.planId, 'foo.apworld'), 'swapped')
    expect(await failure(installer.confirm(plan.planId))).toMatchObject({ code: 'DOWNLOAD_HASH_MISMATCH' })
    expect(filesIn(paths.customWorlds)).toEqual([])
  })
})

describe('setEnabled and remove', () => {
  it('setEnabled moves to and from disabled dir; remove refuses core', async () => {
    await makeApworld(join(paths.customWorlds, 'foo.apworld'), {
      manifest: apworldManifest('Foo', { world_version: '1.0.0' }),
    })
    await makeApworld(join(paths.coreWorlds, 'ahit.apworld'), { game: 'A Hat in Time' })
    const foo = await byFile('foo.apworld')

    const off = await installer.setEnabled(foo.id, false)
    expect(off).toMatchObject({
      id: sha1(join(disabledDir(), 'foo.apworld')),
      path: join(disabledDir(), 'foo.apworld'),
      location: 'disabled',
      states: ['disabled'],
    })
    expect(filesIn(paths.customWorlds)).toEqual([])
    expect(changes).toBe(1)
    // Already disabled: nothing moves.
    expect(await installer.setEnabled(off.id, false)).toEqual(off)
    expect(changes).toBe(1)

    // Enabling it while another foo.apworld is installed swaps the two.
    await makeApworld(join(paths.customWorlds, 'foo.apworld'), {
      manifest: apworldManifest('Foo', { world_version: '2.0.0' }),
    })
    const on = await installer.setEnabled(off.id, true)
    expect(on).toMatchObject({
      path: join(paths.customWorlds, 'foo.apworld'),
      location: 'custom',
      states: ['ok'],
    })
    expect(on.manifest?.worldVersion).toBe('1.0.0')
    expect(filesIn(disabledDir())).toEqual(['foo-2.apworld'])
    expect(await installer.setEnabled(on.id, true)).toEqual(on)

    // The swapped world comes back as foo.apworld, the name its module needs.
    const swapped = await byFile('foo-2.apworld')
    expect(swapped.module).toBe('foo')
    await installer.remove(on.id)
    const back = await installer.setEnabled(swapped.id, true)
    expect(back).toMatchObject({ fileName: 'foo.apworld', location: 'custom' })
    expect(back.manifest?.worldVersion).toBe('2.0.0')

    // Removing moves the file to the backups.
    await installer.remove(back.id)
    expect(filesIn(paths.customWorlds)).toEqual([])
    const backups = join(dataRoot(), 'backups')
    expect(filesIn(backups)).toHaveLength(2)

    const ahit = await byFile('ahit.apworld')
    expect(await failure(installer.remove(ahit.id))).toMatchObject({
      code: 'PATH_FORBIDDEN',
      params: { reason: 'core' },
    })
    expect(await failure(installer.setEnabled(ahit.id, false))).toMatchObject({ code: 'PATH_FORBIDDEN' })
    expect(await failure(installer.remove('unknown'))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(installer.setEnabled('unknown', true))).toMatchObject({ code: 'NOT_FOUND' })
    expect(existsSync(join(paths.coreWorlds, 'ahit.apworld'))).toBe(true)
  })

  it('refuses to enable a corrupt world and to move a folder world', async () => {
    mkdirSync(disabledDir(), { recursive: true })
    writeFileSync(join(disabledDir(), 'broken.apworld'), 'not a zip')
    const broken = await byFile('broken.apworld')
    expect(await failure(installer.setEnabled(broken.id, true))).toMatchObject({
      code: 'WORLD_INVALID',
      params: { reason: 'not-zip' },
    })
    // It can still be removed.
    await installer.remove(broken.id)
    expect(filesIn(disabledDir())).toEqual([])

    const source = join(paths.customWorlds, 'src_world')
    mkdirSync(source)
    writeFileSync(join(source, '__init__.py'), '')
    const folder = await byFile('src_world')
    expect(await failure(installer.setEnabled(folder.id, false))).toMatchObject({
      code: 'PATH_FORBIDDEN',
      params: { reason: 'not-a-file' },
    })
    expect(await failure(installer.remove(folder.id))).toMatchObject({ code: 'PATH_FORBIDDEN' })
  })
})

describe('worlds handlers', () => {
  it('run the installer of the worlds service', async () => {
    const ap = join(root, 'AP')
    mkdirSync(ap)
    writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), '')
    writeFileSync(join(ap, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    core.ctx.config.updateInternal({ apPathOverride: ap })
    // No real process list: none runs.
    const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    core.ctx.exec = exec
    const done: TaskDone[] = []
    core.ctx.bus.on('task:done', (event) => done.push(event))

    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const call = async <T>(name: string, input?: unknown): Promise<T> => {
      const result = await ipc.dispatch(name, input, { senderId: 1 })
      if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
      return result.value as T
    }

    expect(await call('worlds:list')).toEqual([])
    const src = await userFile('foo.apworld', { game: 'Foo' })
    const { taskId } = await call<{ taskId: string }>('worlds:prepareInstall', {
      source: { kind: 'file', path: src },
    })
    await vi.waitFor(() => expect(done.map((event) => event.taskId)).toContain(taskId))
    const plan = done.find((event) => event.taskId === taskId)?.result as WorldInstallPlan
    expect(plan.targetFileName).toBe('foo.apworld')

    const { world, restartNeeded } = await call<{ world: WorldInfo; restartNeeded: boolean }>(
      'worlds:confirmInstall',
      { planId: plan.planId },
    )
    expect(world.path).toBe(join(ap, 'custom_worlds', 'foo.apworld'))
    expect(restartNeeded).toBe(false)
    expect(await call('worlds:list')).toEqual([world])

    const off = await call<WorldInfo>('worlds:setEnabled', { worldId: world.id, enabled: false })
    expect(off.location).toBe('disabled')
    expect(await call('worlds:remove', { worldId: off.id })).toBeUndefined()
    expect(await call('worlds:list')).toEqual([])
  })
})
