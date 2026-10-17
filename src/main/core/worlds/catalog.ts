// The APWorld catalog (spec §3.9): the worlds of the ionium index (ionium-ap/Archipelago-index) as the
// installed Archipelago sees them, joined with the Archipelago wiki (status, maintainer, setup guide,
// categories). A refresh costs one GitHub API call (the tree of the index); the files of the index come
// from raw.githubusercontent.com, which is not rate limited, and only those whose blob changed. What
// was fetched is kept on disk: offline or rate limited, the catalog answers from it, marked stale.
import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import pLimit from 'p-limit'
import semver from 'semver'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import type { ErrorCode } from '@shared/codes'
import { IONIUM_REPO, WIKI_API } from '@shared/data/ap-constants'
import { coreWorldsFor } from '@shared/data/core-worlds'
import { AppError, toAppErrorData } from '@shared/errors'
import type { CatalogEntry, CatalogSnapshot, TrustTier, WorldInfo } from '@shared/types'
import optOutList from '../../../../resources/catalog-optout.json'
import type { Locator } from '../ap/locator'
import type { CoreContext } from '../context'
import { readJsonSync } from '../json-file'
import { writeFileAtomic } from '../system/fsx'
import { httpStatusError, toNetworkError } from '../system/http'
import { disabledWorldsDir, NOT_LOADED_STATES, scanWorlds } from './inventory'

/** The version the app targets: the one the index is read for when Archipelago is not installed. */
const TARGET_AP_VERSION = '0.6.8'

const INDEX_BRANCH = 'main'
const TREE_URL = `https://api.github.com/repos/${IONIUM_REPO}/git/trees/${INDEX_BRANCH}?recursive=1`
const RAW_BASE = `https://raw.githubusercontent.com/${IONIUM_REPO}/${INDEX_BRANCH}/`
const WIKI_PAGES = new URL('/wiki/', WIKI_API).href

const IMPLEMENTATIONS = 'Category:Implementations'
const AFTER_DARK = 'Category:After Dark implementations'
const ROM_AT_GENERATION = 'Category:Implementations that require a ROM at generation'
const POPTRACKER = 'Category:Implementations with PopTracker'
/** The index tags the worlds of the After Dark server `ad`. */
const AFTER_DARK_TAG = 'ad'

/** Files fetched at once from raw.githubusercontent.com. */
const FETCH_CONCURRENCY = 8
/** `snapshot(false)` asks the network again once the data is older than this. */
const FRESH_MS = 60 * 60 * 1000
/** After a failed refresh, `snapshot(false)` waits this long before it tries again. */
const RETRY_MS = 5 * 60 * 1000
/** The whole of one request, body included (Http's own timeout stops at the headers). */
const REQUEST_TIMEOUT_MS = 60_000
/** A wiki listing that keeps asking for more after this many requests is not followed. */
const MAX_WIKI_REQUESTS = 20
const SAVED_VERSION = 1

// --- types ----------------------------------------------------------------------------------------

/** Where a release comes from: a link (`{{version}}` in it is replaced), or a file of the index. */
export interface IoniumSource {
  url: string | null
  local: string | null
}

/** An entry of `[versions]`. */
export interface IoniumVersion extends IoniumSource {
  version: string
}

/** An entry of `[releases]`: the Archipelago versions it runs on (both bounds inclusive). */
export interface IoniumRelease extends IoniumSource {
  version: string
  minApVersion: string | null
  maxApVersion: string | null
}

/** A `[base."<requirement>"]` table: what changes for the Archipelago versions it matches. */
export interface IoniumBaseOverride {
  /** A requirement in the syntax of Rust's semver crate (`>=0.6.8`; a bare version is `^`). */
  requirement: string
  supported: boolean | null
  disabled: boolean | null
  defaultVersion: string | null
}

/** A world file of the index (`index/<id>.toml`), as written. Versions are canonical semver. */
export interface IoniumWorld {
  /** The file stem: the apworld (module) name. */
  id: string
  /** The folder of the file in the index repository, which `local` sources are relative to. */
  dir: string
  /** The `game` of the world. */
  name: string
  displayName: string
  home: string | null
  defaultUrl: string | null
  /** `latest` (the default), `latest_supported`, `disabled` or a version. */
  defaultVersion: string
  tags: string[]
  /** A core world (of the oldest Archipelago version the index describes, unless a base says otherwise). */
  supported: boolean
  disabled: boolean
  versions: IoniumVersion[]
  releases: IoniumRelease[]
  bases: IoniumBaseOverride[]
}

export interface IoniumResolved {
  version: string
  url: string
  /** From index.lock; null when the lock has no hash for that version. */
  sha256: string | null
}

/** An implementation page of the wiki. */
export interface WikiPage {
  title: string
  status: string | null
  maintainer: string | null
  setupUrl: string | null
  /** `owner/repo`, lowercase, of the GitHub links of its download and repository fields. */
  repos: string[]
}

/** Worlds whose maintainers asked to stay out of the catalog (resources/catalog-optout.json). */
export interface CatalogOptOut {
  /** Game names. */
  games: string[]
  /** GitHub repositories, `owner/repo`. */
  repos: string[]
}

