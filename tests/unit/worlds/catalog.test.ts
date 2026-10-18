import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecFn } from '@main/core/exec'
import { createHttp } from '@main/core/system/http'
import {
  createCatalog,
  joinCatalog,
  parseIoniumLock,
  parseIoniumToml,
  parseWikiPages,
  resolveIoniumRelease,
  type Catalog,
  type IoniumWorld,
  type JoinOptions,
  type WikiPage,
} from '@main/core/worlds/catalog'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import { isInstallable } from '@shared/catalog'
import { apExeFileName } from '@shared/data/ap-constants'
import type {
  ApInstall,
  ApPaths,
  CatalogEntry,
  CatalogSnapshot,
  TaskDone,
  WorldInfo,
  WorldInstallPlan,
  WorldManifest,
} from '@shared/types'
import optOutFile from '../../../resources/catalog-optout.json'
import { createTestContext, hostOs, silentLogger, type TestCore } from '../../helpers/core'
import { githubFixture } from '../../helpers/http-server'
import { apworldManifest, makeApworld } from '../../helpers/make-apworld'

// --- fixtures: real files of the ionium index and real wiki answers, reduced -------------------------

const FIXTURES = fileURLToPath(new URL('../../fixtures/catalog/', import.meta.url))
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const fixtureJson = (name: string): unknown => JSON.parse(fixtureText(name)) as unknown
const worldText = (stem: string): string => fixtureText(`worlds/${stem}.toml`)
const WORLD_STEMS = readdirSync(join(FIXTURES, 'worlds')).map((file) => file.replace(/\.toml$/, ''))

const ioniumWorld = (stem: string): IoniumWorld => {
  const world = parseIoniumToml(worldText(stem), stem)
  if (!world) throw new Error(`fixture ${stem} does not parse`)
  return world
}
const allWorlds = (): IoniumWorld[] => WORLD_STEMS.map(ioniumWorld)
// The second page also holds real pages of worlds no file of the index describes (Frogmonster, Hexcells
// Infinite, Keymaster's Keep, BK Simulator, Kao the Kangaroo Round 2, Here Comes Niko!, Hunie Pop,
// Resident Evil 2 Remake), as the wiki API answers for them.
const allPages = (): WikiPage[] => [
  ...parseWikiPages(fixtureJson('wiki-page1.json')),
  ...parseWikiPages(fixtureJson('wiki-page2.json')),
]
/** A wiki page made up for a test: a custom world with nothing filled in but what it says. */
const madePage = (title: string, fields: Partial<WikiPage> = {}): WikiPage => ({
  title,
  status: 'Custom',
  maintainer: null,
  setupUrl: null,
  homepage: null,
  download: null,
  repos: [],
  cover: null,
  ...fields,
})
const memberTitles = (name: string): Set<string> =>
  new Set(
    (fixtureJson(name) as { query: { categorymembers: { title: string }[] } }).query.categorymembers.map(
      (member) => member.title,
    ),
  )

const SHA = {
  crystal604: '9d08ec0632ea4451d2bb11988b42e28a7ff6393d2f5671007156237d52e65505',
  gl217: '97559cb954dfed6ce8cac84d6e5e6ccf56f6c1b09f880a6880ff64cffb4707b4',
  sms052: '2371a0ba707d7e38f51872d2e531db2ed792abbf1d0d051879c5aa44e0b1abc5',
  schedule364: '7c66bf3af23bfc65fbfd8fecac6d93f1b7f9af8b67c16f704ce3033b30de5dcc',
  minecraft221: 'a204e6f5438797038986cdfa4c995587f7d0f415f1af88fe7afc71a1c35c7a18',
  pmd032: '8313990c3da20154909698ecce3acf8b16e4e434371604f28ae1957ce90eedb9',
}

const manifest = (game: string, worldVersion: string | null): WorldManifest => ({
  game,
  worldVersion,
  minimumApVersion: null,
  maximumApVersion: null,
  authors: [],
  version: 7,
  compatibleVersion: 7,
})

const installedWorld = (fields: Partial<WorldInfo>): WorldInfo => ({
  id: `id-${fields.module ?? 'x'}`,
  fileName: `${fields.module ?? 'x'}.apworld`,
  path: `/ap/custom_worlds/${fields.module ?? 'x'}.apworld`,
  location: 'custom',
  module: 'x',
  game: null,
  manifest: null,
  states: ['ok'],
  sizeBytes: 1,
  ...fields,
})

const joinOptions = (fields: Partial<JoinOptions> = {}): JoinOptions => ({
  apVersion: '0.6.8',
  lock: parseIoniumLock(fixtureText('index.lock')),
  showAfterDark: true,
  afterDarkTitles: memberTitles('wiki-afterdark.json'),
  romTitles: memberTitles('wiki-rom.json'),
  popTrackerTitles: memberTitles('wiki-poptracker.json'),
  ...fields,
})

const byId = (entries: CatalogEntry[]): Record<string, CatalogEntry> =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry]))

// --- a fake network: the ionium index, raw.githubusercontent.com and the wiki API -------------------

const INDEX_RAW = 'https://raw.githubusercontent.com/ionium-ap/Archipelago-index/main/'
const TREE_PATH = '/repos/ionium-ap/Archipelago-index/git/trees/main'

