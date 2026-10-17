// Models shared by the main process and the renderer. Every IPC input and output is built from them.
import type { DoctorCheckId, ErrorCode, IssueCode } from './codes'
import type { AppErrorData } from './errors'

export type OS = 'win32' | 'linux'
export type Lang = 'fr' | 'en'

/**
 * What electron-updater does for this build: `active` downloads updates and installs them on quit
 * (the NSIS install, the AppImage), `unsupported` builds cannot replace themselves (portable, deb,
 * tar.gz), `not-configured` has no publishing repository, `development` is not packaged.
 */
export type UpdaterState = 'development' | 'not-configured' | 'unsupported' | 'active'

export interface AppInfo {
  version: string
  os: OS
  locale: string
  isPackaged: boolean
  userData: string
  dataRoot: string
  updater: UpdaterState
}

export interface AppConfig {
  language: Lang | 'auto'
  effects: { crt: boolean; glow: boolean; animations: boolean; sounds: boolean }
  showAfterDark: boolean
  apPathOverride: string | null
  desktopIcons: boolean
  integration: { linuxDesktop: boolean; winProtocol: boolean; winAssociations: boolean }
  allowPlaintextSecrets: boolean
  firstRunDone: boolean
  /** A local server was hosted once: Windows already asked to let it through its firewall. */
  firstLocalHostDone: boolean
  webhostUrl: string
}

export interface ApPaths {
  localPath: string
  userPath: string
  customWorlds: string
  coreWorlds: string
  players: string
  templates: string
  output: string
  logs: string
  cache: string
  settingsFile: string
}

export type ApInstallKind =
  'windows-installer' | 'linux-managed' | 'linux-targz' | 'linux-appimage' | 'custom'

export interface ApInstall {
  kind: ApInstallKind
  version: string | null
  root: string
  appImagePath: string | null
  paths: ApPaths
}

export interface ExeRef {
  command: string
  argsPrefix: string[]
  env?: Record<string, string>
}

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  sha256: string | null
}

export interface ApRelease {
  tag: string
  version: string
  publishedAt: string
  notes: string
  windows: ReleaseAsset | null
  linuxTarGz: ReleaseAsset | null
  appImage: ReleaseAsset | null
}

export type TaskKind =
  | 'ap-install'
  | 'ap-uninstall'
  | 'templates'
  | 'world-prepare'
  | 'generate'
  | 'webhost-host'
  | 'join-prepare'
  | 'rom-scan'
  | 'bizhawk-install'

export interface TaskRef {
  taskId: string
}

export interface TaskProgress {
  taskId: string
  kind: TaskKind
  stage: string
  percent: number | null
  detail?: Record<string, string | number>
}

export interface TaskLog {
  taskId: string
  stream: 'stdout' | 'stderr' | 'app'
  line: string
}

export interface TaskDone {
  taskId: string
  kind: TaskKind
  result: unknown
}

export interface TaskFailed {
  taskId: string
  kind: TaskKind
  error: AppErrorData
}

export interface Issue {
  severity: 'error' | 'warning'
  code: IssueCode
  path?: string
  params?: Record<string, string | number>
}

export interface WorldManifest {
  game: string
  worldVersion: string | null
  minimumApVersion: string | null
  maximumApVersion: string | null
  authors: string[]
  version: number | null
  compatibleVersion: number | null
}

export type WorldState =
  'ok' | 'no-manifest' | 'incompatible' | 'corrupt' | 'shadowed' | 'core-loose' | 'disabled' | 'bad-name'

export interface WorldInfo {
  id: string
  fileName: string
  path: string
  location: 'custom' | 'core' | 'disabled'
  module: string
  game: string | null
  manifest: WorldManifest | null
  states: WorldState[]
  sizeBytes: number
}

export type TrustTier = 'core' | 'indexed-verified' | 'wiki-release' | 'unknown'

export type WorldSource =
  { kind: 'file'; path: string } | { kind: 'url'; url: string } | { kind: 'catalog'; id: string }

export interface WorldInstallPlan {
  planId: string
  source: WorldSource
  module: string
  targetFileName: string
  manifest: WorldManifest | null
  sha256: string
  trust: TrustTier
  homepage: string | null
  /**
   * The link a catalog world was downloaded from (its source only names the catalog entry): where
   * its code really comes from, whatever its homepage says. Null for a file or a link.
   */
  origin: string | null
  conflicts: { worldId: string; version: string | null; winner: 'new' | 'existing' }[]
  warnings: IssueCode[]
}

/** `index`: a world of the ionium index (enriched by the wiki); `wiki`: listed by a wiki page alone. */
export type CatalogSource = 'index' | 'wiki'

/**
 * Where a wiki-only world is downloaded from. `github-latest`: the latest stable release of `repo`
 * (`owner/repo`), resolved when it is installed; `page`: any other link, opened in the browser.
 */