export interface JoinOptions {
  /**
   * The installed Archipelago's version: null when it is not installed, `unknown` when it is but its
   * version is not known. Without a usable version the index is read for the one the app targets.
   */
  apVersion: string | null
  /** `parseIoniumLock`. */
  lock: ReadonlyMap<string, string>
  showAfterDark: boolean
  /** Titles of the wiki's "After Dark implementations". */
  afterDarkTitles: ReadonlySet<string>
  /** Titles of the wiki's "Implementations that require a ROM at generation". */
  romTitles?: ReadonlySet<string>
  /** Titles of the wiki's "Implementations with PopTracker". */
  popTrackerTitles?: ReadonlySet<string>
  optOut?: CatalogOptOut
}

// --- small helpers --------------------------------------------------------------------------------

type Table = Record<string, unknown>

const isTable = (value: unknown): value is Table =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `1.2.3-pre+build`, as Rust's semver writes it (and the lock keys it); null for anything else. */
function canonicalVersion(raw: string): string | null {
  const parsed = semver.parse(raw.trim())
  if (!parsed) return null
  return parsed.build.length > 0 ? `${parsed.version}+${parsed.build.join('.')}` : parsed.version
}

const byVersion = (a: { version: string }, b: { version: string }): number =>
  semver.compareBuild(a.version, b.version)

/** The version the index is read for: the installed one (`0.6.8`), else the one the app targets. */
const baseOf = (apVersion: string | null): string =>
  (apVersion === null ? null : semver.coerce(apVersion)?.version) ?? TARGET_AP_VERSION

/** A requirement of Rust's semver crate (comma-separated, a bare version is `^`) as a node range. */
function rangeOf(requirement: string): string | null {
  const parts = requirement.split(',').map((part) => part.trim())
  if (parts.some((part) => part === '')) return null
  return semver.validRange(parts.map((part) => (/^\d/.test(part) ? `^${part}` : part)).join(' '))
}

function parseUrl(raw: string, base?: string): URL | null {
  try {
    return new URL(raw, base)
  } catch {
    return null
  }
}

const isWebUrl = (url: URL | null): url is URL => url?.protocol === 'https:' || url?.protocol === 'http:'

/** `owner/repo`, lowercase, of a github.com link; null for any other link. */
function githubRepo(link: string): string | null {
  const url = parseUrl(link)
  if (url?.hostname !== 'github.com' && url?.hostname !== 'www.github.com') return null
  const [owner, repo] = url.pathname.split('/').filter(Boolean)
  const name = repo?.replace(/\.git$/i, '')
  if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return `${owner}/${name}`.toLowerCase()
}

/** `owner/repo` of a GitHub release asset (`github.com/<owner>/<repo>/releases/download/…`). */
function releaseRepo(link: string): string | null {
  const segments = parseUrl(link)?.pathname.split('/').filter(Boolean) ?? []
  return segments[2] === 'releases' && segments[3] === 'download' ? githubRepo(link) : null
}

/** Accents and case set aside, so that "Pokémon Crystal" names the world "Pokemon Crystal". */
const nameKey = (name: string): string =>
  name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

const gitBlobSha = (bytes: Buffer): string =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

/** UTF-8, without the byte order mark a TOML parser would trip on. */
const decodeUtf8 = (bytes: Buffer): string => new TextDecoder().decode(bytes)

// --- the ionium index -----------------------------------------------------------------------------

function parseSource(value: unknown): IoniumSource {
  const table = isTable(value) ? value : {}
  return { url: text(table.url), local: text(table.local) }
}

/** A bound of `[releases]`: null when there is none, undefined when it is not a version. */
function parseBound(value: unknown): string | null | undefined {
  if (value === undefined) return null
  return typeof value === 'string' ? (canonicalVersion(value) ?? undefined) : undefined
}

/**
 * A world file of the index; null when it is not TOML or has no `name`. What cannot be used is left
 * out: a version that is not semver, a release with a bound that is not a version, a `[base]` table
 * whose requirement does not parse (each would make apwm refuse the file).
 */
export function parseIoniumToml(source: string, fileStem: string, dir = 'index'): IoniumWorld | null {
  let doc: Table
  try {
    doc = parseToml(source)
  } catch {
    return null
  }
  const name = text(doc.name)
  if (name === null) return null

  const versions: IoniumVersion[] = []
  for (const [key, value] of Object.entries(isTable(doc.versions) ? doc.versions : {})) {
    const version = canonicalVersion(key)
    if (version !== null) versions.push({ version, ...parseSource(value) })
  }
  const releases: IoniumRelease[] = []
  for (const [key, value] of Object.entries(isTable(doc.releases) ? doc.releases : {})) {
    const version = canonicalVersion(key)
    const table = isTable(value) ? value : {}
    const minApVersion = parseBound(table.min_ap_version)
    const maxApVersion = parseBound(table.max_ap_version)
    if (version === null || minApVersion === undefined || maxApVersion === undefined) continue
    releases.push({ version, minApVersion, maxApVersion, ...parseSource(table) })
  }
  const bases: IoniumBaseOverride[] = []
  for (const [requirement, value] of Object.entries(isTable(doc.base) ? doc.base : {})) {
    if (!isTable(value) || rangeOf(requirement) === null) continue
    bases.push({
      requirement,
      supported: flag(value.supported),
      disabled: flag(value.disabled),
      defaultVersion: text(value.default_version),
    })
  }
  const home = text(doc.home)
  return {
    id: fileStem,
    dir,
    name,
    displayName: text(doc.display_name) ?? name,
    home: home !== null && isWebUrl(parseUrl(home)) ? home : null,
    defaultUrl: text(doc.default_url),
    defaultVersion: text(doc.default_version) ?? 'latest',
    tags: Array.isArray(doc.tags) ? doc.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    supported: doc.supported === true,
    disabled: doc.disabled === true,
    versions: versions.sort(byVersion),
    releases: releases.sort(byVersion),
    bases,
  }
}