const gitBlobSha = (text: string | Buffer): string => {
  const bytes = Buffer.from(text)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

interface FakeRemote {
  /** Files of the index repository, by path. */
  files: Map<string, string>
  /** Other answers (apworld downloads), by URL. */
  downloads: Map<string, Buffer<ArrayBuffer>>
  /** Answers of api.github.com other than the tree of the index, by path. */
  github: Map<string, unknown>
  offline: boolean
  rateLimited: boolean
  /** Every URL asked, in order. */
  requests: string[]
}

function makeRemote(): FakeRemote {
  const files = new Map([
    ['index.toml', fixtureText('index.toml')],
    ['index.lock', fixtureText('index.lock')],
  ])
  for (const stem of WORLD_STEMS) files.set(`index/${stem}.toml`, worldText(stem))
  return { files, downloads: new Map(), github: new Map(), offline: false, rateLimited: false, requests: [] }
}

/** The recorded tree, with the blobs of the served files (their sha recomputed from their content). */
function treeOf(files: Map<string, string>): unknown {
  const recorded = fixtureJson('tree.json') as { sha: string; tree: { path: string; type: string }[] }
  const isServed = (path: string): boolean =>
    path === 'index.toml' || path === 'index.lock' || path.startsWith('index/')
  const kept = recorded.tree.filter((entry) => entry.type !== 'blob' || !isServed(entry.path))
  const served = [...files].map(([path, text]) => ({
    path,
    mode: '100644',
    type: 'blob',
    sha: gitBlobSha(text),
    size: Buffer.byteLength(text),
  }))
  return { sha: recorded.sha, tree: [...kept, ...served], truncated: false }
}

const CATEGORY_FIXTURES: Record<string, string> = {
  'Category:After Dark implementations': 'wiki-afterdark.json',
  'Category:Implementations that require a ROM at generation': 'wiki-rom.json',
  'Category:Implementations with PopTracker': 'wiki-poptracker.json',
}

function fakeFetch(remote: FakeRemote): typeof fetch {
  return (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    remote.requests.push(url.href)
    if (remote.offline) {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      return Promise.reject(new TypeError('fetch failed', { cause }))
    }
    const json = (value: unknown): Promise<Response> => Promise.resolve(Response.json(value))
    if (url.host === 'api.github.com') {
      if (remote.rateLimited) {
        return Promise.resolve(
          new Response('{"message":"API rate limit exceeded"}', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792217162' },
          }),
        )
      }
      if (url.pathname === TREE_PATH && url.searchParams.get('recursive') === '1')
        return json(treeOf(remote.files))
      const answer = remote.github.get(url.pathname)
      if (answer !== undefined) return json(answer)
    }
    if (url.href.startsWith(INDEX_RAW)) {
      const text = remote.files.get(decodeURIComponent(url.href.slice(INDEX_RAW.length)))
      if (text !== undefined) return Promise.resolve(new Response(text))
    }
    if (url.origin === 'https://archipelago.miraheze.org' && url.pathname === '/w/api.php') {
      const params = url.searchParams
      if (
        params.get('generator') === 'categorymembers' &&
        params.get('gcmtitle') === 'Category:Implementations'
      ) {
        const next = params.get('gcmcontinue')
        if (next === null) return json(fixtureJson('wiki-page1.json'))
        if (next === 'page|4d4554524f494420465553494f4e|480' && params.get('continue') === 'gcmcontinue||') {
          return json(fixtureJson('wiki-page2.json'))
        }
      }
      const category = CATEGORY_FIXTURES[params.get('cmtitle') ?? '']
      if (params.get('list') === 'categorymembers' && category) return json(fixtureJson(category))
    }
    const download = remote.downloads.get(url.href)
    if (download) return Promise.resolve(new Response(download))
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
}

const rawRequests = (remote: FakeRemote): string[] =>
  remote.requests
    .filter((url) => url.startsWith(INDEX_RAW))
    .map((url) => decodeURIComponent(url.slice(INDEX_RAW.length)))
const apiRequests = (remote: FakeRemote): string[] =>
  remote.requests.filter((url) => url.includes('api.github.com'))
const wikiRequests = (remote: FakeRemote): string[] =>
  remote.requests.filter((url) => url.includes('archipelago.miraheze.org'))

// --- pure functions -------------------------------------------------------------------------------

describe('parseIoniumToml', () => {
  it('parses ionium toml keys (name, display_name, home, tags, versions, releases)', () => {
    const gl = ['1.7.1', '1.7.2', '2.1.0', '2.1.1', '2.1.5', '2.1.7']
    expect(ioniumWorld('gl')).toEqual({
      id: 'gl',
      dir: 'index',
      name: 'Gauntlet Legends',
      displayName: 'Gauntlet Legends',
      home: 'https://discord.com/channels/731205301247803413/1195336830258778183',
      defaultUrl: 'https://github.com/jamesbrq/GauntletLegendsAP/releases/download/v{{version}}/gl.apworld',
      defaultVersion: 'latest',
      tags: [],
      supported: false,
      disabled: false,
      versions: gl.map((version) => ({ version, url: null, local: null })),
      releases: gl.map((version) => ({
        version,
        minApVersion: null,
        maxApVersion: '0.6.7',
        url: null,
        local: null,
      })),
      bases: [
        { requirement: '>=0.6.8', supported: true, disabled: null, defaultVersion: 'latest_supported' },
      ],
    })
    expect(ioniumWorld('minecraft')).toMatchObject({ name: 'Minecraft', displayName: 'Minecraft NeoForge' })
    expect(ioniumWorld('Schedule_I')).toMatchObject({ id: 'Schedule_I', name: 'Schedule I', tags: ['ad'] })
    expect(ioniumWorld('sms').versions).toEqual([
      {
        version: '0.5.2+hotfix1',
        url: 'https://github.com/Joshark/archipelago-sms/releases/download/0.5.2/sms.apworld',
        local: null,
      },
      { version: '0.5.3', url: null, local: null },
      { version: '0.6.2', url: null, local: null },
    ])
    expect(ioniumWorld('Twilight Princess').versions).toEqual([
      { version: '0.2.3', url: null, local: '../apworlds/Twilight Princess-0.2.3.apworld' },
      { version: '0.3.0', url: null, local: '../apworlds/Twilight Princess-0.3.0.apworld' },
    ])
    expect(ioniumWorld('hk')).toMatchObject({
      supported: true,
      disabled: false,
      versions: [],
      home: 'https://archipelago.gg',
    })
    expect(ioniumWorld('celeste')).toMatchObject({ disabled: true, defaultVersion: 'latest' })
  })

  it('answers null for what is not a world file, and leaves out what it cannot use', () => {
    expect(parseIoniumToml('name = ', 'broken')).toBeNull()
    expect(parseIoniumToml('home = "https://example.com"', 'nameless')).toBeNull()
    expect(parseIoniumToml('name = ""', 'empty')).toBeNull()
    const world = parseIoniumToml(
      [
        'name = "X"',
        'home = "not a link"',
        'tags = ["ad", 3]',
        'default_version = "2.0.0"',
        '[versions]',
        '"1.0" = {}',
        '"2.0.0" = "odd"',
        '"1.0.0" = { url = "https://example.com/1.0.0/x.apworld" }',
        '[releases]',
        '"3.0.0" = { min_ap_version = "0.6.x" }',
        '"3.1.0" = { min_ap_version = "0.6.8", local = "../apworlds/x.apworld" }',
        '[base."not a requirement"]',
        'disabled = true',
      ].join('\n'),
      'x',
    )
    expect(world).toMatchObject({
      home: null,
      tags: ['ad'],
      defaultVersion: '2.0.0',
      versions: [
        { version: '1.0.0', url: 'https://example.com/1.0.0/x.apworld', local: null },
        { version: '2.0.0', url: null, local: null },
      ],
      releases: [
        {
          version: '3.1.0',
          minApVersion: '0.6.8',
          maxApVersion: null,
          url: null,
          local: '../apworlds/x.apworld',
        },
      ],
      bases: [],
    })
  })
})

describe('resolveIoniumRelease', () => {
  const lock = parseIoniumLock(fixtureText('index.lock'))

  it('reads index.lock as "<world>@<version>" → sha256', () => {
    expect(lock.get('pokemon_crystal@6.0.4')).toBe(SHA.crystal604)
    expect(lock.get('sms@0.5.2+hotfix1')).toBe(SHA.sms052)
    expect(lock.get('Twilight Princess@0.2.3')).toBe(
      '028c506f4c30f4896e1f381663ed73c0e7fc20c08604a0e0f78018012f371494',
    )
    expect(lock.has('sms@0.6.2')).toBe(false)
    expect(parseIoniumLock('[x\n')).toEqual(new Map())
    expect(parseIoniumLock('[x]\n"1.0.0" = "not a hash"\n"bad" = "' + 'a'.repeat(64) + '"\n')).toEqual(
      new Map(),
    )
  })

  it('resolves latest supported release for AP 0.6.8 with lock sha256 and url template', () => {
    expect(resolveIoniumRelease(ioniumWorld('pokemon_crystal'), '0.6.8', lock)).toEqual({
      version: '6.0.4',
      url: 'https://github.com/gerbiljames/Archipelago/releases/download/6.0.4/pokemon_crystal.apworld',
      sha256: SHA.crystal604,
    })
    // Gauntlet Legends: its releases stop at 0.6.7; from 0.6.8 on it is a core world.
    expect(resolveIoniumRelease(ioniumWorld('gl'), '0.6.7', lock)).toEqual({
      version: '2.1.7',
      url: 'https://github.com/jamesbrq/GauntletLegendsAP/releases/download/v2.1.7/gl.apworld',
      sha256: SHA.gl217,
    })
    expect(resolveIoniumRelease(ioniumWorld('gl'), '0.6.8', lock)).toBeNull()
    expect(resolveIoniumRelease(ioniumWorld('gl'), '0.6.9', lock)).toBeNull()
    // Without Archipelago: the version the app targets (0.6.8).
    expect(resolveIoniumRelease(ioniumWorld('gl'), null, lock)).toBeNull()
    expect(resolveIoniumRelease(ioniumWorld('pokemon_crystal'), null, lock)?.version).toBe('6.0.4')
    // No hash in the lock.
    expect(resolveIoniumRelease(ioniumWorld('sms'), '0.6.8', lock)).toEqual({
      version: '0.6.2',
      url: 'https://github.com/Joshark/archipelago-sms/releases/download/0.6.2/sms.apworld',
      sha256: null,
    })
    // A release served by the index itself.
    expect(resolveIoniumRelease(ioniumWorld('Twilight Princess'), '0.6.8', lock)).toEqual({
      version: '0.3.0',
      url: 'https://raw.githubusercontent.com/ionium-ap/Archipelago-index/main/apworlds/Twilight%20Princess-0.3.0.apworld',
      sha256: null,
    })
    // Disabled, or nothing but the core copy.
    expect(resolveIoniumRelease(ioniumWorld('celeste'), '0.6.8', lock)).toBeNull()
    expect(resolveIoniumRelease(ioniumWorld('hk'), '0.6.8', lock)).toBeNull()
  })

  it('respects default_version, [releases] bounds and [base] overrides', () => {
    // The example of the apwm README.
    const crystal = parseIoniumToml(
      [
        'name = "Pokemon Crystal"',
        'default_url = "https://example.com/{{version}}/pokemon_crystal.apworld"',
        '[versions]',
        '"5.4.6" = {}',
        '"6.0.0" = {}',
        '[releases]',
        '"5.4.6" = { max_ap_version = "0.6.7" }',
        '"7.0.0" = { min_ap_version = "0.6.8" }',
        '"7.0.1" = { min_ap_version = "0.6.8", url = "https://example.com/7.0.1-hotfix/pokemon_crystal.apworld" }',
      ].join('\n'),
      'pokemon_crystal',
    )
    if (!crystal) throw new Error('does not parse')
    expect(resolveIoniumRelease(crystal, '0.6.7', lock)?.version).toBe('6.0.0')
    expect(resolveIoniumRelease(crystal, '0.6.8', lock)).toEqual({
      version: '7.0.1',
      url: 'https://example.com/7.0.1-hotfix/pokemon_crystal.apworld',
      sha256: null,
    })
    const pinned = { ...crystal, defaultVersion: '7.0.0' }
    expect(resolveIoniumRelease(pinned, '0.6.8', lock)?.url).toBe(
      'https://example.com/7.0.0/pokemon_crystal.apworld',
    )
    expect(resolveIoniumRelease(pinned, '0.6.7', lock)).toBeNull()
    expect(resolveIoniumRelease({ ...crystal, defaultVersion: 'disabled' }, '0.6.8', lock)).toBeNull()
    expect(resolveIoniumRelease({ ...crystal, defaultVersion: 'latest_supported' }, '0.6.8', lock)).toBeNull()

    const sms = { ...ioniumWorld('sms'), defaultVersion: '0.5.2+hotfix1' }
    expect(resolveIoniumRelease(sms, '0.6.8', lock)).toEqual({
      version: '0.5.2+hotfix1',
      url: 'https://github.com/Joshark/archipelago-sms/releases/download/0.5.2/sms.apworld',
      sha256: SHA.sms052,
    })

    // Disabled at the top (what older lobbies see), switched back on for the newer bases.
    const later = parseIoniumToml(
      [
        'name = "Later"',
        'disabled = true',
        'default_url = "https://example.com/{{version}}/later.apworld"',
        '[releases]',
        '"1.0.0" = { min_ap_version = "0.6.8" }',
        '[base.">=0.6.8"]',
        'disabled = false',
      ].join('\n'),
      'later',
    )
    if (!later) throw new Error('does not parse')
    expect(resolveIoniumRelease(later, '0.6.7', lock)).toBeNull()
    expect(resolveIoniumRelease(later, '0.6.8', lock)?.version).toBe('1.0.0')
    // A bare requirement is a caret requirement, as in Rust's semver.
    const caret = {
      ...later,
      bases: [{ ...later.bases[0], requirement: '0.6.8' } as IoniumWorld['bases'][number]],
    }
    expect(resolveIoniumRelease(caret, '0.6.9', lock)?.version).toBe('1.0.0')
    expect(resolveIoniumRelease(caret, '0.7.0', lock)).toBeNull()
  })

  it('refuses plain http links and local paths outside the index', () => {
    const world = (source: string): IoniumWorld | null =>
      parseIoniumToml(`name = "X"\n[versions]\n"1.0.0" = ${source}\n`, 'x')
    const http = world('{ url = "http://example.com/x.apworld" }')
    const escape = world('{ local = "../../../evil/x.apworld" }')
    const noUrl = world('{}')
    for (const candidate of [http, escape, noUrl]) {
      if (!candidate) throw new Error('does not parse')
      expect(resolveIoniumRelease(candidate, '0.6.8', lock)).toBeNull()
    }
  })
})

describe('parseWikiPages', () => {
  it('parses wiki infobox JSON string fields', () => {
    const first = parseWikiPages(fixtureJson('wiki-page1.json'))
    expect(first.map((page) => page.title)).toEqual([
      'A Link to the Past',
      'Celeste',
      'Gauntlet Legends',
      'Hollow Knight',
    ])
    expect(first.find((page) => page.title === 'Hollow Knight')).toEqual({
      title: 'Hollow Knight',
      status: 'Core-verified',
      maintainer: 'BadMagic100, qwint',
      setupUrl: 'https://archipelago.gg/tutorial/#Hollow%20Knight',
      homepage: 'https://github.com/ArchipelagoMW-HollowKnight/Archipelago.HollowKnight',
      download: null,
      repos: ['archipelagomw-hollowknight/archipelago.hollowknight'],
      // The wiki has no thumbnail of this picture: it is the picture itself.
      cover: 'https://static.wikitide.net/archipelagowiki/7/75/Hollow_Knight_Cover.png',
    })

    const second = parseWikiPages(fixtureJson('wiki-page2.json'))
    const page = (title: string): WikiPage | undefined =>
      second.find((candidate) => candidate.title === title)
    expect(page('Minecraft')).toEqual({
      title: 'Minecraft',
      status: 'Custom',
      maintainer: 'qixils (current), KonoTyran (former)',
      setupUrl: 'https://github.com/qixils/NeoForgeAP/blob/mc/26.2/README.md',
      homepage: 'https://github.com/qixils/NeoForgeAP',
      download: {
        kind: 'github-latest',
        repo: 'qixils/neoforgeap',
        pageUrl: 'https://github.com/qixils/NeoForgeAP/releases/latest',
      },
      repos: ['qixils/neoforgeap'],
      cover:
        'https://static.wikitide.net/archipelagowiki/thumb/e/ea/Minecraftlogo.jpg/300px-Minecraftlogo.jpg',
    })
    // Several download links: the GitHub one gives the repository, the Thunderstore one nothing.
    expect(page('Schedule I')).toMatchObject({
      status: 'After Dark',
      maintainer: 'MacH8s',
      repos: ['mach8s/narcopelago'],
    })
    // A page without an infobox.
    expect(page('Sonic Adventure 2 Battle')).toEqual({
      title: 'Sonic Adventure 2 Battle',
      status: null,
      maintainer: null,
      setupUrl: null,
      homepage: null,
      download: null,
      repos: [],
      cover: null,
    })
    // A world only the wiki lists: its repository link, which is not the one it is downloaded from.
    expect(page('Frogmonster')).toEqual({
      title: 'Frogmonster',
      status: 'Custom',
      maintainer: 'RoobyRoo (APWorld), Ben Jungwirth (client)',
      setupUrl: 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/blob/main/README.md',
      homepage: 'https://github.com/Rooby-Roo/Archipelago/tree/Frogmonster',
      download: {
        kind: 'github-latest',
        repo: 'rooby-roo/frogmonsterapworld',
        pageUrl: 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/releases/latest',
      },
      repos: ['rooby-roo/archipelago', 'rooby-roo/frogmonsterapworld'],
      cover: 'https://static.wikitide.net/archipelagowiki/thumb/d/da/Frogmonster.jpg/300px-Frogmonster.jpg',
    })
    // Paragraphs are separated like line breaks.
    expect(page('Hexcells Infinite')?.maintainer).toBe('Heaxeus (old version), Chainsawkitten (fork)')
  })

  it('tells a download link to the latest GitHub release from a page to open', () => {
    const real = (title: string): WikiPage['download'] | undefined =>
      allPages().find((page) => page.title === title)?.download
    // /releases without a search lists the latest release first.
    expect(real('Hexcells Infinite')).toEqual({
      kind: 'github-latest',
      repo: 'chainsawkitten/hexcellsinfiniteap',
      pageUrl: 'https://github.com/Chainsawkitten/HexcellsInfiniteAP/releases',
    })
    // A search among the releases of a fork of many games.
    expect(real("Keymaster's Keep")).toEqual({
      kind: 'page',
      url: 'https://github.com/silasary/Archipelago/releases?q=%22Keymaster%27s+Keep%22&expanded=true',
    })
    expect(real('Kao the Kangaroo Round 2')).toEqual({
      kind: 'page',
      url: 'https://github.com/kierokeke/Kao-the-Kangaroo-Round-2-Archipelago/releases/tag/KaotheKangarooRound2',
    })
    // The first link counts: itch.io, though GitHub's latest release comes second.
    expect(real('BK Simulator')).toEqual({ kind: 'page', url: 'https://emilyv99.itch.io/bk-simulator' })
    // Two links, the APWorld's first.
    expect(real('Resident Evil 2 Remake')).toMatchObject({ repo: 'fuzzygameson/re2r_ap_world' })
    expect(real('Here Comes Niko!')).toBeNull()

    const download = (html: string): WikiPage['download'] | undefined => {
      const infoboxes = JSON.stringify([
        { data: [{ type: 'data', data: { source: 'ap-download', value: html } }] },
      ])
      return parseWikiPages({ query: { pages: [{ title: 'X', pageprops: { infoboxes } }] } })[0]?.download
    }
    const link = (href: string): string => `<a href="${href}">GitHub</a>`
    const latest = (repo: string, pageUrl: string): WikiPage['download'] => ({
      kind: 'github-latest',
      repo,
      pageUrl,
    })
    for (const href of [
      'https://github.com/Owner/Repo/releases/latest',
      'https://github.com/Owner/Repo/releases/latest/',
      'https://github.com/Owner/Repo/releases/',
      'https://www.github.com/Owner/Repo/releases',
      'http://github.com/Owner/Repo/releases/latest#assets',
    ]) {
      expect(download(link(href)), href).toEqual(latest('owner/repo', href))
    }
    for (const href of [
      'https://github.com/Owner/Repo/releases?q=Game&expanded=true',
      'https://github.com/Owner/Repo/releases/latest?q=x',
      'https://github.com/Owner/Repo/releases/tag/v1.0.0',
      'https://github.com/Owner/Repo/releases/download/v1.0.0/game.apworld',
      'https://github.com/Owner/Repo/blob/main/game.apworld',
      'https://github.com/Owner/Repo/raw/main/game.apworld',
      'https://github.com/Owner/Repo',
      'https://gitlab.com/owner/repo/-/releases',
      'https://codeberg.org/owner/repo/releases/latest',
      'https://owner.itch.io/game',
    ]) {
      expect(download(link(href)), href).toEqual({ kind: 'page', url: href })
    }
    expect(download('GitHub (soon)')).toBeNull()
    expect(download(link('javascript:alert(1)'))).toBeNull()
  })

  it('decodes HTML entities and ignores what is not an API answer', () => {
    const infobox = JSON.stringify([
      {
        data: [
          {
            type: 'group',
            data: {
              value: [
                {
                  type: 'data',
                  data: {
                    source: 'ap-maintainer',
                    value: 'Ann &amp; Bob &#39;B&#x27; <b>x</b> &constructor;',
                  },
                },
                { type: 'data', data: { source: 'ap-status', value: '  ' } },
                {
                  type: 'data',
                  data: {
                    source: 'ap-setuplink',
                    value:
                      '<a href="javascript:alert(1)">x</a> <a href="/wiki/Setup_Guide?a=1&amp;b=2">guide</a>',
                  },
                },
                {
                  type: 'data',
                  data: { source: 'ap-repolink', value: '<a href="https://github.com/Foo/Bar.git">a</a>' },
                },
                {
                  type: 'data',
                  data: {
                    source: 'ap-download',
                    value: '<a href="//github.com/foo/bar/releases/latest">b</a>',
                  },
                },
              ],
            },
          },
        ],
      },
    ])
    expect(
      parseWikiPages({ query: { pages: [{ title: 'Tom &amp; Jerry', pageprops: { infoboxes: infobox } }] } }),
    ).toEqual([
      {
        title: 'Tom &amp; Jerry',
        status: null,
        maintainer: "Ann & Bob 'B' x &constructor;",
        setupUrl: 'https://archipelago.miraheze.org/wiki/Setup_Guide?a=1&b=2',
        homepage: 'https://github.com/Foo/Bar.git',
        download: {
          kind: 'github-latest',
          repo: 'foo/bar',
          pageUrl: 'https://github.com/foo/bar/releases/latest',
        },
        repos: ['foo/bar'],
        cover: null,
      },
    ])
    expect(parseWikiPages(null)).toEqual([])
    expect(
      parseWikiPages({ query: { pages: [{ pageid: 1 }, { title: 'Bad', pageprops: { infoboxes: '{' } }] } }),
    ).toEqual([
      {
        title: 'Bad',
        status: null,
        maintainer: null,
        setupUrl: null,
        homepage: null,
        download: null,
        repos: [],
        cover: null,
      },
    ])
  })

  it('reads the boxart thumbnail of an infobox', () => {
    const real = (title: string): string | null | undefined =>
      allPages().find((page) => page.title === title)?.cover
    // Protocol-relative links are made https; the 300 px thumbnail is preferred to the picture.
    expect(real('Frogmonster')).toBe(
      'https://static.wikitide.net/archipelagowiki/thumb/d/da/Frogmonster.jpg/300px-Frogmonster.jpg',
    )
    expect(real('Pokemon Crystal')).toBe(
      'https://static.wikitide.net/archipelagowiki/thumb/f/fe/Pokemoncrystal.png/300px-Pokemoncrystal.png',
    )
    // An absolute link keeps its query string (Wikimedia Commons pictures carry one).
    expect(real('Celeste')).toBe(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/0f/Celeste_box_art_full.png/330px-Celeste_box_art_full.png?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
    )

    const cover = (...items: unknown[]): string | null | undefined => {
      const infoboxes = JSON.stringify([{ data: items }])
      return parseWikiPages({ query: { pages: [{ title: 'X', pageprops: { infoboxes } }] } })[0]?.cover
    }
    const media = (...images: unknown[]): unknown => ({ type: 'media', data: images })
    const image = (fields: Record<string, unknown>): Record<string, unknown> => ({
      isImage: true,
      source: 'boxart',
      ...fields,
    })
    // Without a thumbnail, the picture itself.
    expect(cover(media(image({ url: '//static.wikitide.net/a/a1/Game.png' })))).toBe(
      'https://static.wikitide.net/a/a1/Game.png',
    )
    expect(
      cover(media(image({ url: 'https://upload.wikimedia.org/x/Game.png?a=1&b=2', thumbnail: '' }))),
    ).toBe('https://upload.wikimedia.org/x/Game.png?a=1&b=2')
    // The boxart, though another picture comes first; else the first picture.
    expect(
      cover(
        media(
          image({ source: 'logo', url: '//static.wikitide.net/logo.png' }),
          image({ url: '//static.wikitide.net/box.png', thumbnail: '//static.wikitide.net/t/box.png' }),
        ),
      ),
    ).toBe('https://static.wikitide.net/t/box.png')
    expect(
      cover(
        media(image({ source: 'logo', url: '//static.wikitide.net/logo.png' })),
        media(image({ source: 'screenshot', url: '//static.wikitide.net/shot.png' })),
      ),
    ).toBe('https://static.wikitide.net/logo.png')
    // A picture inside a group of the infobox.
    expect(
      cover({
        type: 'group',
        data: { value: [media(image({ url: '//static.wikitide.net/grouped.png' }))] },
      }),
    ).toBe('https://static.wikitide.net/grouped.png')
    // Only web links: a thumbnail that is not one gives way to the picture.
    expect(
      cover(media(image({ url: '//static.wikitide.net/box.png', thumbnail: 'javascript:alert(1)' }))),
    ).toBe('https://static.wikitide.net/box.png')
    expect(cover(media(image({ url: 'data:image/png;base64,AAAA', thumbnail: 'ftp://x/y.png' })))).toBeNull()
  })

  it('a page without media has cover null', () => {
    const real = (title: string): string | null | undefined =>
      allPages().find((page) => page.title === title)?.cover
    // The real pages with no picture: no infobox at all, or an infobox without one.
    expect(real('Sonic Adventure 2 Battle')).toBeNull()
    expect(real("Keymaster's Keep")).toBeNull()
    expect(real('Hunie Pop')).toBeNull()

    const cover = (infoboxes: unknown): string | null | undefined =>
      parseWikiPages({ query: { pages: [{ title: 'X', pageprops: { infoboxes } }] } })[0]?.cover
    const withItem = (item: unknown): string => JSON.stringify([{ data: [item] }])
    expect(cover(undefined)).toBeNull()
    expect(cover('{')).toBeNull()
    // Not an image, no image flag, no address, an empty list, data that is not a list.
    for (const item of [
      { type: 'media', data: [{ isImage: false, isVideo: true, url: '//static.wikitide.net/v.webm' }] },
      { type: 'media', data: [{ url: '//static.wikitide.net/unknown.png' }] },
      { type: 'media', data: [{ isImage: true, source: 'boxart' }] },
      { type: 'media', data: [] },
      { type: 'media', data: { isImage: true, url: '//static.wikitide.net/table.png' } },
      { type: 'data', data: { source: 'boxart', value: '//static.wikitide.net/data.png' } },
    ]) {
      expect(cover(withItem(item)), JSON.stringify(item)).toBeNull()
    }
  })
})

describe('joinCatalog', () => {
  it('joins ionium and wiki by game then repo and sets trust indexed-verified when sha present', () => {
    const installed = [
      installedWorld({
        module: 'pokemon_crystal',
        game: 'Pokemon Crystal',
        manifest: manifest('Pokemon Crystal', '6.0.0'),
      }),
      // No manifest: found by its module, its version is unknown.
      installedWorld({ module: 'sms', states: ['no-manifest'] }),
      // A manifest without world_version.
      installedWorld({ module: 'mc', game: 'Minecraft', manifest: manifest('Minecraft', null) }),
      // Disabled: Archipelago does not see it.
      installedWorld({
        module: 'pmd_eos',
        location: 'disabled',
        game: 'Pokemon Mystery Dungeon Explorers of Sky',
      }),
    ]
    const entries = joinCatalog(allWorlds(), allPages(), installed, joinOptions())
    // celeste is disabled in the index. Then the pages of the wiki no world of the index is joined to.
    expect(entries.map((entry) => entry.id)).toEqual([
      'Schedule_I',
      'Twilight Princess',
      'gl',
      'hk',
      'minecraft',
      'pmd_eos',
      'pokemon_crystal',
      'sms',
      'wiki:BK Simulator',
      'wiki:Frogmonster',
      'wiki:Here Comes Niko!',
      'wiki:Hexcells Infinite',
      'wiki:Hunie Pop',
      'wiki:Kao the Kangaroo Round 2',
      "wiki:Keymaster's Keep",
      'wiki:Resident Evil 2 Remake',
    ])
    const entry = byId(entries)
    expect(entries.filter((e) => e.source === 'index').every((e) => e.download === null)).toBe(true)

    expect(entry.pokemon_crystal).toEqual({
      id: 'pokemon_crystal',
      source: 'index',
      game: 'Pokemon Crystal',
      displayName: 'Pokemon Crystal',
      homepage: 'https://discord.com/channels/731205301247803413/1365127145709502575',
      tags: [],
      supported: false,
      afterDark: false,
      requiresRomAtGeneration: false,
      hasPopTracker: true,
      cover:
        'https://static.wikitide.net/archipelagowiki/thumb/f/fe/Pokemoncrystal.png/300px-Pokemoncrystal.png',
      wiki: {
        title: 'Pokemon Crystal',
        url: 'https://archipelago.miraheze.org/wiki/Pokemon_Crystal',
        status: 'Custom',
        maintainer: 'gerbiljames, AliceMousie (former)',
        setupUrl:
          'https://github.com/gerbiljames/Archipelago-Crystal/blob/pokecrystal/worlds/pokemon_crystal/docs/setup_en.md',
      },
      latest: {
        version: '6.0.4',
        url: 'https://github.com/gerbiljames/Archipelago/releases/download/6.0.4/pokemon_crystal.apworld',
        sha256: SHA.crystal604,
      },
      download: null,
      installedVersion: '6.0.0',
      trust: 'indexed-verified',
    })

    // The wiki page is named differently: joined by its GitHub repository.
    expect(entry.pmd_eos).toMatchObject({
      wiki: {
        title: 'Pokémon Mystery Dungeon: Explorers of Sky',
        url: 'https://archipelago.miraheze.org/wiki/Pok%C3%A9mon_Mystery_Dungeon%3A_Explorers_of_Sky',
      },
      latest: { version: '0.3.2', sha256: SHA.pmd032 },
      installedVersion: null,
      trust: 'indexed-verified',
    })

    // Shipped with Archipelago 0.6.8: core, nothing to download, installed with Archipelago.
    expect(entry.gl).toMatchObject({
      supported: true,
      latest: null,
      installedVersion: '0.6.8',
      trust: 'core',
      wiki: { title: 'Gauntlet Legends', status: 'Core-verified' },
      hasPopTracker: true,
    })
    expect(entry.hk).toMatchObject({
      supported: true,
      latest: null,
      installedVersion: '0.6.8',
      trust: 'core',
    })

    // No hash, but a release of the repository the wiki links to.
    expect(entry.sms).toMatchObject({
      latest: { version: '0.6.2', sha256: null },
      installedVersion: 'unknown',
      trust: 'wiki-release',
    })
    // No hash and not a GitHub release.
    expect(entry['Twilight Princess']).toMatchObject({
      latest: { version: '0.3.0', sha256: null },
      trust: 'unknown',
    })
    expect(entry.minecraft).toMatchObject({
      displayName: 'Minecraft NeoForge',
      latest: { version: '2.2.1', sha256: SHA.minecraft221 },
      installedVersion: 'unknown',
      trust: 'indexed-verified',
      wiki: { title: 'Minecraft', maintainer: 'qixils (current), KonoTyran (former)' },
    })
    expect(entry.Schedule_I).toMatchObject({
      tags: ['ad'],
      afterDark: true,
      latest: {
        version: '3.6.4',
        url: 'https://github.com/MacH8s/Narcopelago/releases/download/v3.6.4/Schedule_I.apworld',
        sha256: SHA.schedule364,
      },
      wiki: { status: 'After Dark' },
    })
  })

  it('tells core worlds apart from the installed Archipelago, and lists what has no compatible release', () => {
    const later = parseIoniumToml(
      'name = "Later"\ndefault_url = "https://example.com/{{version}}/later.apworld"\n[releases]\n"1.0.0" = { min_ap_version = "0.6.9" }\n',
      'later',
    )
    if (!later) throw new Error('does not parse')
    const worlds = [...allWorlds(), later]
    const at067 = byId(joinCatalog(worlds, [], [], joinOptions({ apVersion: '0.6.7' })))
    // 0.6.7 has no core table here: Gauntlet Legends is a custom world there, with its last release.
    expect(at067.gl).toMatchObject({
      supported: false,
      latest: { version: '2.1.7' },
      trust: 'indexed-verified',
    })
    expect(at067.later).toMatchObject({ latest: null, trust: 'unknown', installedVersion: null })
    // A core world found in Archipelago's own folder counts as core whatever the tables say.
    const core = installedWorld({
      module: 'gl',
      location: 'core',
      game: 'Gauntlet Legends',
      path: '/ap/lib/worlds/gl.apworld',
    })
    expect(byId(joinCatalog(worlds, [], [core], joinOptions({ apVersion: '0.6.7' }))).gl).toMatchObject({
      latest: null,
      trust: 'core',
      installedVersion: '0.6.7',
    })
    // Archipelago not installed: core worlds of the version the app targets, installed nowhere.
    expect(byId(joinCatalog(worlds, [], [], joinOptions({ apVersion: null }))).hk).toMatchObject({
      trust: 'core',
      latest: null,
      installedVersion: null,
    })
  })

  it('hides after dark entries unless showAfterDark', () => {
    // Schedule I is tagged "ad" in the index; Super Mario Sunshine is put in the wiki's category here.
    // Resident Evil 2 Remake is in the category; Hunie Pop only says "After Dark" in its status.
    const afterDarkTitles = new Set([...memberTitles('wiki-afterdark.json'), 'Super Mario Sunshine'])
    const shown = joinCatalog(
      allWorlds(),
      allPages(),
      [],
      joinOptions({ afterDarkTitles, showAfterDark: true }),
    )
    const afterDark = ['Schedule_I', 'sms', 'wiki:Hunie Pop', 'wiki:Resident Evil 2 Remake']
    expect(shown.filter((entry) => entry.afterDark).map((entry) => entry.id)).toEqual(afterDark)
    const hidden = joinCatalog(
      allWorlds(),
      allPages(),
      [],
      joinOptions({ afterDarkTitles, showAfterDark: false }),
    )
    for (const id of afterDark) expect(hidden.map((entry) => entry.id)).not.toContain(id)
    expect(hidden).toHaveLength(shown.length - afterDark.length)
  })

  it('excludes games and repos listed in catalog-optout.json', () => {
    expect(optOutFile).toEqual({ games: [], repos: [] })
    const optOut = { games: ['Pokemon Crystal'], repos: ['joshark/Archipelago-SMS'] }
    const ids = joinCatalog(allWorlds(), allPages(), [], joinOptions({ optOut })).map((entry) => entry.id)
    expect(ids).not.toContain('pokemon_crystal')
    expect(ids).not.toContain('sms')
    expect(ids).toContain('pmd_eos')
    // Their wiki pages do not bring them back.
    expect(ids.filter((id) => id.startsWith('wiki:'))).toHaveLength(8)

    // A world only the wiki lists: by its game (accents and case set aside), or by any of its repositories.
    const wikiOptOut = { games: ['FROGMONSTER'], repos: ['Chainsawkitten/HexcellsInfiniteAPWorld'] }
    const left = joinCatalog(allWorlds(), allPages(), [], joinOptions({ optOut: wikiOptOut })).map(
      (e) => e.id,
    )
    expect(left).not.toContain('wiki:Frogmonster')
    expect(left).not.toContain('wiki:Hexcells Infinite')
    expect(left).toContain('wiki:BK Simulator')
  })

  it('builds an entry for a world only the wiki lists, its release asked when it is installed', () => {
    const entries = byId(joinCatalog(allWorlds(), allPages(), [], joinOptions()))
    expect(entries['wiki:Frogmonster']).toEqual({
      id: 'wiki:Frogmonster',
      source: 'wiki',
      game: 'Frogmonster',
      displayName: 'Frogmonster',
      homepage: 'https://github.com/Rooby-Roo/Archipelago/tree/Frogmonster',
      tags: [],
      supported: false,
      afterDark: false,
      requiresRomAtGeneration: false,
      hasPopTracker: false,
      cover: 'https://static.wikitide.net/archipelagowiki/thumb/d/da/Frogmonster.jpg/300px-Frogmonster.jpg',
      wiki: {
        title: 'Frogmonster',
        url: 'https://archipelago.miraheze.org/wiki/Frogmonster',
        status: 'Custom',
        maintainer: 'RoobyRoo (APWorld), Ben Jungwirth (client)',
        setupUrl: 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/blob/main/README.md',
      },
      latest: null,
      download: {
        kind: 'github-latest',
        repo: 'rooby-roo/frogmonsterapworld',
        pageUrl: 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/releases/latest',
      },
      installedVersion: null,
      trust: 'wiki-release',
    })
    expect(isInstallable(entries['wiki:Frogmonster'] as CatalogEntry)).toBe(true)
    // A link to open in the browser, or none: nothing the app installs, nothing it vouches for.
    expect(entries["wiki:Keymaster's Keep"]).toMatchObject({
      homepage: null,
      download: { kind: 'page' },
      trust: 'unknown',
      wiki: { url: "https://archipelago.miraheze.org/wiki/Keymaster's_Keep" },
    })
    expect(entries['wiki:Here Comes Niko!']).toMatchObject({
      homepage: 'https://github.com/niieli/Niko-Archipelago',
      download: null,
      trust: 'unknown',
    })
    for (const id of ["wiki:Keymaster's Keep", 'wiki:Here Comes Niko!']) {
      expect(isInstallable(entries[id] as CatalogEntry), id).toBe(false)
    }
    // The wiki's categories, as for the worlds of the index.
    const tagged = byId(
      joinCatalog(
        allWorlds(),
        allPages(),
        [],
        joinOptions({ romTitles: new Set(['Frogmonster']), popTrackerTitles: new Set(['Frogmonster']) }),
      ),
    )
    expect(tagged['wiki:Frogmonster']).toMatchObject({ requiresRomAtGeneration: true, hasPopTracker: true })
  })

  it('index entries joined to a wiki page carry its cover, wiki entries too', () => {
    const entries = byId(joinCatalog(allWorlds(), allPages(), [], joinOptions()))
    const thumb = (path: string): string => `https://static.wikitide.net/archipelagowiki/${path}`
    // Joined by game name, and by repository (the page is named otherwise).
    expect(entries.pokemon_crystal?.cover).toBe(
      thumb('thumb/f/fe/Pokemoncrystal.png/300px-Pokemoncrystal.png'),
    )
    expect(entries.pmd_eos?.cover).toBe(thumb('thumb/7/7b/Explorers_of_Sky.jpg/299px-Explorers_of_Sky.jpg'))
    // A picture the wiki holds only at full size.
    expect(entries.hk?.cover).toBe(thumb('7/75/Hollow_Knight_Cover.png'))
    // The wiki entries: the page's own.
    expect(entries['wiki:Frogmonster']?.cover).toBe(thumb('thumb/d/da/Frogmonster.jpg/300px-Frogmonster.jpg'))
    expect(entries['wiki:BK Simulator']?.cover).toBe(thumb('3/38/BK_Simulator_Cover.png'))
    // A wiki page with no picture.
    expect(entries["wiki:Keymaster's Keep"]?.cover).toBeNull()
    // An index entry no page is joined to has none.
    const alone = joinCatalog(allWorlds(), [], [], joinOptions())
    expect(alone.length).toBeGreaterThan(0)
    expect(alone.map((entry) => entry.cover)).toEqual(alone.map(() => null))
  })

  it('never lists twice a world of the index, nor one it disables, nor one shipped with Archipelago', () => {
    const page = madePage
    const latest = (repo: string): WikiPage['download'] => ({
      kind: 'github-latest',
      repo,
      pageUrl: `https://github.com/${repo}/releases/latest`,
    })
    const pages = [
      ...allPages(),
      // Named like a world of the index (its display name; accents and case set aside).
      page('Minecraft NeoForge'),
      page('POKÉMON CRYSTAL'),
      // Downloaded from the repository a world of the index is released from.
      page('Crystal Clear', { download: latest('gerbiljames/archipelago') }),
      // A search in that same fork may be another game: it stays.
      page('Crystal Fork', {
        download: { kind: 'page', url: 'https://github.com/gerbiljames/Archipelago/releases?q=Fork' },
      }),
      // Core-verified, though missing from the core table.
      page('Future Core', { status: 'Core-verified' }),
    ]
    const ids = joinCatalog(allWorlds(), pages, [], joinOptions()).map((entry) => entry.id)
    const wikiIds = ids.filter((id) => id.startsWith('wiki:'))
    // Joined to a world of the index (by name or by repository): Pokemon Crystal, Pokémon Mystery
    // Dungeon, Minecraft... Celeste is disabled by the index for 0.6.8 and does not come back. A Link to
    // the Past (Core-verified) and Sonic Adventure 2 Battle (no status) ship with Archipelago 0.6.8.
    expect(wikiIds).toEqual([
      'wiki:BK Simulator',
      'wiki:Crystal Fork',
      'wiki:Frogmonster',
      'wiki:Here Comes Niko!',
      'wiki:Hexcells Infinite',
      'wiki:Hunie Pop',
      'wiki:Kao the Kangaroo Round 2',
      "wiki:Keymaster's Keep",
      'wiki:Resident Evil 2 Remake',
    ])
    expect(ids).not.toContain('celeste')

    // A core world found in Archipelago's own folder counts too.
    const core = installedWorld({ module: 'frog', location: 'core', game: 'Frogmonster' })
    expect(joinCatalog(allWorlds(), allPages(), [core], joinOptions()).map((e) => e.id)).not.toContain(
      'wiki:Frogmonster',
    )
    // Without the index, no page can be told apart from the worlds it lists.
    expect(joinCatalog([], allPages(), [], joinOptions())).toEqual([])
  })

  it('never brings back through its repository a page joined to a world disabled, opted out or hidden', () => {
    // Each page has a title of its own and is joined to its world by repository alone; its download
    // (a page to open, or none) is from no repository of the index either.
    const pages = [
      ...allPages().filter(
        (page) =>
          !['Celeste', 'Schedule I', 'Pokémon Mystery Dungeon: Explorers of Sky'].includes(page.title),
      ),
      madePage('Celeste Classic', {
        repos: ['doshyw/celestearchipelago'],
        download: { kind: 'page', url: 'https://example.org/celeste' },
      }),
      madePage('Explorers of Sky', {
        repos: ['crypticmonkey33/archipelagoexplorersofsky'],
        download: { kind: 'page', url: 'https://example.org/eos' },
      }),
      madePage('Narcopelago', { repos: ['mach8s/narcopelago'] }),
    ]
    const wikiIds = (opts: Partial<JoinOptions>): string[] =>
      joinCatalog(allWorlds(), pages, [], joinOptions(opts))
        .map((entry) => entry.id)
        .filter((id) => id.startsWith('wiki:'))
    const madeUp = ['wiki:Celeste Classic', 'wiki:Explorers of Sky', 'wiki:Narcopelago']
    // Celeste is disabled for 0.6.8; Schedule I is After Dark (hidden, then shown); Explorers of Sky
    // is listed, then opted out by its game.
    for (const opts of [
      { showAfterDark: false },
      { showAfterDark: true },
      { optOut: { games: ['Pokemon Mystery Dungeon Explorers of Sky'], repos: [] } },
    ]) {
      const listed = wikiIds(opts)
      for (const id of madeUp) expect(listed, `${id} ${JSON.stringify(opts)}`).not.toContain(id)
    }
    // Not joined to any world (the repository leads to no file of the index), the same page is listed.
    const alone = madePage('Celeste Classic', {
      repos: ['someone/celeste-classic'],
      download: { kind: 'page', url: 'https://example.org/celeste' },
    })
    expect(joinCatalog(allWorlds(), [alone], [], joinOptions()).map((entry) => entry.id)).toContain(
      'wiki:Celeste Classic',
    )
  })

  it('never brings back a disabled world whose page differs by its punctuation or bears its file name', () => {
    // Real files of the index: both disabled, neither released from GitHub (no repository to join by).
    const disabled = ['factorio_saws', 'apsudoku'].map((stem) => {
      const world = parseIoniumToml(fixtureText(`disabled/${stem}.toml`), stem)
      if (!world) throw new Error(`fixture ${stem} does not parse`)
      return world
    })
    // Their real pages: "Factorio: Space Age Without Space" (a release search in a fork) and "APSudoku".
    const pages = [...allPages(), ...parseWikiPages(fixtureJson('wiki-disabled.json'))]
    const factorio = 'wiki:Factorio: Space Age Without Space'
    // Unknown to the index, both pages are listed.
    const unknown = joinCatalog(allWorlds(), pages, [], joinOptions()).map((entry) => entry.id)
    expect(unknown).toEqual(expect.arrayContaining([factorio, 'wiki:APSudoku']))

    const ids = joinCatalog([...allWorlds(), ...disabled], pages, [], joinOptions()).map((entry) => entry.id)
    expect(ids).not.toContain(factorio)
    expect(ids).not.toContain('wiki:APSudoku')
    expect(ids).not.toContain('factorio_saws')
  })

  it('gives a wiki entry the version of the installed custom world of its game', () => {
    const installed = [
      installedWorld({
        module: 'frogmonster',
        game: 'frogmonster',
        manifest: manifest('frogmonster', '0.2.4'),
      }),
      installedWorld({
        module: 'hexcells',
        game: 'Hexcells Infinite',
        manifest: manifest('Hexcells Infinite', null),
      }),
      // Disabled: Archipelago does not see it.
      installedWorld({ module: 'bk', location: 'disabled', game: 'BK Simulator' }),
      // Its game written otherwise than the title of its page (as "AP_10" for the page "AP 10").
      installedWorld({
        module: 'kao2',
        game: 'Kao_the_Kangaroo:Round_2',
        manifest: manifest('Kao_the_Kangaroo:Round_2', '1.1.0'),
      }),
      // No game known: by its module.
      installedWorld({ module: 'here_comes_niko' }),
    ]
    const entries = byId(joinCatalog(allWorlds(), allPages(), installed, joinOptions()))
    expect(entries['wiki:Frogmonster']?.installedVersion).toBe('0.2.4')
    expect(entries['wiki:Hexcells Infinite']?.installedVersion).toBe('unknown')
    expect(entries['wiki:BK Simulator']?.installedVersion).toBeNull()
    expect(entries['wiki:Kao the Kangaroo Round 2']?.installedVersion).toBe('1.1.0')
    expect(entries['wiki:Here Comes Niko!']?.installedVersion).toBe('unknown')
    expect(entries['wiki:Resident Evil 2 Remake']?.installedVersion).toBeNull()
  })
})

// --- the catalog service --------------------------------------------------------------------------

describe('createCatalog', () => {
  let root: string
  let core: TestCore
  let remote: FakeRemote
  let install: ApInstall | null
  let clock: number

  const HOUR = 60 * 60 * 1000
  const START = Date.parse('2026-10-17T08:00:00.000Z')

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

  const catalogDir = (): string => join(core.ctx.platform.paths.dataRoot, 'catalog')
  const newCatalog = (): Catalog =>
    createCatalog(core.ctx, { locator: { detect: () => Promise.resolve(install) }, now: () => clock })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goat catalog é-'))
    core = createTestContext(root)
    remote = makeRemote()
    core.ctx.http = createHttp({
      userAgent: 'Test/1.0 (unit)',
      cacheDir: catalogDir(),
      log: silentLogger,
      githubToken: () => null,
      fetch: fakeFetch(remote),
    })
    const paths = apPaths(join(root, 'Archipelago'))
    mkdirSync(paths.customWorlds, { recursive: true })
    install = { kind: 'custom', version: '0.6.8', root: paths.localPath, appImagePath: null, paths }
    clock = START
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('fetches the tree once, the files of the index and every page of the wiki', async () => {
    const snapshot = await newCatalog().snapshot(false)
    expect(snapshot).toMatchObject({ fetchedAt: '2026-10-17T08:00:00.000Z', stale: false, errors: [] })
    // After Dark worlds stay hidden: Schedule I, Hunie Pop and Resident Evil 2 Remake.
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'Twilight Princess',
      'gl',
      'hk',
      'minecraft',
      'pmd_eos',
      'pokemon_crystal',
      'sms',
      'wiki:BK Simulator',
      'wiki:Frogmonster',
      'wiki:Here Comes Niko!',
      'wiki:Hexcells Infinite',
      'wiki:Kao the Kangaroo Round 2',
      "wiki:Keymaster's Keep",
    ])
    expect(apiRequests(remote)).toEqual([`https://api.github.com${TREE_PATH}?recursive=1`])
    expect(rawRequests(remote).sort()).toEqual([...remote.files.keys()].sort())
    // Two pages of implementations (gcmcontinue), then the three categories; CORS-style anonymous calls.
    expect(wikiRequests(remote)).toHaveLength(5)
    for (const url of wikiRequests(remote)) expect(new URL(url).searchParams.get('origin')).toBe('*')
    expect(readdirSync(join(catalogDir(), 'blobs'))).toHaveLength(remote.files.size)
  })

  it('lookupByGame finds entry by exact manifest game name', async () => {
    if (!install) throw new Error('no install')
    await makeApworld(join(install.paths.customWorlds, 'pokemon_crystal.apworld'), {
      manifest: apworldManifest('Pokemon Crystal', { world_version: '6.0.0' }),
    })
    const catalog = newCatalog()
    expect(catalog.lookupByGame('Pokemon Crystal')).toBeNull()
    await catalog.snapshot(false)
    expect(catalog.lookupByGame('Pokemon Crystal')).toMatchObject({
      id: 'pokemon_crystal',
      installedVersion: '6.0.0',
      latest: { version: '6.0.4' },
    })
    expect(catalog.lookupByGame('pokemon crystal')).toBeNull()
    expect(catalog.lookupByGame('Hollow Knight')).toMatchObject({ id: 'hk', trust: 'core' })
    expect(catalog.lookup('pokemon_crystal')?.game).toBe('Pokemon Crystal')
    expect(catalog.lookup('celeste')).toBeNull()
    // Nor does its wiki page bring it back.
    expect(catalog.lookupByGame('Celeste')).toBeNull()
    // Worlds only the wiki lists, by their page title.
    expect(catalog.lookupByGame('Frogmonster')).toMatchObject({
      id: 'wiki:Frogmonster',
      source: 'wiki',
      latest: null,
      download: { kind: 'github-latest', repo: 'rooby-roo/frogmonsterapworld' },
    })
    expect(catalog.lookup("wiki:Keymaster's Keep")?.download?.kind).toBe('page')
    // After Dark worlds are left out of the snapshot, and of the lookups, until the settings allow them.
    expect(catalog.lookup('Schedule_I')).toBeNull()
    expect(catalog.lookupByGame('Hunie Pop')).toBeNull()
    core.ctx.config.update({ showAfterDark: true })
    await catalog.snapshot(false)
    expect(catalog.lookupByGame('Schedule I')?.id).toBe('Schedule_I')
    expect(catalog.lookupByGame('Hunie Pop')?.id).toBe('wiki:Hunie Pop')
  })

  it('lookupByGame prefers the entry with a release to install', async () => {
    // Two files of the index for one game: the older one has no release any more.
    remote.files.set(
      'index/pokemon_crystal_old.toml',
      'name = "Pokemon Crystal"\ndefault_url = "https://example.com/{{version}}/x.apworld"\n[versions]\n',
    )
    const catalog = newCatalog()
    const snapshot = await catalog.snapshot(false)
    expect(snapshot.entries.filter((entry) => entry.game === 'Pokemon Crystal').map((e) => e.id)).toEqual([
      'pokemon_crystal',
      'pokemon_crystal_old',
    ])
    expect(catalog.lookupByGame('Pokemon Crystal')?.id).toBe('pokemon_crystal')
    expect(catalog.lookup('pokemon_crystal_old')).toMatchObject({ latest: null, download: null })
  })

  it('answers from the snapshot on disk while it is fresh, without the network', async () => {
    await newCatalog().snapshot(false)
    remote.requests = []
    clock = START + HOUR / 2
    const again = newCatalog()
    // The last snapshot is read back before anything is fetched.
    expect(again.lookup('pmd_eos')?.latest?.sha256).toBe(SHA.pmd032)
    // The covers are read back with it.
    expect(again.lookup('pokemon_crystal')?.cover).toBe(
      'https://static.wikitide.net/archipelagowiki/thumb/f/fe/Pokemoncrystal.png/300px-Pokemoncrystal.png',
    )
    expect(again.lookup("wiki:Keymaster's Keep")?.cover).toBeNull()
    expect(again.lookup('wiki:Hexcells Infinite')).toMatchObject({
      homepage: 'https://github.com/Chainsawkitten/HexcellsInfiniteAPWorld',
      download: { kind: 'github-latest', repo: 'chainsawkitten/hexcellsinfiniteap' },
    })
    const snapshot = await again.snapshot(false)
    expect(snapshot).toMatchObject({ fetchedAt: '2026-10-17T08:00:00.000Z', stale: false, errors: [] })
    expect(snapshot.entries).toHaveLength(13)
    expect(remote.requests).toEqual([])
  })

  it('the saved catalog of the previous version is dropped and fetched again', async () => {
    await newCatalog().snapshot(false)
    const file = join(catalogDir(), 'catalog.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      wiki: { pages: Record<string, unknown>[] }
    }
    expect(saved.version).toBe(3)
    expect(saved.wiki.pages.some((page) => typeof page.cover === 'string')).toBe(true)
    // What version 2 wrote: wiki pages without their cover.
    const older = {
      ...saved,
      version: 2,
      wiki: {
        ...saved.wiki,
        pages: saved.wiki.pages.map((page) =>
          Object.fromEntries(Object.entries(page).filter(([key]) => key !== 'cover')),
        ),
      },
    }
    writeFileSync(file, JSON.stringify(older))
    remote.requests = []
    clock = START + HOUR / 2

    const again = newCatalog()
    expect(again.lookup('pmd_eos')).toBeNull()
    const snapshot = await again.snapshot(false)
    expect(snapshot).toMatchObject({ fetchedAt: '2026-10-17T08:30:00.000Z', stale: false, errors: [] })
    expect(snapshot.entries).toHaveLength(13)
    expect(apiRequests(remote)).toHaveLength(1)
    expect(wikiRequests(remote)).toHaveLength(5)
    // The blobs of the index were kept: none is downloaded again.
    expect(rawRequests(remote)).toEqual([])
    expect((JSON.parse(readFileSync(file, 'utf8')) as { version: number }).version).toBe(3)
    expect(again.lookup('wiki:Frogmonster')?.cover).toContain('/300px-Frogmonster.jpg')
  })

  it('returns stale snapshot from disk when offline or rate limited', async () => {
    const fresh = await newCatalog().snapshot(false)

    remote.offline = true
    clock = START + 2 * HOUR
    const offline = await newCatalog().snapshot(false)
    expect(offline).toEqual({ ...fresh, stale: true, errors: ['NETWORK_OFFLINE'] })

    remote.offline = false
    remote.rateLimited = true
    remote.requests = []
    const limited = await newCatalog().snapshot(true)
    expect(limited).toEqual({ ...fresh, stale: true, errors: ['GITHUB_RATE_LIMITED'] })
    // The wiki is not rate limited: it was asked again.
    expect(wikiRequests(remote)).toHaveLength(5)

    // Nothing on disk and no network: an empty snapshot that says why.
    rmSync(catalogDir(), { recursive: true, force: true })
    remote.offline = true
    expect(await newCatalog().snapshot(false)).toEqual({
      entries: [],
      fetchedAt: null,
      stale: true,
      errors: ['NETWORK_OFFLINE'],
    })
  })

  it('fetches only changed blobs on second refresh', async () => {
    const catalog = newCatalog()
    // Two calls at once share one refresh.
    const [first, twin] = await Promise.all([catalog.snapshot(true), catalog.snapshot(true)])
    expect(twin).toEqual(first)
    expect(apiRequests(remote)).toHaveLength(1)
    const before = first.entries.find((entry) => entry.id === 'sms')
    expect(before?.latest?.version).toBe('0.6.2')

    const oldSms = gitBlobSha(remote.files.get('index/sms.toml') ?? '')
    remote.files.set('index/sms.toml', `${remote.files.get('index/sms.toml') ?? ''}"0.7.0" = {}\n`)
    remote.requests = []
    clock = START + 5 * 60 * 1000
    const second = await catalog.snapshot(true)
    expect(apiRequests(remote)).toHaveLength(1)
    expect(rawRequests(remote)).toEqual(['index/sms.toml'])
    expect(second.entries.find((entry) => entry.id === 'sms')?.latest).toEqual({
      version: '0.7.0',
      url: 'https://github.com/Joshark/archipelago-sms/releases/download/0.7.0/sms.apworld',
      sha256: null,
    })
    expect(second.fetchedAt).toBe('2026-10-17T08:05:00.000Z')
    // The blob nobody uses any more is dropped.
    const blobs = readdirSync(join(catalogDir(), 'blobs'))
    expect(blobs).toHaveLength(remote.files.size)
    expect(blobs).not.toContain(`${oldSms}.toml`)
  })

  it('does not keep a blob whose content does not match its sha', async () => {
    const catalog = newCatalog()
    const tampered = new Map(remote.files)
    // The branch moved between the tree and the file: the file is used, but not stored under that sha.
    const realFetch = fakeFetch(remote)
    core.ctx.http = createHttp({
      userAgent: 'Test/1.0 (unit)',
      cacheDir: catalogDir(),
      log: silentLogger,
      githubToken: () => null,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.href === `${INDEX_RAW}index/hk.toml`) {
          remote.requests.push(url.href)
          return Promise.resolve(new Response(`${tampered.get('index/hk.toml') ?? ''}# moved\n`))
        }
        return realFetch(input, init)
      },
    })
    const snapshot = await catalog.snapshot(true)
    expect(snapshot.entries.find((entry) => entry.id === 'hk')).toBeDefined()
    const sha = gitBlobSha(remote.files.get('index/hk.toml') ?? '')
    expect(existsSync(join(catalogDir(), 'blobs', `${sha}.toml`))).toBe(false)
  })

  it('reports an index or a wiki that does not answer as expected', async () => {
    remote.files.delete('index.toml')
    const snapshot = await newCatalog().snapshot(true)
    expect(snapshot).toMatchObject({ entries: [], stale: true, errors: ['HTTP_ERROR'] })

    // A wiki that answers garbage: the index alone, without wiki data.
    remote.files.set('index.toml', fixtureText('index.toml'))
    rmSync(catalogDir(), { recursive: true, force: true })
    const realFetch = fakeFetch(remote)
    core.ctx.http = createHttp({
      userAgent: 'Test/1.0 (unit)',
      cacheDir: catalogDir(),
      log: silentLogger,
      githubToken: () => null,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (url.host === 'archipelago.miraheze.org') return Promise.resolve(new Response('<html>'))
        return realFetch(input, init)
      },
    })
    const partial = await newCatalog().snapshot(true)
    expect(partial).toMatchObject({ stale: true, errors: ['HTTP_ERROR'], fetchedAt: null })
    expect(partial.entries.map((entry) => entry.id)).toContain('pokemon_crystal')
    expect(partial.entries.every((entry) => entry.wiki === null)).toBe(true)
  })

  it('works without Archipelago', async () => {
    install = null
    const snapshot = await newCatalog().snapshot(false)
    expect(byId(snapshot.entries).hk).toMatchObject({ trust: 'core', installedVersion: null })
    expect(byId(snapshot.entries).pokemon_crystal).toMatchObject({
      installedVersion: null,
      latest: { version: '6.0.4' },
    })
  })
})