export type CatalogDownload =
  { kind: 'github-latest'; repo: string; pageUrl: string } | { kind: 'page'; url: string }

export interface CatalogEntry {
  id: string
  source: CatalogSource
  game: string
  displayName: string
  homepage: string | null
  tags: string[]
  supported: boolean
  afterDark: boolean
  requiresRomAtGeneration: boolean
  hasPopTracker: boolean
  wiki: {
    title: string
    url: string
    status: string | null
    maintainer: string | null
    setupUrl: string | null
  } | null
  latest: { version: string; url: string; sha256: string | null } | null
  /** Null for every index entry (`latest` says what it installs). */
  download: CatalogDownload | null
  installedVersion: string | null
  trust: TrustTier
}

export interface CatalogSnapshot {
  entries: CatalogEntry[]
  fetchedAt: string | null
  stale: boolean
  errors: ErrorCode[]
}

export type OptionKind =
  'toggle' | 'choice' | 'text-choice' | 'range' | 'named-range' | 'list' | 'set' | 'dict' | 'free'

export interface OptionSchema {
  key: string
  group: string
  doc: string
  kind: OptionKind
  default: unknown
  choices: string[]
  range: { min: number; max: number } | null
  specialNames: Record<string, number>
  confidence: 'exact' | 'inferred'
}

export interface GameSchema {
  game: string
  source: 'local' | 'site'
  apVersion: string | null
  groups: { name: string; options: OptionSchema[] }[]
  presets: Record<string, Record<string, unknown>>
}

export interface StudioGame {
  game: string
  installed: boolean
  schemaSource: 'local' | 'site' | 'none'
}

export type OptionValue =
  | { mode: 'value'; value: unknown }
  | { mode: 'weighted'; weights: Record<string, number> }
  | { mode: 'raw'; yaml: string }

export interface EditorDoc {
  name: string
  description: string
  game: string
  requiresVersion: string | null
  options: Record<string, OptionValue>
  extraRoot: Record<string, unknown>
}

export interface PlayerDoc {
  index: number
  name: string | null
  games: { game: string; weight: number }[]
  issues: Issue[]
}

export interface PlayerFile {
  id: string
  originalName: string
  storedName: string
  docs: PlayerDoc[]
  addedAt: string
}

export type ReleaseMode = 'auto' | 'enabled' | 'disabled' | 'goal' | 'auto-enabled'

export interface Rules {
  preset: 'casual' | 'async' | 'race' | 'custom'
  spoiler: 0 | 1 | 2 | 3
  race: boolean
  hintCost: number
  locationCheckPoints: number
  releaseMode: ReleaseMode
  collectMode: ReleaseMode
  remainingMode: 'enabled' | 'disabled' | 'goal'
  countdownMode: 'enabled' | 'disabled' | 'auto'
  itemCheat: boolean
  autoShutdown: number
  plando: ('bosses' | 'items' | 'texts' | 'connections')[]
  compatibility: 0 | 1 | 2
}

export interface Slot {
  slot: number
  name: string
  game: string
  patchFile: string | null
}

export interface Generation {
  seedName: string
  zipPath: string
  spoilerName: string | null
  slots: Slot[]
  durationS: number
  logPath: string
}

/**
 * A web hosting's `seedName` is the generation its room hosts (absent in sessions hosted before it was
 * recorded: a new generation always resets the hosting, so such a room hosts the current one).
 */
export type Hosting =
  | { mode: 'local'; port: number; savefile: string }
  | {
      mode: 'web'
      seedId: string
      roomId: string
      roomUrl: string
      port: number | null
      seedName?: string
    }

export type SessionStatus = 'draft' | 'generated' | 'hosting' | 'finished'

export interface Session {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  players: PlayerFile[]
  rules: Rules
  hasPassword: boolean
  hasServerPassword: boolean
  generation: Generation | null
  hosting: Hosting | null
  workspace: string
}

export interface SessionSummary {
  id: string
  name: string
  status: SessionStatus
  playerCount: number
  updatedAt: string
  hostingMode: 'local' | 'web' | null
}

/**
 * `path` is the absolute path to write in the session host.yaml when `status === 'ok'` (the
 * effective settings key when it is valid, otherwise the vault path).
 */
export interface RomNeed {
  game: string
  settingsKey: string
  status: 'ok' | 'missing' | 'bad-hash'
  path: string | null
  vaultPath: string | null
}

export interface SessionValidation {
  files: { fileId: string; docs: PlayerDoc[] }[]
  sessionIssues: Issue[]
  /**
   * `catalogId`: the entry to install the world from; else `downloadPage`, the page its file is
   * downloaded from by hand (`downloadPageOf`), when the catalog lists it with one.
   */
  missingWorlds: { game: string; catalogId: string | null; downloadPage: string | null }[]
  romNeeds: RomNeed[]
  blocking: boolean
}

