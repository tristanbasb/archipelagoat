// The CoreContext every core service receives. Core code never imports 'electron': what it needs from
// Electron goes through `Platform` (implemented by src/main/platform.ts), so it runs under Vitest.
import type { OS, TaskKind } from '@shared/types'
import type { ConfigStore } from './config'
import type { EventBus } from './events'
import type { ExecFn } from './exec'
import type { Logger } from './logger'
import type { SecretStore } from './secrets'
import type { TaskManager } from './tasks'

export interface DialogFilter {
  name: string
  extensions: string[]
}

export interface OpenDialogOptions {
  mode: 'file' | 'files' | 'directory'
  title?: string
  filters?: DialogFilter[]
}

export interface SaveDialogOptions {
  defaultName: string
  title?: string
  filters?: DialogFilter[]
}

export interface PlatformPaths {
  userData: string
  dataRoot: string
  temp: string
  home: string
  downloads: string
  /** The running executable. */
  exe: string
}

export interface Platform {
  readonly os: OS
  readonly appVersion: string
  readonly isPackaged: boolean
  readonly locale: string
  readonly paths: PlatformPaths
  /** False on Linux without a real keyring (safeStorage would fall back to a fixed key). */
  canEncrypt(): boolean
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
  openPath(p: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** Selected paths; [] when cancelled. Answered from GOAT_E2E_DIALOGS in E2E runs. */
  showOpenDialog(opts: OpenDialogOptions): Promise<string[]>
  /** Chosen path; null when cancelled. Answered from GOAT_E2E_DIALOGS in E2E runs. */
  showSaveDialog(opts: SaveDialogOptions): Promise<string | null>
  /** Registers (or removes) the app as the archipelago:// handler; false when the OS refused. */
  setProtocolClient(on: boolean): boolean
}

export interface HttpGetOptions {
  cacheKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * What `getJson` and `getText` answer. `fromCache` is true when the body came from the disk cache: a
 * 304 (the server confirmed it) or a failed network. `stale` is set, to true, only in the second
 * case: the server could not be asked, so the body may be out of date.
 */
export interface HttpAnswer<T> {
  data: T
  fromCache: boolean
  stale?: true
}

/** Implemented by Task 5 (createHttp); a stub answering NOT_IMPLEMENTED until then. */
export interface Http {
  getJson<T>(url: string, opts?: HttpGetOptions): Promise<HttpAnswer<T>>
  getText(url: string, opts?: HttpGetOptions): Promise<HttpAnswer<string>>
  fetchRaw(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>
}

export interface Lifecycle {
  /**
   * Runs on quit: every `early` hook first (e.g. servers stopped with /exit), then every `late` hook
   * (e.g. killing what is left), within a global 20 s timeout. The default phase is `early`.
   */
  onBeforeQuit(fn: () => Promise<void>, opts?: { phase: 'early' | 'late' }): void
  /** Asked when the window is closed: anything running cancels the close and emits app:quitRequested. */
  onCloseRequested(fn: () => { servers: string[]; tasks: TaskKind[] }): void
  /** argv of a second launch (single-instance app). Calls made before any listener are replayed. */
  onSecondInstance(fn: (argv: string[]) => void): void
  /** A file opened through the OS. Calls made before any listener are replayed. */
  onOpenFile(fn: (path: string) => void): void
  /** Runs once the renderer has loaded; runs at once when that already happened. */
  onWindowReady(fn: () => void): void
  /** The renderer's answer to app:quitRequested (`app:confirmQuit`); stale request ids are ignored. */
  confirmQuit(requestId: string, confirm: boolean): void
}

/** Roots that `app:openPath` may open. Defaults: dataRoot, userData, downloads. */
export interface AllowedPaths {
  /** The provider is asked again on every check (e.g. the AP folder can change). */
  addAllowedRoots(provider: () => Promise<string[]>): void
  isAllowed(p: string): Promise<boolean>
}

export interface CoreContext {
  platform: Platform
  log: Logger
  exec: ExecFn
  http: Http
  tasks: TaskManager
  config: ConfigStore
  secrets: SecretStore
  bus: EventBus
  lifecycle: Lifecycle
  paths: AllowedPaths
}