const SHA256 = /^[0-9a-f]{64}$/i
const lockKey = (id: string, version: string): string => `${id}@${version}`

/** index.lock: `"<world>@<version>"` → sha256 of that release. Empty when it does not parse. */
export function parseIoniumLock(source: string): Map<string, string> {
  const lock = new Map<string, string>()
  let doc: Table
  try {
    doc = parseToml(source)
  } catch {
    return lock
  }
  for (const [world, versions] of Object.entries(doc)) {
    if (!isTable(versions)) continue
    for (const [key, sha] of Object.entries(versions)) {
      const version = canonicalVersion(key)
      if (version !== null && typeof sha === 'string' && SHA256.test(sha)) {
        lock.set(lockKey(world, version), sha.toLowerCase())
      }
    }
  }
  return lock
}

/** A release a base can pick; `supported` is the core copy, which has nothing to download. */
interface Candidate extends IoniumSource {
  version: string
  supported: boolean
}

interface BaseSettings {
  disabled: boolean
  supported: boolean
  defaultVersion: string
}

/** The top-level settings of a world, with the `[base]` table that matches `base` applied. */
function settingsFor(world: IoniumWorld, base: string): BaseSettings {
  const override = world.bases.find((table) => {
    const range = rangeOf(table.requirement)
    return range !== null && semver.satisfies(base, range)
  })
  return {
    disabled: override?.disabled ?? world.disabled,
    supported: override?.supported ?? world.supported,
    defaultVersion: override?.defaultVersion ?? world.defaultVersion,
  }
}

/** The releases `base` may use, as apwm's `WorldDef::for_base` builds them. */
function candidatesFor(world: IoniumWorld, base: string, supported: boolean): Map<string, Candidate> {
  const runsOn = (release: IoniumRelease): boolean =>
    (release.minApVersion === null || semver.lte(release.minApVersion, base)) &&
    (release.maxApVersion === null || semver.lte(base, release.maxApVersion))
  const releases = new Map(world.releases.map((release) => [release.version, release]))
  const candidates = new Map<string, Candidate>()
  for (const entry of world.versions) {
    const release = releases.get(entry.version)
    if (!release || runsOn(release)) candidates.set(entry.version, { ...entry, supported: false })
  }
  for (const release of world.releases) {
    if (!runsOn(release)) continue
    // A release also in [versions] keeps the source it has there unless [releases] gives one.
    if (release.url !== null || release.local !== null || !candidates.has(release.version)) {
      candidates.set(release.version, {
        version: release.version,
        url: release.url,
        local: release.local,
        supported: false,
      })
    }
  }
  if (supported) candidates.set(base, { version: base, url: null, local: null, supported: true })
  return candidates
}

function pickCandidate(defaultVersion: string, candidates: Map<string, Candidate>): Candidate | null {
  const all = [...candidates.values()]
  switch (defaultVersion) {
    case 'disabled':
      return null
    case 'latest_supported':
      return all.find((candidate) => candidate.supported) ?? null
    case 'latest':
      return all.sort((a, b) => byVersion(b, a))[0] ?? null
    default: {
      const version = canonicalVersion(defaultVersion)
      return version === null ? null : (candidates.get(version) ?? null)
    }
  }
}

/** A `local` source: a file of the index repository, relative to the world file. */
function indexFileUrl(dir: string, local: string): string | null {
  const folder = parseUrl(`${dir.split('/').map(encodeURIComponent).join('/')}/`, RAW_BASE)
  const url = folder && parseUrl(local, folder.href)
  return url?.href.startsWith(RAW_BASE) ? url.href : null
}

function candidateUrl(world: IoniumWorld, candidate: Candidate): string | null {
  const template = candidate.url ?? (candidate.local === null ? world.defaultUrl : null)
  const raw =
    template !== null
      ? template.replaceAll('{{version}}', candidate.version)
      : candidate.local !== null
        ? indexFileUrl(world.dir, candidate.local)
        : null
  // Downloads are code: https only.
  const url = raw === null ? null : parseUrl(raw)
  return url?.protocol === 'https:' ? url.href : null
}

/**
 * The release of `world` to install on Archipelago `apVersion` (null: the version the app targets):
 * the world's `default_version` among the releases that version may run. Null when the world is
 * disabled there, when the pick is the core copy, or when nothing can be downloaded over https.
 */