describe('catalog service', () => {
  let root: string
  let core: TestCore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'goat catalog service é-'))
    core = createTestContext(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** An Archipelago 0.6.8 and the services, the network being `remote`. */
  function servicesWith(remote: FakeRemote) {
    const ap = join(root, 'AP')
    mkdirSync(ap)
    writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), '')
    writeFileSync(join(ap, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    core.ctx.config.updateInternal({ apPathOverride: ap })
    const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    core.ctx.exec = exec
    core.ctx.http = createHttp({
      userAgent: 'Test/1.0 (unit)',
      cacheDir: join(core.ctx.platform.paths.dataRoot, 'catalog'),
      log: silentLogger,
      githubToken: () => null,
      fetch: fakeFetch(remote),
    })

    const done: TaskDone[] = []
    core.ctx.bus.on('task:done', (event) => done.push(event))
    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    const call = async <T>(name: string, input?: unknown): Promise<T> => {
      const result = await ipc.dispatch(name, input, { senderId: 1 })
      if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`)
      return result.value as T
    }
    /** The plan `worlds:prepareInstall` builds for a catalog id. */
    const prepare = async (id: string): Promise<WorldInstallPlan> => {
      const { taskId } = await call<{ taskId: string }>('worlds:prepareInstall', {
        source: { kind: 'catalog', id },
      })
      await vi.waitFor(() => expect(done.map((event) => event.taskId)).toContain(taskId))
      return done.find((event) => event.taskId === taskId)?.result as WorldInstallPlan
    }
    return { call, prepare }
  }

  it('worlds prepare with a catalog source resolves the entry url and sha256', async () => {
    // The world the index points to; its hash goes in the lock in place of the real one.
    const world = await makeApworld(join(root, 'build', 'pmd_eos.apworld'), {
      game: 'Pokemon Mystery Dungeon Explorers of Sky',
    })
    const bytes = readFileSync(world)
    const remote = makeRemote()
    remote.files.set('index.lock', (remote.files.get('index.lock') ?? '').replace(SHA.pmd032, sha256(bytes)))
    const url =
      'https://github.com/CrypticMonkey33/ArchipelagoExplorersOfSky/releases/download/v0.3.2/pmd_eos.apworld'
    remote.downloads.set(url, bytes)
    const { call, prepare } = servicesWith(remote)

    const snapshot = await call<CatalogSnapshot>('catalog:list', {})
    expect(snapshot.entries.find((entry) => entry.id === 'pmd_eos')?.latest).toEqual({
      version: '0.3.2',
      url,
      sha256: sha256(bytes),
    })

    expect(await prepare('pmd_eos')).toMatchObject({
      source: { kind: 'catalog', id: 'pmd_eos' },
      module: 'pmd_eos',
      targetFileName: 'pmd_eos.apworld',
      sha256: sha256(bytes),
      trust: 'indexed-verified',
      homepage: 'https://discord.com/channels/731205301247803413/1175911373822242946',
      origin: url,
    })
    expect(remote.requests).toContain(url)

    // A forced refresh goes through the same handler.
    remote.requests = []
    await call<CatalogSnapshot>('catalog:list', { force: true })
    expect(apiRequests(remote)).toHaveLength(1)
  })

  it('worlds prepare with a world only the wiki lists asks GitHub for its latest release', async () => {
    const world = await makeApworld(join(root, 'build', 'frogmonster.apworld'), { game: 'Frogmonster' })
    const bytes = readFileSync(world)
    const remote = makeRemote()
    // The real answer of GitHub, its digest that of the file built here.
    const release = githubFixture('apworld-frogmonster.json') as {
      assets: { name: string; digest: string }[]
    }
    for (const asset of release.assets)
      if (asset.name === 'frogmonster.apworld') asset.digest = `sha256:${sha256(bytes)}`
    remote.github.set('/repos/rooby-roo/frogmonsterapworld/releases/latest', release)
    const url = 'https://github.com/Rooby-Roo/FrogmonsterAPWorld/releases/download/v0.2.5/frogmonster.apworld'
    remote.downloads.set(url, bytes)
    const { call, prepare } = servicesWith(remote)

    const snapshot = await call<CatalogSnapshot>('catalog:list', {})
    // Nothing asked of GitHub but the tree of the index while the catalog is listed.
    expect(apiRequests(remote)).toEqual([`https://api.github.com${TREE_PATH}?recursive=1`])
    expect(snapshot.entries.find((entry) => entry.id === 'wiki:Frogmonster')?.latest).toBeNull()

    expect(await prepare('wiki:Frogmonster')).toMatchObject({
      source: { kind: 'catalog', id: 'wiki:Frogmonster' },
      module: 'frogmonster',
      targetFileName: 'frogmonster.apworld',
      sha256: sha256(bytes),
      trust: 'wiki-release',
      homepage: 'https://github.com/Rooby-Roo/Archipelago/tree/Frogmonster',
      // The asset GitHub named: where the code comes from, whatever the page calls its homepage.
      origin: url,
    })
    expect(apiRequests(remote)).toContain(
      'https://api.github.com/repos/rooby-roo/frogmonsterapworld/releases/latest',
    )
    expect(remote.requests).toContain(url)
  })
})