export interface Address {
  /** `vpn`: only players on the same VPN (Tailscale, ZeroTier…) reach it. */
  kind: 'localhost' | 'lan' | 'vpn' | 'public'
  host: string
  port: number
  /** The VPN, when its network interface names it (`Tailscale`). */
  network?: string
}

export interface ServerState {
  sessionId: string
  status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'crashed'
  port: number
  addresses: Address[]
  startedAt: string
  resumedFromSave: boolean
  error: AppErrorData | null
  /**
   * The slot the app's item tracker is logged in as, while it is: the server counts that connection
   * in /players and /status.
   */
  tracker?: string
}

/** The class Archipelago colors an item with (progression, useful, trap or filler). */
export type ItemClass = 'progression' | 'useful' | 'trap' | 'filler'

export interface ServerEvent {
  ts: string
  kind: 'join' | 'leave' | 'item' | 'goal' | 'all-goals' | 'chat' | 'output'
  text: string
  player?: string
  receiver?: string
  item?: string
  location?: string
  /** For an item: its class, when the app's item tracker could tell it. */
  itemClass?: ItemClass
}

export interface WebRoom {
  roomId: string
  seedId: string
  roomUrl: string
  host: string
  port: number | null
  lastActivity: string | null
  timeoutS: number | null
  players: { name: string; game: string }[]
  downloads: { slot: number; url: string }[]
  trackerUrl: string | null
}

export interface WebRoomRef {
  roomId: string
  seedId: string | null
  roomUrl: string
  lastActivity: string | null
}

export interface PatchManifest {
  game: string
  player: number
  playerName: string
  server: string | null
  patchFileEnding: string
  baseChecksums: string[]
  resultFileEnding: string | null
  compatibleVersion: number | null
  version: number | null
}

export type ClientKind =
  'bizhawk' | 'sni' | 'oot' | 'mmbn3' | 'tloz' | 'adventure' | 'zillion' | 'launcher' | 'text' | 'none'

export interface PatchRoute {
  suffix: string
  client: ClientKind
  exe: string | null
  tier: 'full' | 'assisted' | 'guided'
}

export type JoinTarget =
  | { kind: 'room'; roomId: string }
  | {
      kind: 'address'
      host: string
      port: number
      slot: string | null
      password: string | null
      game: string | null
    }
  | { kind: 'patch'; path: string }

/** `code` takes its values from `CHECK_CODES`. */
export interface CheckItem {
  status: 'ok' | 'missing' | 'warning' | 'na'
  code: string
  params?: Record<string, string | number>
}

export interface JoinPlan {
  planId: string
  target: JoinTarget
  slots: { name: string; game: string }[]
  slot: { name: string; game: string } | null
  patchPath: string | null
  manifest: PatchManifest | null
  route: PatchRoute
  connect: { host: string; port: number | null; slot: string | null; hasPassword: boolean }
  tutorialUrl: string | null
  checklist: { ap: CheckItem; world: CheckItem; rom: CheckItem; emulator: CheckItem }
  warnings: Issue[]
  ready: boolean
}

export interface RomTableEntry {
  game: string
  label: string
  md5s: string[]
  header: 'snes' | 'ines' | 'none'
  settingsKey: string
  requiredAtGeneration: boolean
  extensions: string[]
}

export interface RomRecord {
  path: string
  size: number
  mtimeMs: number
  md5: string
  game: string | null
  label: string | null
  settingsKey: string | null
}

export interface VaultApplyResult {
  applied: { game: string; key: string; path: string }[]
  skipped: { game: string; reason: ErrorCode }[]
}

export interface BizhawkState {
  installed: boolean
  managed: boolean
  version: string | null
  path: string | null
  configuredInAp: boolean
  prereqs: { name: string; ok: boolean; hint: string | null }[]
}

export type DoctorSeverity = 'ok' | 'info' | 'warning' | 'error'

export interface DoctorCheck {
  id: DoctorCheckId
  severity: DoctorSeverity
  params: Record<string, string | number>
  fix: { kind: 'auto' } | { kind: 'navigate'; to: string } | null
}

export interface IntegrationState {
  linuxDesktop: boolean
  winProtocol: boolean
  winAssociations: boolean
  available: { linuxDesktop: boolean; winProtocol: boolean; winAssociations: boolean }
}

export interface OpenRequest {
  kind: 'uri' | 'file'
  value: string
}

export interface QuitRequest {
  requestId: string
  runningServers: string[]
  runningTasks: TaskKind[]
}

/** Ring buffers of the last 500 events and the last 500 log lines. */
export interface ServerHistory {
  events: ServerEvent[]
  log: string[]
}
