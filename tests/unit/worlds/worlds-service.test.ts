import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorlds, installedGamesOf, unknownWorldsOf, type Worlds } from '@main/services/worlds.service'
import type { ApInstall, ApPaths, WorldInfo } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'
import { apworldManifest, makeApworld } from '../../helpers/make-apworld'

let root: string
let core: TestCore
let paths: ApPaths
let install: ApInstall | null
let worlds: Worlds

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
  root = mkdtempSync(join(tmpdir(), 'goat worlds é-'))
  core = createTestContext(join(root, 'core'))
  paths = apPaths(join(root, 'Archipelago'))
  install = { kind: 'custom', version: '0.6.8', root: paths.localPath, appImagePath: null, paths }
  mkdirSync(paths.customWorlds, { recursive: true })
  mkdirSync(paths.coreWorlds, { recursive: true })
  worlds = createWorlds(core.ctx, {
    locator: { detect: () => Promise.resolve(install) },
    lookupCatalog: () => null,
    listProcesses: () => Promise.resolve([]),
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

const tunic = (version: string): Promise<string> =>
  makeApworld(join(paths.customWorlds, 'tunic.apworld'), {
    manifest: apworldManifest('TUNIC', { world_version: version }),
  })

/** Sets the folder's modification time to a whole second, which a stat reads back unchanged. */
const stamp = (dir: string, seconds = 1_700_000_000): void => utimesSync(dir, seconds, seconds)

describe('worlds service: installedGames', () => {
  it('gives the version of the world Archipelago loads for each game it loads', async () => {
    await tunic('3.1.0')
    // An older copy is shadowed; a disabled or corrupt world loads nothing.
    await makeApworld(join(paths.customWorlds, 'tunic_old.apworld'), {
      module: 'tunic_old',
      manifest: apworldManifest('TUNIC', { world_version: '2.0.0' }),
    })
    await makeApworld(join(core.platform.paths.dataRoot, 'disabled-worlds', 'zork.apworld'), { game: 'Zork' })
    writeFileSync(join(paths.customWorlds, 'broken.apworld'), 'not a zip')
    expect(await worlds.installedGames()).toEqual(new Map([['TUNIC', { worldVersion: '3.1.0' }]]))
  })

  it('is cached until worlds:changed or ap:installed', async () => {
    await tunic('3.1.0')
    stamp(paths.customWorlds)
    expect((await worlds.installedGames()).get('TUNIC')).toEqual({ worldVersion: '3.1.0' })
    // Rewritten in place, the folder's time as it was: the cache answers.
    await tunic('4.0.0')
    stamp(paths.customWorlds)
    expect((await worlds.installedGames()).get('TUNIC')).toEqual({ worldVersion: '3.1.0' })
    core.ctx.bus.emit('worlds:changed', null)
    expect((await worlds.installedGames()).get('TUNIC')).toEqual({ worldVersion: '4.0.0' })
    await tunic('5.0.0')
    stamp(paths.customWorlds)
    expect((await worlds.installedGames()).get('TUNIC')).toEqual({ worldVersion: '4.0.0' })
    core.ctx.bus.emit('ap:installed', install)
    expect((await worlds.installedGames()).get('TUNIC')).toEqual({ worldVersion: '5.0.0' })
    // A copy: changing it does not change the cache.
    ;(await worlds.installedGames()).clear()
    expect((await worlds.installedGames()).has('TUNIC')).toBe(true)
  })

  it('sees a world added to the folder outside the app, and another install', async () => {
    expect(await worlds.installedGames()).toEqual(new Map())
    await tunic('3.1.0')
    // Some file systems keep the folder's time to the second or two: make it move for sure.
    const later = new Date(statSync(paths.customWorlds).mtimeMs + 10_000)
    utimesSync(paths.customWorlds, later, later)
    expect([...(await worlds.installedGames()).keys()]).toEqual(['TUNIC'])
    const other = apPaths(join(root, 'Other'))
    install = { kind: 'custom', version: '0.6.8', root: other.localPath, appImagePath: null, paths: other }
    expect(await worlds.installedGames()).toEqual(new Map())
    install = null
    expect(await worlds.installedGames()).toEqual(new Map())
  })

  it('includes the core games of an AppImage, read from the table of its version', async () => {
    install = {
      kind: 'linux-appimage',
      version: '0.6.8',
      root: join(root, 'Archipelago.AppImage'),
      appImagePath: join(root, 'Archipelago.AppImage'),
      paths: { ...paths, coreWorlds: '' },
    }
    await tunic('3.1.0')
    const games = await worlds.installedGames()
    expect(games.get('A Link to the Past')).toEqual({ worldVersion: null })
    expect(games.get('TUNIC')).toEqual({ worldVersion: '3.1.0' })
    expect(games.size).toBeGreaterThan(50)
  })

  it('a failed scan is not cached', async () => {
    await tunic('3.1.0')
    // The second detection is the scan's own: only the scan fails.
    let detections = 0
    const failing = createWorlds(core.ctx, {
      locator: {
        detect: () => (++detections === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(install)),
      },
      lookupCatalog: () => null,
      listProcesses: () => Promise.resolve([]),
    })
    await expect(failing.installedGames()).rejects.toThrow('boom')
    expect([...(await failing.installedGames()).keys()]).toEqual(['TUNIC'])
  })
})

describe('unknownWorldsOf', () => {
  const custom = (module: string, game: string | null, states: WorldInfo['states']): WorldInfo => ({
    id: module,
    fileName: `${module}.apworld`,
    path: '',
    location: 'custom',
    module,
    game,
    manifest: null,
    states,
    sizeBytes: 0,
  })

  it('lists the loaded custom worlds whose game nothing tells', () => {
    expect(
      unknownWorldsOf([
        custom('mystery', null, ['no-manifest']),
        custom('known', 'Known', ['no-manifest']),
        custom('broken', null, ['corrupt']),
        custom('misnamed', null, ['bad-name']),
        { ...custom('core', null, ['ok']), location: 'core' },
      ]),
    ).toEqual(['mystery'])
  })
})

describe('installedGamesOf', () => {
  const world = (
    game: string | null,
    states: WorldInfo['states'],
    worldVersion: string | null,
  ): WorldInfo => ({
    id: `${game}-${worldVersion}`,
    fileName: `${game}.apworld`,
    path: '',
    location: 'custom',
    module: String(game),
    game,
    manifest:
      worldVersion === null
        ? null
        : {
            game: String(game),
            worldVersion,
            minimumApVersion: null,
            maximumApVersion: null,
            authors: [],
            version: 7,
            compatibleVersion: 7,
          },
    states,
    sizeBytes: 0,
  })

  it('takes the winner of a game, a shadowed one only when it is alone', () => {
    expect(
      installedGamesOf([
        world('A', ['shadowed'], '1.0.0'),
        world('A', ['ok'], '2.0.0'),
        world('B', ['shadowed'], '1.0.0'),
        world('C', ['incompatible'], '1.0.0'),
        world('E', ['bad-name'], '1.0.0'),
        world('D', ['no-manifest'], null),
        world(null, ['ok'], null),
      ]),
    ).toEqual(
      new Map([
        ['A', { worldVersion: '2.0.0' }],
        ['D', { worldVersion: null }],
        ['B', { worldVersion: '1.0.0' }],
      ]),
    )
  })
})