export function resolveIoniumRelease(
  world: IoniumWorld,
  apVersion: string | null,
  lock: ReadonlyMap<string, string>,
): IoniumResolved | null {
  const base = baseOf(apVersion)
  const settings = settingsFor(world, base)
  if (settings.disabled) return null
  const chosen = pickCandidate(settings.defaultVersion, candidatesFor(world, base, settings.supported))
  if (chosen === null || chosen.supported) return null
  const url = candidateUrl(world, chosen)
  if (url === null) return null
  return { version: chosen.version, url, sha256: lock.get(lockKey(world.id, chosen.version)) ?? null }
}

// --- the wiki -------------------------------------------------------------------------------------

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
])

function decodeEntities(html: string): string {
  return html.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (!code.startsWith('#')) return ENTITIES.get(code.toLowerCase()) ?? match
    const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
  })
}

/** The text of an infobox value: tags dropped, entities decoded, line breaks as commas. */
function htmlText(html: string): string | null {
  const parts = html
    .split(/<br\s*\/?>/i)
    .map((part) =>
      decodeEntities(part.replace(/<[^>]*>/g, ''))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => part !== '')
  return parts.length > 0 ? parts.join(', ') : null
}

/** The web links of an infobox value, made absolute (wiki links are relative to the wiki). */
function htmlLinks(html: string): string[] {
  const links: string[] = []
  for (const match of html.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
    const url = parseUrl(decodeEntities(match[1] ?? ''), WIKI_PAGES)
    if (isWebUrl(url)) links.push(url.href)
  }
  return links
}

/** `pageprops.infoboxes` (a JSON string, PortableInfobox): the value of each `source`. */
function infoboxFields(raw: unknown): Map<string, string> {
  const fields = new Map<string, string>()
  let boxes: unknown
  try {
    boxes = typeof raw === 'string' ? JSON.parse(raw) : null
  } catch {
    return fields
  }
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!isTable(item) || !isTable(item.data)) continue
      const { source, value } = item.data
      if (item.type === 'group') walk(value)
      else if (item.type === 'data' && typeof source === 'string' && typeof value === 'string') {
        if (!fields.has(source)) fields.set(source, value)
      }
    }
  }
  if (Array.isArray(boxes)) for (const box of boxes) if (isTable(box)) walk(box.data)
  return fields
}

/** The pages of one `prop=pageprops&ppprop=infoboxes` answer (formatversion=2), by title. */
export function parseWikiPages(json: unknown): WikiPage[] {
  const query = isTable(json) && isTable(json.query) ? json.query : {}
  const pages: WikiPage[] = []
  for (const page of Array.isArray(query.pages) ? query.pages : []) {
    if (!isTable(page) || typeof page.title !== 'string' || page.title === '') continue
    const fields = infoboxFields(isTable(page.pageprops) ? page.pageprops.infoboxes : undefined)
    const field = (name: string): string => fields.get(name) ?? ''
    const repos = [...htmlLinks(field('ap-repolink')), ...htmlLinks(field('ap-download'))]
      .map(githubRepo)
      .filter((repo): repo is string => repo !== null)
    pages.push({
      title: page.title,
      status: htmlText(field('ap-status')),
      maintainer: htmlText(field('ap-maintainer')),
      setupUrl: htmlLinks(field('ap-setuplink'))[0] ?? null,
      repos: [...new Set(repos)],
    })
  }
  return pages.sort((a, b) => byCodePoint(a.title, b.title))
}

/** The titles of one `list=categorymembers` answer. */
function parseMembers(json: Table): string[] {
  const members =
    isTable(json.query) && Array.isArray(json.query.categorymembers) ? json.query.categorymembers : []
  return members.flatMap((member) =>
    isTable(member) && typeof member.title === 'string' ? [member.title] : [],
  )
}

const wikiPageUrl = (title: string): string =>
  `${WIKI_PAGES}${encodeURIComponent(title.replaceAll(' ', '_'))}`

// --- the join -------------------------------------------------------------------------------------

