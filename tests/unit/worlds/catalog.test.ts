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
const allPages = (): WikiPage[] => [
  ...parseWikiPages(fixtureJson('wiki-page1.json')),
  ...parseWikiPages(fixtureJson('wiki-page2.json')),
]
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
  return { files, downloads: new Map(), offline: false, rateLimited: false, requests: [] }
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
      repos: ['archipelagomw-hollowknight/archipelago.hollowknight'],
    })

    const second = parseWikiPages(fixtureJson('wiki-page2.json'))
    const page = (title: string): WikiPage | undefined =>
      second.find((candidate) => candidate.title === title)
    expect(page('Minecraft')).toEqual({
      title: 'Minecraft',
      status: 'Custom',
      maintainer: 'qixils (current), KonoTyran (former)',
      setupUrl: 'https://github.com/qixils/NeoForgeAP/blob/mc/26.2/README.md',
      repos: ['qixils/neoforgeap'],
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
      repos: [],
    })
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
        repos: ['foo/bar'],
      },
    ])
    expect(parseWikiPages(null)).toEqual([])
    expect(
      parseWikiPages({ query: { pages: [{ pageid: 1 }, { title: 'Bad', pageprops: { infoboxes: '{' } }] } }),
    ).toEqual([{ title: 'Bad', status: null, maintainer: null, setupUrl: null, repos: [] }])
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
    // celeste is disabled in the index.
    expect(entries.map((entry) => entry.id)).toEqual([
      'Schedule_I',
      'Twilight Princess',
      'gl',
      'hk',
      'minecraft',
      'pmd_eos',
      'pokemon_crystal',
      'sms',
    ])
    const entry = byId(entries)

    expect(entry.pokemon_crystal).toEqual({
      id: 'pokemon_crystal',
      game: 'Pokemon Crystal',
      displayName: 'Pokemon Crystal',
      homepage: 'https://discord.com/channels/731205301247803413/1365127145709502575',
      tags: [],
      supported: false,
      afterDark: false,
      requiresRomAtGeneration: false,
      hasPopTracker: true,
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
    const afterDarkTitles = new Set([...memberTitles('wiki-afterdark.json'), 'Super Mario Sunshine'])
    const shown = joinCatalog(
      allWorlds(),
      allPages(),
      [],
      joinOptions({ afterDarkTitles, showAfterDark: true }),
    )
    expect(shown.filter((entry) => entry.afterDark).map((entry) => entry.id)).toEqual(['Schedule_I', 'sms'])
    const hidden = joinCatalog(
      allWorlds(),
      allPages(),
      [],
      joinOptions({ afterDarkTitles, showAfterDark: false }),
    )
    expect(hidden.map((entry) => entry.id)).not.toContain('Schedule_I')
    expect(hidden.map((entry) => entry.id)).not.toContain('sms')
    expect(hidden).toHaveLength(shown.length - 2)
  })

  it('excludes games and repos listed in catalog-optout.json', () => {
    expect(optOutFile).toEqual({ games: [], repos: [] })
    const optOut = { games: ['Pokemon Crystal'], repos: ['joshark/Archipelago-SMS'] }
    const ids = joinCatalog(allWorlds(), allPages(), [], joinOptions({ optOut })).map((entry) => entry.id)
    expect(ids).not.toContain('pokemon_crystal')
    expect(ids).not.toContain('sms')
    expect(ids).toContain('pmd_eos')
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
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      'Twilight Princess',
      'gl',
      'hk',
      'minecraft',
      'pmd_eos',
      'pokemon_crystal',
      'sms',
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
    // After Dark worlds are left out of the snapshot, and of the lookups, until the settings allow them.
    expect(catalog.lookup('Schedule_I')).toBeNull()
    core.ctx.config.update({ showAfterDark: true })
    await catalog.snapshot(false)
    expect(catalog.lookupByGame('Schedule I')?.id).toBe('Schedule_I')
  })

  it('answers from the snapshot on disk while it is fresh, without the network', async () => {
    await newCatalog().snapshot(false)
    remote.requests = []
    clock = START + HOUR / 2
    const again = newCatalog()
    // The last snapshot is read back before anything is fetched.
    expect(again.lookup('pmd_eos')?.latest?.sha256).toBe(SHA.pmd032)
    const snapshot = await again.snapshot(false)
    expect(snapshot).toMatchObject({ fetchedAt: '2026-10-17T08:00:00.000Z', stale: false, errors: [] })
    expect(snapshot.entries).toHaveLength(7)
    expect(remote.requests).toEqual([])
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

  it('worlds prepare with a catalog source resolves the entry url and sha256', async () => {
    const ap = join(root, 'AP')
    mkdirSync(ap)
    writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), '')
    writeFileSync(join(ap, 'manifest.json'), JSON.stringify({ version: [0, 6, 8] }))
    core.ctx.config.updateInternal({ apPathOverride: ap })
    const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: '', stderr: '' })
    core.ctx.exec = exec

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

    const snapshot = await call<CatalogSnapshot>('catalog:list', {})
    expect(snapshot.entries.find((entry) => entry.id === 'pmd_eos')?.latest).toEqual({
      version: '0.3.2',
      url,
      sha256: sha256(bytes),
    })

    const { taskId } = await call<{ taskId: string }>('worlds:prepareInstall', {
      source: { kind: 'catalog', id: 'pmd_eos' },
    })
    await vi.waitFor(() => expect(done.map((event) => event.taskId)).toContain(taskId))
    const plan = done.find((event) => event.taskId === taskId)?.result as WorldInstallPlan
    expect(plan).toMatchObject({
      source: { kind: 'catalog', id: 'pmd_eos' },
      module: 'pmd_eos',
      targetFileName: 'pmd_eos.apworld',
      sha256: sha256(bytes),
      trust: 'indexed-verified',
      homepage: 'https://discord.com/channels/731205301247803413/1175911373822242946',
    })
    expect(remote.requests).toContain(url)

    // A forced refresh goes through the same handler.
    remote.requests = []
    await call<CatalogSnapshot>('catalog:list', { force: true })
    expect(apiRequests(remote)).toHaveLength(1)
  })
})
