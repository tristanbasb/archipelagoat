import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createConfigStore } from '@main/core/config'
import type { CoreContext } from '@main/core/context'
import { createEventBus } from '@main/core/events'
import { withoutApProcesses } from '@main/core/ap/processes'
import { exec as systemExec } from '@main/core/exec'
import { consoleSink, createFileSink, createLogger } from '@main/core/logger'
import { createSecretStore } from '@main/core/secrets'
import { apUserAgent, createHttp } from '@main/core/system/http'
import { createAllowedPaths } from '@main/core/system/user-path'
import { createTaskManager } from '@main/core/tasks'
import { EVENT_NAMES } from '@shared/ipc/event-names'
import { registerHandlers } from './ipc'
import { isAllowedExternalUrl } from './ipc/app'
import { installIpc } from './ipc/registry'
import { createLifecycle } from './lifecycle'
import { createPlatform, currentOs, resolveDataRoot } from './platform'
import { createServices } from './services'

// 1. The name also names the default userData folder.
app.setName('ArchipelaGOAT')

// 2. Test-only overrides, honoured for an unpackaged app or with GOAT_E2E=1 only.
const testEnv = !app.isPackaged || process.env.GOAT_E2E === '1'
// A test run with a fake Archipelago (or none) ignores the real one the machine may run.
const exec = testEnv && process.env.GOAT_FAKE_AP_DIR ? withoutApProcesses(systemExec) : systemExec
const userDataOverride = testEnv ? process.env.GOAT_USER_DATA : undefined
if (userDataOverride) {
  mkdirSync(userDataOverride, { recursive: true })
  app.setPath('userData', userDataOverride)
}
const os = currentOs()
const dataRoot = resolveDataRoot({ os, env: process.env, home: app.getPath('home'), testEnv })

// Plain objects that need no `ready`: created now so that early second-instance events are kept.
const log = createLogger([consoleSink, createFileSink(join(dataRoot, 'logs'))])
const bus = createEventBus(log)
const lifecycle = createLifecycle({ bus, log, quit: () => app.quit() })
let mainWindow: BrowserWindow | null = null

const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererFile = join(__dirname, '../renderer/index.html')

/** The app's own page (a reload), as opposed to any other destination. */
function isAppUrl(url: string): boolean {
  try {
    const target = new URL(url)
    if (devServerUrl) return target.origin === new URL(devServerUrl).origin
    target.hash = ''
    return target.href === pathToFileURL(rendererFile).href
  } catch {
    return false
  }
}

let crashDialogShown = false

/** Logs (the logger masks secrets once Task 3 lands), then offers to restart. */
function crashed(kind: string, error: unknown): void {
  log.error(`fatal: ${kind}`, error)
  if (crashDialogShown) return
  crashDialogShown = true
  if (!app.isReady()) {
    app.exit(1)
    return
  }
  // The renderer cannot help here, so this one message is written in the main process.
  const fr = app.getLocale().toLowerCase().startsWith('fr')
  void dialog
    .showMessageBox({
      type: 'error',
      title: 'ArchipelaGOAT',
      message: fr
        ? 'ArchipelaGOAT a rencontré une erreur inattendue.'
        : 'ArchipelaGOAT ran into an unexpected error.',
      detail: fr ? 'Redémarre l’app pour continuer.' : 'Restart the app to continue.',
      buttons: [fr ? 'Redémarrer' : 'Restart', fr ? 'Quitter' : 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then(({ response }) => lifecycle.runBeforeQuit().then(() => response === 0))
    .then((restart) => {
      if (restart) app.relaunch()
      app.exit(restart ? 0 : 1)
    })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    // Custom title bar on Windows and Linux; the native window buttons stay (no frame: false).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0B0B12', symbolColor: '#9D9DB0', height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!lifecycle.requestClose()) event.preventDefault()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.on('did-finish-load', () => lifecycle.windowReady())

  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(rendererFile)
  return window
}

async function main(): Promise<void> {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
    lifecycle.secondInstance(argv)
  })
  app.on('open-file', (event, path) => {
    event.preventDefault()
    lifecycle.openFile(path)
  })

  // 4. safeStorage is only reliable once the app is ready.
  await app.whenReady()

  // 5. Core context, services (eager ones register their lifecycle hooks now), then IPC.
  const platform = createPlatform({ os, dataRoot, testEnv, env: process.env, getWindow: () => mainWindow })
  mkdirSync(platform.paths.dataRoot, { recursive: true })
  const config = createConfigStore(join(platform.paths.userData, 'config.json'), os, {
    bus,
    webhostUrlOverride: testEnv ? (process.env.GOAT_WEBHOST_URL ?? null) : null,
  })
  const tasks = createTaskManager(bus, log)
  const ctx: CoreContext = {
    platform,
    log,
    exec,
    http: createHttp({
      userAgent: apUserAgent(platform.appVersion),
      cacheDir: join(platform.paths.dataRoot, 'catalog'),
      log,
      githubToken: () => ctx.secrets.get('github.token'),
    }),
    tasks,
    config,
    secrets: createSecretStore(join(platform.paths.userData, 'secrets.bin'), platform, config),
    bus,
    lifecycle,
    paths: createAllowedPaths(
      [platform.paths.dataRoot, platform.paths.userData, platform.paths.downloads],
      os,
    ),
  }
  // A secret kept in clear is encrypted once a keyring exists, and dropped once the user withdraws
  // the permission to keep it so.
  bus.on('config:changed', () => ctx.secrets.migrate())
  lifecycle.onCloseRequested(() => ({ servers: [], tasks: tasks.list().map((task) => task.kind) }))
  // Quitting cancels what still runs, so each task sees its abort signal and stops cleanly.
  lifecycle.onBeforeQuit(() => {
    for (const task of tasks.list()) tasks.cancel(task.taskId)
    return Promise.resolve()
  })
  const services = createServices(ctx)
  services.startEager()
  registerHandlers(services)
  installIpc(ipcMain, { log })

  for (const name of EVENT_NAMES) {
    bus.on(name, (payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(name, payload)
      }
    })
  }

  let hooksDone = false
  app.on('before-quit', (event) => {
    if (hooksDone) return
    event.preventDefault()
    void lifecycle.runBeforeQuit().finally(() => {
      hooksDone = true
      app.quit()
    })
  })
  app.on('window-all-closed', () => app.quit())

  // 7. No navigation away from the app and no new windows; allow-listed links open in the browser.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return
      event.preventDefault()
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  // 6. The window.
  mainWindow = createWindow()

  // 8. Crashes: log, then offer to restart.
  process.on('uncaughtException', (error) => crashed('uncaughtException', error))
  process.on('unhandledRejection', (reason) => crashed('unhandledRejection', reason))
  app.on('render-process-gone', (_event, _contents, details) => {
    if (details.reason !== 'clean-exit') crashed('render-process-gone', details)
  })
}

if (process.argv.includes('--version')) {
  // `--version` prints the version and quits with nothing started: the packaged smoke runs ask the
  // builds for it (the AppImage cannot be started otherwise in a container).
  process.stdout.write(`${app.getVersion()}\n`, () => app.exit(0))
} else if (!app.requestSingleInstanceLock()) {
  // 3. Single instance: a second launch hands its argv to the first one (second-instance) and quits.
  app.quit()
} else {
  main().catch((error: unknown) => crashed('startup', error))
}