/** The GitHub repositories a world file links to. */
function worldRepos(world: IoniumWorld): string[] {
  const links = [
    world.home,
    world.defaultUrl,
    ...world.versions.map((v) => v.url),
    ...world.releases.map((r) => r.url),
  ]
  const repos = links.map((link) => (link === null ? null : githubRepo(link)))
  return [...new Set(repos.filter((repo): repo is string => repo !== null))]
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * The wiki page of each world: by game name (the exact title, else with accents and case set aside),
 * then by GitHub repository, where the repository leads to a single page and a single world (a fork
 * of Archipelago can hold many games).
 */
function wikiPagesOf(ionium: readonly IoniumWorld[], wiki: readonly WikiPage[]): Map<string, WikiPage> {
  const exact = new Map<string, WikiPage>()
  const loose = new Map<string, WikiPage>()
  for (const page of wiki) {
    if (!exact.has(page.title)) exact.set(page.title, page)
    if (!loose.has(nameKey(page.title))) loose.set(nameKey(page.title), page)
  }
  const joined = new Map<string, WikiPage>()
  const used = new Set<WikiPage>()
  for (const world of ionium) {
    const page = exact.get(world.name) ?? loose.get(nameKey(world.name))
    if (page) {
      joined.set(world.id, page)
      used.add(page)
    }
  }

  const pending = ionium.filter((world) => !joined.has(world.id))
  const reposOf = new Map(pending.map((world) => [world.id, worldRepos(world)]))
  const pagesByRepo = new Map<string, WikiPage[]>()
  for (const page of wiki) if (!used.has(page)) for (const repo of page.repos) pushTo(pagesByRepo, repo, page)
  const worldsByRepo = new Map<string, IoniumWorld[]>()
  for (const world of pending)
    for (const repo of reposOf.get(world.id) ?? []) pushTo(worldsByRepo, repo, world)
  for (const world of pending) {
    const found = new Set<WikiPage>()
    for (const repo of reposOf.get(world.id) ?? []) {
      const pages = pagesByRepo.get(repo) ?? []
      if (pages.length === 1 && worldsByRepo.get(repo)?.length === 1 && pages[0]) found.add(pages[0])
    }
    const [page] = found
    if (found.size === 1 && page) joined.set(world.id, page)
  }
  return joined
}

/**
 * The version of `world` the user has: Archipelago's for a core world; else that of the custom world
 * of the same game (one without a manifest by its module), `unknown` when its manifest has none.
 */
function installedVersionOf(
  world: IoniumWorld,
  isCore: boolean,
  installed: readonly WorldInfo[],
  apVersion: string | null,
): string | null {
  if (isCore) return apVersion
  const custom = installed.filter((candidate) => candidate.location === 'custom')
  const sameGame = custom.filter((candidate) => candidate.game === world.name)
  const matches =
    sameGame.length > 0 ? sameGame : custom.filter((c) => c.game === null && c.module === world.id)
  const loaded = matches.find(
    (candidate) => !candidate.states.some((state) => state === 'shadowed' || NOT_LOADED_STATES.has(state)),
  )
  const match = loaded ?? matches[0]
  return match ? (match.manifest?.worldVersion ?? 'unknown') : null
}

function trustOf(isCore: boolean, latest: IoniumResolved | null, page: WikiPage | null): TrustTier {
  if (isCore) return 'core'
  if (latest === null) return 'unknown'
  if (latest.sha256 !== null) return 'indexed-verified'
  const repo = releaseRepo(latest.url)
  return repo !== null && page?.repos.includes(repo) ? 'wiki-release' : 'unknown'
}

/**
 * The catalog entries (pure), by id. A world shipped with the installed Archipelago (its game in the
 * core table of that version, or found among the core worlds of `installed`) is `core`: nothing to
 * download, installed with Archipelago. Any other world disabled for that version is left out; one
 * with no release for that version stays, with `latest` null. Left out as well: the worlds of the
 * opt-out list, and After Dark worlds unless `showAfterDark`.
 */
export function joinCatalog(
  ionium: readonly IoniumWorld[],
  wiki: readonly WikiPage[],
  installed: readonly WorldInfo[],
  opts: JoinOptions,
): CatalogEntry[] {
  const base = baseOf(opts.apVersion)
  const coreGames = new Set<string>()
  const coreModules = new Set<string>()
  for (const world of coreWorldsFor(base) ?? []) {
    coreGames.add(world.game)
    coreModules.add(world.module)
  }
  for (const world of installed) {
    if (world.location !== 'core') continue
    if (world.game !== null) coreGames.add(world.game)
    coreModules.add(world.module)
  }
  const optOutGames = new Set((opts.optOut?.games ?? []).map(nameKey))
  const optOutRepos = new Set((opts.optOut?.repos ?? []).map((repo) => repo.toLowerCase()))
  const pages = wikiPagesOf(ionium, wiki)

  const entries: CatalogEntry[] = []
  for (const world of ionium) {
    if (optOutGames.has(nameKey(world.name)) || worldRepos(world).some((repo) => optOutRepos.has(repo)))
      continue
    const isCore = coreGames.has(world.name) || coreModules.has(world.id)
    const settings = settingsFor(world, base)
    if (settings.disabled && !isCore) continue
    const page = pages.get(world.id) ?? null
    const afterDark =
      world.tags.includes(AFTER_DARK_TAG) || (page !== null && opts.afterDarkTitles.has(page.title))
    if (afterDark && !opts.showAfterDark) continue
    const latest = isCore ? null : resolveIoniumRelease(world, opts.apVersion, opts.lock)
    entries.push({
      id: world.id,
      game: world.name,
      displayName: world.displayName,
      homepage: world.home,
      tags: [...world.tags],
      supported: settings.supported,
      afterDark,
      requiresRomAtGeneration: page !== null && (opts.romTitles?.has(page.title) ?? false),
      hasPopTracker: page !== null && (opts.popTrackerTitles?.has(page.title) ?? false),
      wiki: page && {
        title: page.title,
        url: wikiPageUrl(page.title),
        status: page.status,
        maintainer: page.maintainer,
        setupUrl: page.setupUrl,
      },
      latest,
      installedVersion: installedVersionOf(world, isCore, installed, opts.apVersion),
      trust: trustOf(isCore, latest, page),
    })
  }
  return entries.sort((a, b) => byCodePoint(a.id, b.id))
}

// --- what is kept on disk -------------------------------------------------------------------------

interface IoniumData {
  worlds: IoniumWorld[]
  lock: Map<string, string>
}

interface WikiData {
  pages: WikiPage[]
  afterDark: Set<string>
  rom: Set<string>
  popTracker: Set<string>
}

const nullableText = z.string().nullable()
const ioniumWorldSchema: z.ZodType<IoniumWorld> = z.object({
  id: z.string(),
  dir: z.string(),
  name: z.string(),
  displayName: z.string(),
  home: nullableText,
  defaultUrl: nullableText,
  defaultVersion: z.string(),
  tags: z.array(z.string()),
  supported: z.boolean(),
  disabled: z.boolean(),
  versions: z.array(z.object({ version: z.string(), url: nullableText, local: nullableText })),
  releases: z.array(
    z.object({
      version: z.string(),
      minApVersion: nullableText,
      maxApVersion: nullableText,
      url: nullableText,
      local: nullableText,
    }),
  ),
  bases: z.array(
    z.object({
      requirement: z.string(),
      supported: z.boolean().nullable(),
      disabled: z.boolean().nullable(),
      defaultVersion: nullableText,
    }),
  ),
})
const wikiPageSchema: z.ZodType<WikiPage> = z.object({
  title: z.string(),
  status: nullableText,
  maintainer: nullableText,
  setupUrl: nullableText,
  repos: z.array(z.string()),
})

/** `dataRoot/catalog/catalog.json`. */
const savedSchema = z.object({
  version: z.literal(SAVED_VERSION),
  /** When the last refresh that fully succeeded ended. */
  fetchedAt: nullableText,
  /** The Archipelago version of the last snapshot (lookups before the first snapshot of a run). */
  apVersion: nullableText,
  ionium: z
    .object({ worlds: z.array(ioniumWorldSchema), lock: z.array(z.tuple([z.string(), z.string()])) })
    .nullable(),
  wiki: z
    .object({
      pages: z.array(wikiPageSchema),
      afterDark: z.array(z.string()),
      rom: z.array(z.string()),
      popTracker: z.array(z.string()),
    })
    .nullable(),
})

const treeSchema = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })),
})

