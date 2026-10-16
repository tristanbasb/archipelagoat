// Electron implementation of the Platform interface: the only place core needs from Electron.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, dialog, safeStorage, shell, type BrowserWindow } from 'electron'
import type { OpenDialogOptions, Platform, SaveDialogOptions } from '@main/core/context'
import { AppError } from '@shared/errors'
import type { OS } from '@shared/types'

export const currentOs = (): OS => (process.platform === 'win32' ? 'win32' : 'linux')

/**
 * `%LOCALAPPDATA%\ArchipelaGOAT` on Windows, `${XDG_DATA_HOME:-~/.local/share}/ArchipelaGOAT` on
 * Linux; GOAT_DATA_ROOT replaces it in the test environment.
 */
export function resolveDataRoot(opts: {
  os: OS
  env: NodeJS.ProcessEnv
  home: string
  testEnv: boolean
}): string {
  const { os, env, home, testEnv } = opts
  if (testEnv && env.GOAT_DATA_ROOT) return env.GOAT_DATA_ROOT
  if (os === 'win32') {
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'ArchipelaGOAT')
  }
  const xdg = env.XDG_DATA_HOME
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.local', 'share')
  return path.posix.join(base, 'ArchipelaGOAT')
}

/**
 * E2E runs answer dialogs from GOAT_E2E_DIALOGS, a JSON array of answers consumed in order: a
 * string array or a string (a path), or null (cancelled). An empty queue answers "cancelled".
 */
function nextDialogAnswer(file: string): unknown {
  let queue: unknown
  try {
    queue = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(queue) || queue.length === 0) return null
  const [answer, ...rest] = queue as unknown[]
  writeFileSync(file, JSON.stringify(rest))
  return answer
}

const asPaths = (answer: unknown): string[] => {
  if (typeof answer === 'string') return [answer]
  return Array.isArray(answer) ? answer.filter((p): p is string => typeof p === 'string') : []
}

const asPath = (answer: unknown): string | null => asPaths(answer)[0] ?? null

const OPEN_PROPERTIES = {
  file: ['openFile'],
  files: ['openFile', 'multiSelections'],
  directory: ['openDirectory'],
} as const

export interface PlatformOptions {
  os: OS
  dataRoot: string
  /** Unpackaged app, or GOAT_E2E=1: the GOAT_* test variables apply. */
  testEnv: boolean
  env: NodeJS.ProcessEnv
  /** Parent of the dialogs. */
  getWindow: () => BrowserWindow | null
}

export function createPlatform({ os, dataRoot, testEnv, env, getWindow }: PlatformOptions): Platform {
  const dialogQueue = testEnv ? env.GOAT_E2E_DIALOGS || null : null

  // In development Electron runs the app's entry script, which the protocol command must repeat.
  const protocolCommand = (): [string, string[]] => [
    process.execPath,
    process.defaultApp && process.argv[1] ? [path.resolve(process.argv[1])] : [],
  ]

  return {
    os,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    locale: app.getLocale(),
    paths: {
      userData: app.getPath('userData'),
      dataRoot,
      temp: app.getPath('temp'),
      home: app.getPath('home'),
      downloads: app.getPath('downloads'),
      exe: app.getPath('exe'),
    },

    canEncrypt() {
      if (!safeStorage.isEncryptionAvailable()) return false
      if (os !== 'linux') return true
      // Without a keyring, Linux falls back to a hard-coded key: that is not encryption.
      const backend = safeStorage.getSelectedStorageBackend()
      return backend !== 'basic_text' && backend !== 'unknown'
    },
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),

    async openPath(p) {
      const error = await shell.openPath(p)
      if (error) throw new AppError('NOT_FOUND', undefined, { detail: error })
    },
    openExternal: (url) => shell.openExternal(url),

    async showOpenDialog(opts: OpenDialogOptions) {
      if (dialogQueue) return asPaths(nextDialogAnswer(dialogQueue))
      const options = {
        ...(opts.title === undefined ? {} : { title: opts.title }),
        ...(opts.filters === undefined ? {} : { filters: opts.filters }),
        properties: [...OPEN_PROPERTIES[opts.mode]],
      }
      const parent = getWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },

    async showSaveDialog(opts: SaveDialogOptions) {
      if (dialogQueue) return asPath(nextDialogAnswer(dialogQueue))
      const options = {
        defaultPath: opts.defaultName,
        ...(opts.title === undefined ? {} : { title: opts.title }),
        ...(opts.filters === undefined ? {} : { filters: opts.filters }),
      }
      const parent = getWindow()
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },

    setProtocolClient(on) {
      const [command, args] = protocolCommand()
      return on
        ? app.setAsDefaultProtocolClient('archipelago', command, args)
        : app.removeAsDefaultProtocolClient('archipelago', command, args)
    },
  }
}
