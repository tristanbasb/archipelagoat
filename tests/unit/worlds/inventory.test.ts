import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeStates, disabledWorldsDir, scanWorlds } from '@main/core/worlds/inventory'
import type { ApPaths, WorldInfo } from '@shared/types'
import { apworldManifest, makeApworld } from '../../helpers/make-apworld'

let root: string
let paths: ApPaths
let disabled: string

/** An install whose user folder is its own folder (Windows, or a writable Linux folder). */
function apPaths(base: string, coreWorlds: string = join(base, 'lib', 'worlds')): ApPaths {
  return {
    localPath: base,
    userPath: base,
    customWorlds: join(base, 'custom_worlds'),
    coreWorlds,
    players: join(base, 'Players'),
    templates: join(base, 'Players', 'Templates'),
    output: join(base, 'output'),
    logs: join(base, 'logs'),
    cache: join(base, 'cache'),
    settingsFile: join(base, 'host.yaml'),
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goat inventory é-'))
  paths = apPaths(join(root, 'Archipelago'))
  disabled = disabledWorldsDir(join(root, 'dataRoot'))
  mkdirSync(paths.customWorlds, { recursive: true })
  mkdirSync(paths.coreWorlds, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const custom = (name: string, opts: Parameters<typeof makeApworld>[1] = {}): Promise<string> =>
  makeApworld(join(paths.customWorlds, name), opts)
const core = (name: string, opts: Parameters<typeof makeApworld>[1] = {}): Promise<string> =>
  makeApworld(join(paths.coreWorlds, name), opts)

/** A world folder (a loose world), with `__init__.py` unless `init` says otherwise. */
function folder(dir: string, init: string | null = '__init__.py', manifest?: unknown): string {
  mkdirSync(dir, { recursive: true })
  if (init) writeFileSync(join(dir, init), '')
  if (manifest !== undefined) writeFileSync(join(dir, 'archipelago.json'), JSON.stringify(manifest))
  return dir
}

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** fileName → states, for the worlds of one location. */
function statesOf(worlds: WorldInfo[], location?: WorldInfo['location']): Record<string, string[]> {
  return Object.fromEntries(
    worlds.filter((w) => !location || w.location === location).map((w) => [w.fileName, w.states]),
  )
}

describe('scanWorlds', () => {
  it('scans the top level of each folder like Archipelago', async () => {
    const foo = await custom('foo.apworld', { game: 'Foo' })
    await custom('_off.apworld')
    await custom('.hidden.apworld')
    await custom('SHOUT.APWORLD')
    writeFileSync(join(paths.customWorlds, 'notes.txt'), 'x')
    folder(join(paths.customWorlds, 'src_world'), '__init__.py', { game: 'Source' })
    folder(join(paths.customWorlds, 'junk'), null)
    await makeApworld(join(paths.customWorlds, 'nested', 'deep.apworld'))
    await core('ahit.apworld', {
      game: 'A Hat in Time',
      manifest: apworldManifest('A Hat in Time', {
        minimum_ap_version: '0.6.8',
        maximum_ap_version: '0.6.8',
      }),
    })
    folder(join(paths.coreWorlds, 'alttp'), '__init__.pyc')
    await makeApworld(join(disabled, 'old.apworld'), { game: 'Old' })

    const worlds = await scanWorlds(paths, disabled, '0.6.8')
    expect(worlds.map((w) => [w.location, w.fileName, w.module, w.game, w.states])).toEqual([
      ['custom', 'foo.apworld', 'foo', 'Foo', ['ok']],
      ['custom', 'src_world', 'src_world', 'Source', ['ok']],
      ['core', 'ahit.apworld', 'ahit', 'A Hat in Time', ['ok']],
      // A loose core world: its game comes from the core worlds table.
      ['core', 'alttp', 'alttp', 'A Link to the Past', ['core-loose']],
      ['disabled', 'old.apworld', 'old', 'Old', ['disabled']],
    ])
    expect(worlds[0]).toEqual({
      id: sha1(foo),
      fileName: 'foo.apworld',
      path: foo,
      location: 'custom',
      module: 'foo',
      game: 'Foo',
      manifest: {
        game: 'Foo',
        worldVersion: null,
        minimumApVersion: null,
        maximumApVersion: null,
        authors: [],
        version: 7,
        compatibleVersion: 7,
      },
      states: ['ok'],
      sizeBytes: statSync(foo).size,
    })
    expect(worlds[1]).toMatchObject({ sizeBytes: 0, manifest: { game: 'Source', compatibleVersion: null } })
  })

  it('answers the folders that exist, and nothing for missing ones', async () => {
    rmSync(paths.customWorlds, { recursive: true })
    rmSync(paths.coreWorlds, { recursive: true })
    expect(await scanWorlds(paths, disabled, '0.6.8')).toEqual([])
  })

  it('marks lower world_version of same game as shadowed', async () => {
    await custom('a.apworld', { manifest: apworldManifest('Game', { world_version: '1.10.0' }) })
    await custom('b.apworld', { manifest: apworldManifest('Game', { world_version: '1.9.0' }) })
    // Without world_version a world is older than any versioned one.
    await custom('c.apworld', { manifest: apworldManifest('Game') })
    // A tie goes to the custom world, which Archipelago lists first.
    await custom('h.apworld', { manifest: apworldManifest('Hollow', { world_version: '1.0.0' }) })
    await core('hollow.apworld', { manifest: apworldManifest('Hollow', { world_version: '1.0.0' }) })
    // A newer core world wins over an older custom one.
    await custom('s.apworld', { manifest: apworldManifest('Stardew', { world_version: '1.0.0' }) })
    await core('stardew.apworld', { manifest: apworldManifest('Stardew', { world_version: '2.0.0' }) })

    const worlds = await scanWorlds(paths, disabled, '0.6.8')
    expect(statesOf(worlds)).toEqual({
      'a.apworld': ['ok'],
      'b.apworld': ['shadowed'],
      'c.apworld': ['shadowed'],
      'h.apworld': ['ok'],
      'hollow.apworld': ['shadowed'],
      's.apworld': ['shadowed'],
      'stardew.apworld': ['ok'],
    })
  })

  it('marks custom world shadowed by a core-loose world (e.g. game "A Link to the Past")', async () => {
    folder(join(paths.coreWorlds, 'alttp'))
    await custom('alttp_plus.apworld', {
      manifest: apworldManifest('A Link to the Past', { world_version: '99.0.0' }),
    })
    const worlds = await scanWorlds(paths, disabled, '0.6.8')
    expect(statesOf(worlds)).toEqual({ alttp: ['core-loose'], 'alttp_plus.apworld': ['shadowed'] })
  })

  it('takes the core worlds from the table when the Archipelago folder cannot be read (AppImage)', async () => {
    const appImage = apPaths(join(root, 'home', '.local', 'share', 'Archipelago'), '')
    mkdirSync(appImage.customWorlds, { recursive: true })
    await makeApworld(join(appImage.customWorlds, 'alttp_plus.apworld'), { game: 'A Link to the Past' })
    await makeApworld(join(appImage.customWorlds, 'ahit_next.apworld'), { game: 'A Hat in Time' })

    const worlds = await scanWorlds(appImage, disabled, '0.6.9')
    const cores = worlds.filter((w) => w.location === 'core')
    expect(cores).toHaveLength(82)
    expect(cores.find((w) => w.module === 'alttp')).toEqual({
      id: sha1('core:alttp'),
      fileName: 'alttp',
      path: '',
      location: 'core',
      module: 'alttp',
      game: 'A Link to the Past',
      manifest: null,
      states: ['core-loose'],
      sizeBytes: 0,
    })
    expect(statesOf(worlds, 'custom')).toEqual({
      'ahit_next.apworld': ['ok'],
      'alttp_plus.apworld': ['shadowed'],
    })
    expect(cores.find((w) => w.module === 'ahit')).toMatchObject({
      fileName: 'ahit.apworld',
      states: ['shadowed'],
    })

    // Without a version there is no table to use.
    expect((await scanWorlds(appImage, disabled, null)).filter((w) => w.location === 'core')).toEqual([])
  })

  it('marks incompatible when installed AP is outside min/max', async () => {
    await custom('next.apworld', {
      manifest: apworldManifest('Game', { world_version: '3.0.0', minimum_ap_version: '0.7.0' }),
    })
    await custom('stale.apworld', {
      manifest: apworldManifest('Other', { maximum_ap_version: '0.6.5' }),
    })
    await custom('fits.apworld', {
      manifest: apworldManifest('Game', {
        world_version: '1.0.0',
        minimum_ap_version: '0.6.8',
        maximum_ap_version: '0.6.8',
      }),
    })

    // A world Archipelago refuses does not hide an older version that it loads.
    expect(statesOf(await scanWorlds(paths, disabled, '0.6.8'))).toEqual({
      'fits.apworld': ['ok'],
      'next.apworld': ['incompatible'],
      'stale.apworld': ['incompatible'],
    })
    expect(statesOf(await scanWorlds(paths, disabled, '0.7.1'))).toMatchObject({
      'fits.apworld': ['incompatible'],
      'next.apworld': ['ok'],
    })
    // An unknown Archipelago version cannot be compared.
    expect(statesOf(await scanWorlds(paths, disabled, null))).toEqual({
      'fits.apworld': ['shadowed'],
      'next.apworld': ['ok'],
      'stale.apworld': ['ok'],
    })
  })

  it('marks no-manifest and corrupt', async () => {
    await custom('bare.apworld', { manifest: null })
    await custom('half.apworld', { manifest: { game: 'Half' } })
    writeFileSync(join(paths.customWorlds, 'broken.apworld'), 'not a zip at all')
    mkdirSync(disabled, { recursive: true })
    writeFileSync(join(disabled, 'quarantined.apworld'), 'not a zip either')

    const worlds = await scanWorlds(paths, disabled, '0.6.8')
    expect(worlds.map((w) => [w.fileName, w.module, w.game, w.manifest, w.states])).toEqual([
      ['bare.apworld', 'bare', null, null, ['no-manifest']],
      ['broken.apworld', 'broken', null, null, ['corrupt']],
      // Archipelago refuses this manifest (no compatible_version): only its game is kept.
      ['half.apworld', 'half', 'Half', null, ['no-manifest']],
      // A disabled world is out of Archipelago's sight, whatever its file holds.
      ['quarantined.apworld', 'quarantined', null, null, ['disabled']],
    ])
  })
})

describe('scanWorlds and the file name rule', () => {
  it('marks bad-name an .apworld whose stem is not its module: Archipelago never loads it', async () => {
    await custom('foo.apworld', {
      module: 'foo',
      game: 'Foo',
      manifest: apworldManifest('Foo', { world_version: '1.0.0' }),
    })
    await custom('foo-v1.1.0.apworld', {
      module: 'foo',
      manifest: apworldManifest('Foo', { world_version: '1.1.0' }),
    })
    // Case counts: Archipelago's zip lookup is case-sensitive.
    await custom('pokemon.apworld', { module: 'Pokemon', game: 'Pokemon' })

    const worlds = await scanWorlds(paths, disabled, '0.6.8')
    // The higher version is not loaded, so it shadows nothing: the copy Archipelago loads is ok.
    expect(statesOf(worlds, 'custom')).toEqual({
      'foo-v1.1.0.apworld': ['bad-name'],
      'foo.apworld': ['ok'],
      'pokemon.apworld': ['bad-name'],
    })
  })
})

describe('scanWorlds and worlds without a manifest', () => {
  const WORLD = 'from worlds.AutoWorld import World\n\nclass RDWorld(World):\n    game = "Rhythm Doctor"\n'

  it('reads their game from their code, in a file or a folder, without running it', async () => {
    await custom('rhythm_doctor.apworld', { manifest: null, files: { 'rhythm_doctor/world.py': WORLD } })
    const loose = folder(join(paths.customWorlds, 'loose_world'))
    writeFileSync(join(loose, '__init__.py'), WORLD.replace('Rhythm Doctor', 'Loose Game'))
    await custom('mystery.apworld', { manifest: null })

    const worlds = await scanWorlds(paths, disabled, '0.6.8')
    expect(worlds.map((w) => [w.fileName, w.game, w.manifest, w.states])).toEqual([
      ['loose_world', 'Loose Game', null, ['ok']],
      // Still no manifest: it breaks with Archipelago 0.7.
      ['mystery.apworld', null, null, ['no-manifest']],
      ['rhythm_doctor.apworld', 'Rhythm Doctor', null, ['no-manifest']],
    ])
  })
})

describe('computeStates', () => {
  const world = (fileName: string, over: Partial<WorldInfo> = {}): WorldInfo => ({
    id: fileName,
    fileName,
    path: `/ap/custom_worlds/${fileName}`,
    location: 'custom',
    module: fileName.replace(/\.apworld$/, ''),
    game: 'Game',
    manifest: {
      game: 'Game',
      worldVersion: null,
      minimumApVersion: null,
      maximumApVersion: null,
      authors: [],
      version: 7,
      compatibleVersion: 7,
    },
    states: [],
    sizeBytes: 1,
    ...over,
  })

  it('is pure and keeps only the corrupt flag of its input', () => {
    const input = [
      world('a.apworld', { states: ['shadowed'] }),
      world('b.apworld', { states: ['corrupt'], manifest: null, game: null }),
      world('c.apworld', { states: ['ok'] }),
    ]
    const copy = structuredClone(input)
    const once = computeStates(input, '0.6.8')
    expect(input).toEqual(copy)
    expect(once.map((w) => w.states)).toEqual([['ok'], ['corrupt'], ['shadowed']])
    expect(computeStates(once, '0.6.8')).toEqual(once)
  })

  it('lets a world without manifest load unless its game is already provided', () => {
    const versioned = world('d.apworld')
    if (versioned.manifest) versioned.manifest.worldVersion = '1.0.0'
    const states = computeStates(
      [
        world('a.apworld', { manifest: null, game: 'Solo' }),
        world('b.apworld', { manifest: null, game: null }),
        // Archipelago loads it (it cannot read its game), then the class fails to register.
        world('c.apworld', { manifest: null, game: 'Game' }),
        versioned,
      ],
      '0.6.8',
    )
    expect(states.map((w) => w.states)).toEqual([
      ['no-manifest'],
      ['no-manifest'],
      ['no-manifest', 'shadowed'],
      ['ok'],
    ])
  })
})