/** A folder of the index repository, such as `index`: plain names, no way out. */
const isRepoDir = (dir: string): boolean =>
  dir.split('/').every((segment) => /^[\w.-]+$/.test(segment) && segment !== '.' && segment !== '..')

const repoUrl = (repoPath: string): string =>
  `${RAW_BASE}${repoPath.split('/').map(encodeURIComponent).join('/')}`

// --- the service ----------------------------------------------------------------------------------

export interface Catalog {
  /**
   * The catalog for the installed Archipelago. `force` asks the network now; otherwise it is asked
   * once the data is an hour old. When it cannot be asked (offline, rate limited, an answer that
   * does not parse), the last data is used and the snapshot is `stale`, with the reason in `errors`.
   */
  snapshot(force: boolean): Promise<CatalogSnapshot>
  /** The entry of an id in the last snapshot (or the one saved by an earlier run); no network. */
  lookup(id: string): CatalogEntry | null
  /** The entry whose game is exactly `game` (the `game` of a manifest or a YAML); no network. */
  lookupByGame(game: string): CatalogEntry | null
}

export interface CatalogDeps {
  locator: Pick<Locator, 'detect'>
  /** Default: resources/catalog-optout.json. */
  optOut?: CatalogOptOut
  /** The clock of refreshes and of `fetchedAt`. Default: `Date.now`. */
  now?: () => number
}

