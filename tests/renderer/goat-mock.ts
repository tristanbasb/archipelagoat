// A fake `window.goat` for renderer tests. It answers the channels the shell needs on its own
// (app info and config, open requests, task list) and records every call; tests add or override
// handlers, and push main-process events with `emit`. Like the real preload, a rejection is a plain
// object shaped like GoatError, never an Error instance.
import { act, cleanup } from '@testing-library/react'
import { isAppErrorData, type AppErrorData } from '@shared/errors'
import type { GoatApi } from '@shared/goat-api'
import type { ChannelInput, ChannelName, ChannelOutput } from '@shared/ipc/contract'
import type { EventName, EventPayloads } from '@shared/ipc/events'
import type { AppConfig, AppInfo } from '@shared/types'
import type { ErrorCode } from '@shared/codes'

export type GoatHandlers = Partial<{
  [C in ChannelName]: (input: ChannelInput<C>) => ChannelOutput<C> | Promise<ChannelOutput<C>>
}>

export interface GoatCall {
  channel: ChannelName
  input: unknown
}

export interface GoatMock {
  /** Pushes a main-process event to the subscribers, inside act(). */
  emit<E extends EventName>(event: E, payload: EventPayloads[E]): void
  /** Every invoke, in order. */
  calls: GoatCall[]
  /** The inputs of the calls to one channel. */
  inputsOf<C extends ChannelName>(channel: C): ChannelInput<C>[]
  /** The config as the fake main process holds it (app:setConfig merges into it). */
  config(): AppConfig
}

export interface GoatMockOptions {
  config?: Partial<AppConfig>
  info?: Partial<AppInfo>
  /** What `pathForFile` answers; by default the `path` property of the file, else its name. */
  pathForFile?: (file: File) => string
}

/** The app config the shell gets by default: first run already done, every effect on. */
export const TEST_CONFIG: AppConfig = {
  language: 'auto',
  effects: { crt: true, glow: true, animations: true, sounds: false },
  showAfterDark: false,
  apPathOverride: null,
  desktopIcons: true,
  integration: { linuxDesktop: false, winProtocol: false, winAssociations: false },
  allowPlaintextSecrets: false,
  firstRunDone: true,
  firstLocalHostDone: false,
  webhostUrl: 'https://archipelago.gg',
  playerName: '',
  readyDestination: 'session',
}

export const TEST_INFO: AppInfo = {
  version: '0.1.0',
  os: 'win32',
  locale: 'fr-FR',
  isPackaged: false,
  userData: 'C:\\Users\\Joueur\\AppData\\Roaming\\ArchipelaGOAT',
  dataRoot: 'C:\\Users\\Joueur\\AppData\\Local\\ArchipelaGOAT',
  updater: 'development',
}

type BridgedError = AppErrorData & { name: 'GoatError'; message: string }

/** The plain object the preload rejects with, for handlers that want to fail. */
export function goatError(
  code: ErrorCode,
  params?: Record<string, string | number>,
  extra: { detail?: string; logPath?: string } = {},
): BridgedError {
  const data: AppErrorData = { code, ...(params ? { params } : {}), ...extra }
  return { name: 'GoatError', message: data.detail ? `${code}: ${data.detail}` : code, ...data }
}

function toBridged(error: unknown): BridgedError {
  if (isAppErrorData(error)) {
    const { code, params, detail, logPath } = error
    return goatError(code, params, {
      ...(detail !== undefined ? { detail } : {}),
      ...(logPath !== undefined ? { logPath } : {}),
    })
  }
  return goatError('AP_UNKNOWN', undefined, { detail: String(error) })
}

let previous: { had: boolean; value: GoatApi | undefined } | null = null

afterEach(() => {
  if (!previous) return
  // Unmount first (Testing Library's own cleanup would run after this hook): unmount effects may
  // still call the bridge, for example to cancel a task.
  cleanup()
  if (previous.had) window.goat = previous.value as GoatApi
  else Reflect.deleteProperty(window, 'goat')
  previous = null
})

export function installGoatMock(handlers: GoatHandlers = {}, options: GoatMockOptions = {}): GoatMock {
  let config: AppConfig = {
    ...TEST_CONFIG,
    ...options.config,
    effects: { ...TEST_CONFIG.effects, ...options.config?.effects },
  }
  const info: AppInfo = { ...TEST_INFO, ...options.info }
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const calls: GoatCall[] = []

  const emitNow = (event: string, payload: unknown): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
  }

  const defaults: GoatHandlers = {
    'app:getInfo': () => info,
    'app:getConfig': () => config,
    'app:setConfig': (patch) => {
      const { effects, ...rest } = patch ?? {}
      config = { ...config, ...rest, effects: { ...config.effects, ...effects } }
      // The real config store announces every change.
      queueMicrotask(() => act(() => emitNow('config:changed', config)))
      return config
    },
    'app:pendingOpenRequests': () => [],
    'tasks:list': () => [],
    // No game has a cover unless a test says so: the pixel sprite stays.
    'covers:get': () => ({ url: null }),
    // And no size is known for any game.
    'checks:estimate': ({ games }) =>
      Object.fromEntries(games.map((game) => [game, { max: null, profiles: null }])),
    // No session has been measured.
    'checks:lastSession': () => null,
  }
  const table = { ...defaults, ...handlers } as Record<string, ((input: unknown) => unknown) | undefined>

  const goat: GoatApi = {
    invoke: ((channel: ChannelName, input?: unknown) => {
      calls.push({ channel, input })
      const handler = table[channel]
      // Like the preload, rejections are plain GoatError-shaped objects, never Error instances.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (!handler) return Promise.reject(goatError('NOT_IMPLEMENTED', undefined, { detail: channel }))
      return Promise.resolve()
        .then(() => handler(input))
        .catch((error: unknown) => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw toBridged(error)
        })
    }) as GoatApi['invoke'],
    on: ((event: EventName, cb: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => {
        set.delete(cb)
      }
    }) as GoatApi['on'],
    os: info.os,
    pathForFile:
      options.pathForFile ?? ((file: File) => (file as File & { path?: string }).path ?? file.name),
  }

  if (!previous) previous = { had: 'goat' in window, value: (window as { goat?: GoatApi }).goat }
  window.goat = goat

  return {
    emit: (event, payload) => act(() => emitNow(event, payload)),
    calls,
    inputsOf: <C extends ChannelName>(channel: C) =>
      calls.filter((call) => call.channel === channel).map((call) => call.input as ChannelInput<C>),
    config: () => config,
  }
}