export function createCatalog(ctx: CoreContext, deps: CatalogDeps): Catalog {
  const { dataRoot } = ctx.platform.paths
  const dir = path.join(dataRoot, 'catalog')
  const savedFile = path.join(dir, 'catalog.json')
  const blobsDir = path.join(dir, 'blobs')
  const now = deps.now ?? Date.now
  const optOut = deps.optOut ?? optOutList

  const saved = savedSchema.safeParse(readJsonSync(savedFile))
  let ionium: IoniumData | null = null
  let wiki: WikiData | null = null
  let fetchedAt: string | null = null
  let lastApVersion: string | null = null
  if (saved.success) {
    const { data } = saved
    ionium = data.ionium && { worlds: data.ionium.worlds, lock: new Map(data.ionium.lock) }
    wiki = data.wiki && {
      pages: data.wiki.pages,
      afterDark: new Set(data.wiki.afterDark),
      rom: new Set(data.wiki.rom),
      popTracker: new Set(data.wiki.popTracker),
    }
    fetchedAt = data.fetchedAt
    lastApVersion = data.apVersion
  }
  let errors: ErrorCode[] = []
  let lastAttempt: number | null = null
  let refreshing: Promise<void> | null = null
  /** Something new to save. */
  let dirty = false
  let last: CatalogEntry[] | null = null

  const build = (installed: readonly WorldInfo[], apVersion: string | null): CatalogEntry[] =>
    joinCatalog(ionium?.worlds ?? [], wiki?.pages ?? [], installed, {
      apVersion,
      lock: ionium?.lock ?? new Map(),
      showAfterDark: ctx.config.get().showAfterDark,
      afterDarkTitles: wiki?.afterDark ?? new Set(),
      romTitles: wiki?.rom ?? new Set(),
      popTrackerTitles: wiki?.popTracker ?? new Set(),
      optOut,
    })

  /** What the lookups read: the last snapshot, else what an earlier run saved. */
  const current = (): CatalogEntry[] => (last ??= build([], lastApVersion))

  // --- requests ---

  /** GET with a deadline on the body too; status errors as Http maps them. */
  async function fetchBytes(url: string, accept: string): Promise<{ status: number; bytes: Buffer }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await ctx.http.fetchRaw(url, { headers: { accept }, signal: controller.signal })
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw httpStatusError(res, url)
      }
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) }
    } catch (error) {
      if (controller.signal.aborted)
        throw new AppError('NETWORK_OFFLINE', undefined, { detail: 'timeout', cause: error })
      throw toNetworkError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchJson(url: string): Promise<unknown> {
    const { status, bytes } = await fetchBytes(url, 'application/json')
    try {
      return JSON.parse(decodeUtf8(bytes)) as unknown
    } catch (cause) {
      throw new AppError('HTTP_ERROR', { status, url }, { detail: 'invalid JSON', cause })
    }
  }

  // --- the index ---

  /** A file of the index: from `blobs/<sha>.toml`, else downloaded and kept there if it is that blob. */
  async function readBlob(repoPath: string, sha: string): Promise<string> {
    const cached = path.join(blobsDir, `${sha}.toml`)
    const kept = await readFile(cached).catch(() => null)
    if (kept !== null) return decodeUtf8(kept)
    const { bytes } = await fetchBytes(repoUrl(repoPath), 'text/plain')
    // The branch may have moved since the tree was read: then this is another blob, not kept as that one.
    if (gitBlobSha(bytes) === sha) {
      await writeFileAtomic(cached, bytes).catch((error: unknown) =>
        ctx.log.warn('catalog: cannot keep a blob', error),
      )
    }
    return decodeUtf8(bytes)
  }

  async function pruneBlobs(keep: ReadonlySet<string>): Promise<void> {
    const names = await readdir(blobsDir).catch(() => [] as string[])
    const unused = names.filter((name) => !keep.has(name.replace(/\.toml$/, '')))
    await Promise.all(
      unused.map((name) => rm(path.join(blobsDir, name), { force: true }).catch(() => undefined)),
    )
  }

  async function fetchIonium(): Promise<IoniumData> {
    const answer = await ctx.http.getJson<unknown>(TREE_URL, { cacheKey: 'catalog:ionium-tree' })
    // Http served its copy because the network failed: nothing new to read.
    if (answer.stale) throw new AppError('NETWORK_OFFLINE', undefined, { detail: 'ionium tree' })
    const parsed = treeSchema.safeParse(answer.data)
    if (!parsed.success)
      throw new AppError('HTTP_ERROR', { status: 200, url: TREE_URL }, { detail: 'not a git tree' })
    const blobs = new Map(
      parsed.data.tree
        .filter((entry) => entry.type === 'blob' && /^[0-9a-f]{40}$/.test(entry.sha))
        .map((entry) => [entry.path, entry.sha]),
    )

    const indexSha = blobs.get('index.toml')
    if (indexSha === undefined)
      throw new AppError('HTTP_ERROR', { status: 200, url: TREE_URL }, { detail: 'no index.toml' })
    let indexToml: Table
    try {
      indexToml = parseToml(await readBlob('index.toml', indexSha))
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        'HTTP_ERROR',
        { status: 200, url: repoUrl('index.toml') },
        { detail: 'invalid TOML' },
      )
    }
    const indexDir = text(indexToml.index_dir)
    const worldsDir = indexDir !== null && isRepoDir(indexDir) ? indexDir : 'index'
    const files = [...blobs].filter(([repoPath]) => {
      const name = repoPath.startsWith(`${worldsDir}/`) ? repoPath.slice(worldsDir.length + 1) : ''
      return name.length > '.toml'.length && name.endsWith('.toml') && !name.includes('/')
    })

    const limit = pLimit(FETCH_CONCURRENCY)
    const lockSha = blobs.get('index.lock')
    const [lockText, ...worldTexts] = await Promise.all([
      lockSha === undefined ? Promise.resolve('') : limit(() => readBlob('index.lock', lockSha)),
      ...files.map(([repoPath, sha]) => limit(() => readBlob(repoPath, sha))),
    ])
    const worlds = files.flatMap(([repoPath], index) => {
      const stem = repoPath.slice(worldsDir.length + 1, -'.toml'.length)
      const world = parseIoniumToml(worldTexts[index] ?? '', stem, worldsDir)
      if (world === null)
        ctx.log.warn('catalog: a world file of the index does not parse', { path: repoPath })
      return world === null ? [] : [world]
    })
    await pruneBlobs(
      new Set([indexSha, ...(lockSha === undefined ? [] : [lockSha]), ...files.map(([, sha]) => sha)]),
    )
    return { worlds, lock: parseIoniumLock(lockText ?? '') }
  }

  // --- the wiki ---

  /** One MediaWiki query, followed through its `continue` answers. */
  async function wikiQuery(params: Record<string, string>, each: (json: Table) => void): Promise<void> {
    let next: Record<string, string> | null = {}
    for (let request = 0; next !== null; request++) {
      if (request === MAX_WIKI_REQUESTS) {
        throw new AppError('HTTP_ERROR', { status: 200, url: WIKI_API }, { detail: 'endless continuation' })
      }
      const query = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        origin: '*',
        ...params,
        ...next,
      })
      const url = `${WIKI_API}?${query.toString()}`
      const json = await fetchJson(url)
      if (!isTable(json) || json.error !== undefined) {
        throw new AppError('HTTP_ERROR', { status: 200, url }, { detail: 'not a query answer' })
      }
      each(json)
      const more = json.continue
      next = isTable(more)
        ? Object.fromEntries(
            Object.entries(more).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
          )
        : null
    }
  }

  async function categoryTitles(category: string): Promise<Set<string>> {
    const titles = new Set<string>()
    await wikiQuery(
      { list: 'categorymembers', cmtitle: category, cmnamespace: '0', cmlimit: '500' },
      (json) => {
        for (const title of parseMembers(json)) titles.add(title)
      },
    )
    return titles
  }

  async function fetchWiki(): Promise<WikiData> {
    const pages = new Map<string, WikiPage>()
    const implementations = wikiQuery(
      {
        generator: 'categorymembers',
        gcmtitle: IMPLEMENTATIONS,
        gcmnamespace: '0',
        gcmlimit: '500',
        prop: 'pageprops',
        ppprop: 'infoboxes',
      },
      (json) => {
        for (const page of parseWikiPages(json)) if (!pages.has(page.title)) pages.set(page.title, page)
      },
    )
    const [, afterDark, rom, popTracker] = await Promise.all([
      implementations,
      categoryTitles(AFTER_DARK),
      categoryTitles(ROM_AT_GENERATION),
      categoryTitles(POPTRACKER),
    ])
    return {
      pages: [...pages.values()].sort((a, b) => byCodePoint(a.title, b.title)),
      afterDark,
      rom,
      popTracker,
    }
  }

  // --- refresh and snapshot ---

  function failure(error: unknown, what: string): ErrorCode {
    ctx.log.warn(`catalog: cannot refresh the ${what}`, error)
    return toAppErrorData(error).code
  }

  /** Both sources at once; each one that answers replaces its old data, whatever the other does. */
  async function refresh(): Promise<void> {
    const startedAt = now()
    lastAttempt = startedAt
    const [index, pages] = await Promise.allSettled([fetchIonium(), fetchWiki()])
    const failures: ErrorCode[] = []
    if (index.status === 'fulfilled') ionium = index.value
    else failures.push(failure(index.reason, 'ionium index'))
    if (pages.status === 'fulfilled') wiki = pages.value
    else failures.push(failure(pages.reason, 'wiki'))
    errors = [...new Set(failures)]
    if (failures.length === 0) fetchedAt = new Date(startedAt).toISOString()
    if (failures.length < 2) dirty = true
  }

  async function save(apVersion: string | null): Promise<void> {
    const content: z.input<typeof savedSchema> = {
      version: SAVED_VERSION,
      fetchedAt,
      apVersion,
      ionium: ionium && { worlds: ionium.worlds, lock: [...ionium.lock] },
      wiki: wiki && {
        pages: wiki.pages,
        afterDark: [...wiki.afterDark],
        rom: [...wiki.rom],
        popTracker: [...wiki.popTracker],
      },
    }
    await writeFileAtomic(savedFile, JSON.stringify(content)).catch((error: unknown) =>
      ctx.log.warn('catalog: cannot save the catalog', error),
    )
  }

  function shouldRefresh(force: boolean): boolean {
    if (force) return true
    const old = fetchedAt === null || now() - Date.parse(fetchedAt) >= FRESH_MS
    return old && (lastAttempt === null || now() - lastAttempt >= RETRY_MS)
  }

  async function installedWorlds(): Promise<{ apVersion: string | null; worlds: WorldInfo[] }> {
    try {
      const install = await deps.locator.detect()
      if (!install) return { apVersion: null, worlds: [] }
      const worlds = await scanWorlds(install.paths, disabledWorldsDir(dataRoot), install.version)
      return { apVersion: install.version ?? 'unknown', worlds }
    } catch (error) {
      ctx.log.warn('catalog: cannot list the installed worlds', error)
      return { apVersion: null, worlds: [] }
    }
  }

  const find = (match: (entry: CatalogEntry) => boolean): CatalogEntry | null => {
    const found = current().filter(match)
    // Two files of the index may name the same game: the one with something to install first.
    return found.find((entry) => entry.latest !== null) ?? found[0] ?? null
  }

  return {
    async snapshot(force) {
      if (refreshing !== null || shouldRefresh(force)) {
        await (refreshing ??= refresh().finally(() => {
          refreshing = null
        }))
      }
      const { apVersion, worlds } = await installedWorlds()
      last = build(worlds, apVersion)
      lastApVersion = apVersion
      if (dirty) {
        dirty = false
        await save(apVersion)
      }
      return { entries: last, fetchedAt, stale: errors.length > 0, errors: [...errors] }
    },

    lookup: (id) => find((entry) => entry.id === id),

    lookupByGame: (game) => find((entry) => entry.game === game),
  }
}
