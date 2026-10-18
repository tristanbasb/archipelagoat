// What the E2E runs share: launching the built app (out/, or a packaged build) under Playwright with its
// own folders, a fake Archipelago install, a mock archipelago.gg and a queue of dialog answers; the app's
// texts in both languages; and the checks every screen goes through (console errors, CSP violations, raw
// keys).
//
// Playwright compiles this file to CommonJS: the ES modules of tests/fake-ap load through `import()`
// (inside createFakeApInstall and repoRoot), never through a static import.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type BrowserContext,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { createFakeApInstall, type DialogAnswer } from '../integration/harness'
import type { MockWebhost } from '../mock-webhost/server'
import { screenshotDir } from './screenshot-dir'
import { seedCatalog } from './seed-catalog'

export type Lang = 'fr' | 'en'

/** The games of the fake install: TUNIC for the fixture YAMLs, a few others for the worlds screen. */
const FAKE_GAMES = ['TUNIC', 'A Link to the Past', 'Pokemon Emerald', 'The Witness'] as const

/** The repository: the app Electron runs (`.`), the fixtures, the screenshots. */
export async function repoRoot(): Promise<string> {
  const { FAKE_AP_DIR } = await import('../fake-ap/make-shims.mjs')
  return resolve(FAKE_AP_DIR, '..', '..')
}

/** tests/fixtures/yamls/<name>. */
export async function fixtureYaml(name: string): Promise<string> {
  return join(await repoRoot(), 'tests', 'fixtures', 'yamls', name)
}

// --- the app's texts -----------------------------------------------------------------------------

type Texts = Record<string, unknown>

const textCache = new Map<Lang, Texts>()

const readJson = (file: string): Texts => JSON.parse(readFileSync(file, 'utf8')) as Texts

/** The app's texts as src/renderer/src/i18n/index.ts merges them: the common file, then `screens.<name>`. */
async function loadTexts(lang: Lang): Promise<Texts> {
  const cached = textCache.get(lang)
  if (cached) return cached
  const renderer = join(await repoRoot(), 'src', 'renderer', 'src')
  const screens: Texts = {}
  for (const name of readdirSync(join(renderer, 'features'))) {
    const file = join(renderer, 'features', name, `i18n.${lang}.json`)
    if (existsSync(file)) screens[name] = readJson(file)
  }
  const texts = { ...readJson(join(renderer, 'i18n', `${lang}.json`)), screens }
  textCache.set(lang, texts)
  return texts
}

/** `t('nav.home')`, `t('screens.session.eyebrow', { n: '01' })`: the app's text, or a throw for a missing key. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

export async function translator(lang: Lang): Promise<Translate> {
  const texts = await loadTexts(lang)
  return (key, params = {}) => {
    let node: unknown = texts
    for (const part of key.split('.')) node = (node as Texts | undefined)?.[part]
    if (typeof node !== 'string') throw new Error(`no ${lang} text for ${key}`)
    return node.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name] ?? `{{${name}}}`))
  }
}

// --- launching ---------------------------------------------------------------------------------

/** The folders of one installation of the app: a launch gets fresh ones, a relaunch passes them back. */
export interface AppDirs {
  root: string
  userData: string
  dataRoot: string
  /** The app's temporary folder (TMP, TEMP, TMPDIR), where it copies the fake install. */
  temp: string
  /** GOAT_E2E_DIALOGS: the JSON array of dialog answers. */
  dialogs: string
  /** GOAT_FAKE_AP_DIR, when the launch had a fake install. */
  fakeAp: string | null
}

export interface LaunchOptions {
  lang: Lang
  /** A fake Archipelago 0.6.8 (createFakeApInstall with FAKE_GAMES) as GOAT_FAKE_AP_DIR. */
  fakeAp: boolean
  /** More command line arguments after the app (an archipelago:// link, a file). */
  argv?: string[]
  /**
   * The folders of an earlier launch of this test, closed since: the same installation started again.
   * Fresh folders otherwise (each launch has its own single-instance lock).
   */
  dirs?: AppDirs
  /** Whether the boot sequence was already seen (config `firstRunDone`); fresh folders only. Default: true. */
  bootSeen?: boolean
  /** GOAT_WEBHOST_URL: the mock archipelago.gg. */
  webhostUrl?: string
  /**
   * A saved catalog of core worlds with their covers already in the covers cache (seed-catalog.ts), so that
   * the catalog tab opens offline with pictures; fresh folders only.
   */
  catalog?: boolean
  /** FAKE_CHECKS: the checks the fake ArchipelagoGenerate gives each game it measures (100 by default). */
  fakeChecks?: Readonly<Record<string, number>>
  /**
   * A packaged build's executable (win-unpacked, an installed copy, linux-unpacked…) instead of
   * `electron .`; `argv` then holds all of its arguments.
   */
  executablePath?: string
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  dirs: AppDirs
  /** Console errors, uncaught page errors and CSP violations, as they happen. */
  problems: string[]
  /** Answers for the next open or save dialogs, in order (null: cancelled). */
  queueDialogs(...answers: DialogAnswer[]): void
  /** Quits the app as a user would (servers stopped, children killed); the folders stay. */
  close(): Promise<void>
}

/**
 * A port nothing listens on: the proxy of the main process (so that its requests fail at once), or a
 * port for the app to listen on.
 */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  await new Promise<void>((done) => server.close(() => done()))
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

/**
 * A launch's own folder, in the git-ignored test-results/ rather than the system's temp folder: the
 * paths the screens show (and the screenshots keep) then hold no user name.
 */
export async function freshDirs(
  opts: Pick<LaunchOptions, 'lang' | 'fakeAp' | 'bootSeen' | 'catalog'>,
): Promise<AppDirs> {
  const parent = join(await repoRoot(), 'test-results', 'e2e-apps')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'app-'))
  const dirs: AppDirs = {
    root,
    userData: join(root, 'userData'),
    dataRoot: join(root, 'dataRoot'),
    temp: join(root, 'temp'),
    dialogs: join(root, 'dialogs.json'),
    fakeAp: opts.fakeAp ? await createFakeApInstall(join(root, 'fake-ap'), { games: FAKE_GAMES }) : null,
  }
  for (const dir of [dirs.userData, dirs.dataRoot, dirs.temp]) mkdirSync(dir, { recursive: true })
  writeFileSync(dirs.dialogs, '[]')
  // The language is set, never guessed from the machine; the boot runs once per installation.
  const config = { language: opts.lang, firstRunDone: opts.bootSeen ?? true }
  writeFileSync(join(dirs.userData, 'config.json'), JSON.stringify(config))
  if (opts.catalog) seedCatalog(dirs.dataRoot)
  return dirs
}

/**
 * The environment of a test launch: the GOAT_* test variables for `dirs` (which a packaged build
 * honours with GOAT_E2E=1 only), its own temporary folder, and no Internet for the main process: its
 * requests go to a proxy that refuses them, loopback excepted (the mock site, the fake servers), so
 * every run sees the same offline world whatever the machine.
 */
export async function appEnv(
  dirs: AppDirs,
  opts: Pick<LaunchOptions, 'webhostUrl' | 'fakeChecks'> = {},
): Promise<Record<string, string>> {
  const proxy = `http://127.0.0.1:${await freePort()}`
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      /^(?:GOAT_|FAKE_)|^ELECTRON_RUN_AS_NODE$|^(?:https?|no|all)_proxy$/i.test(key)
    ) {
      continue
    }
    env[key] = value
  }
  const proxies = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost,::1' }
  Object.assign(env, {
    GOAT_E2E: '1',
    GOAT_USER_DATA: dirs.userData,
    GOAT_DATA_ROOT: dirs.dataRoot,
    GOAT_E2E_DIALOGS: dirs.dialogs,
    TMP: dirs.temp,
    TEMP: dirs.temp,
    TMPDIR: dirs.temp,
    NODE_USE_ENV_PROXY: '1',
    ...proxies,
    // Linux reads the lower-case names first; Windows names have no case.
    ...(process.platform === 'win32'
      ? {}
      : Object.fromEntries(Object.entries(proxies).map(([key, value]) => [key.toLowerCase(), value]))),
  })
  // Without the fake, no Archipelago at all: a real install (or a running Archipelago) on the machine
  // must not change what a test sees (`none` turns the app's detection off, test environment only).
  env.GOAT_FAKE_AP_DIR = dirs.fakeAp ?? 'none'
  if (opts.webhostUrl) env.GOAT_WEBHOST_URL = opts.webhostUrl
  if (opts.fakeChecks) env.FAKE_CHECKS = JSON.stringify(opts.fakeChecks)
  return env
}

/**
 * Collects into `problems` the console errors, uncaught page errors and CSP violations of the pages
 * of `context` loaded from now on.
 */
export async function watchProblems(context: BrowserContext, problems: string[]): Promise<void> {
  context.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  context.on('weberror', (error) => problems.push(`page error: ${error.error().message}`))
  // Chromium also logs a violation as a console error; the event says it for sure.
  await context.exposeBinding('__goatCspViolation', (_source, text: string) => {
    problems.push(`csp: ${text}`)
  })
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __goatCspViolation?: (text: string) => void }).__goatCspViolation
      report?.(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })
}

/**
 * Starts the built app with the test environment of appEnv: `electron .` (so the version is the
 * package's), or the packaged build at `opts.executablePath`.
 */
export async function launchApp(opts: LaunchOptions): Promise<LaunchedApp> {
  const dirs = opts.dirs ?? (await freshDirs(opts))
  const env = await appEnv(dirs, opts)
  const app = await electron.launch(
    opts.executablePath
      ? // A packaged build starts slower (the asar, a cold disk cache) and must not depend on its cwd.
        { executablePath: opts.executablePath, args: opts.argv ?? [], cwd: dirs.root, env, timeout: 120_000 }
      : { args: ['.', ...(opts.argv ?? [])], cwd: await repoRoot(), env },
  )
  const problems: string[] = []
  await watchProblems(app.context(), problems)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  return {
    app,
    page,
    dirs,
    problems,
    queueDialogs(...answers) {
      const queue = JSON.parse(readFileSync(dirs.dialogs, 'utf8')) as DialogAnswer[]
      writeFileSync(dirs.dialogs, JSON.stringify([...queue, ...answers]))
    },
    close: () => app.close(),
  }
}

/** Removes the folders of a launch, once its app is closed. */
export function removeDirs(dirs: AppDirs): void {
  rmSync(dirs.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

// --- screens -----------------------------------------------------------------------------------

/** Goes to a route of the hash router (`/doctor`, `/session/abc?step=2`). */
export async function goTo(page: Page, route: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, `#${route}`)
}

/** The screen's one h1. */
export const screenTitle = (page: Page): Locator => page.locator('main h1').first()

/**
 * Text that should never reach the screen: an i18n key the app had no text for (i18next shows the
 * key), a raw error code, a placeholder left in. Logs, code and terminals are left out: they show
 * Archipelago's own output and file names.
 */
export async function rawTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const skip = 'pre, code, kbd, .terminal, [data-raw], script, style'
    const found = new Set<string>()
    const key =
      /\b(?:screens|errors|issues|nav|common|shell|tasks|doctor|boot|languages|actions)\.[A-Za-z][\w-]*(?:\.[\w-]+)+\b/g
    const code = /\b[A-Z][A-Z0-9]{1,}_[A-Z0-9_]{2,}\b/g
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement
      if (!parent || parent.closest(skip)) continue
      const text = node.textContent ?? ''
      for (const match of text.matchAll(key)) found.add(match[0])
      for (const match of text.matchAll(code)) found.add(match[0])
      if (text.includes('{{')) found.add(text.trim())
    }
    for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
      if (element.closest(skip)) continue
      for (const name of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(name) ?? ''
        for (const match of value.matchAll(key)) found.add(match[0])
        if (value.includes('{{')) found.add(value)
      }
    }
    return [...found]
  })
}

/** Elements whose text runs out of their box (a clipped title, a label wider than its button). */
export async function overflowingTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = []
    for (const element of document.querySelectorAll<HTMLElement>(
      'main h1, main h2, main h3, main button, main a, main label, main p, main li, header, nav',
    )) {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      // Text for screen readers only lives in a 1 px box on purpose; a control without text has none to spill.
      if (element.closest('.sr-only') || element.clientWidth <= 1 || !element.innerText.trim()) continue
      // An ellipsis is a choice; overflow that is scrolled or clipped on purpose is not a defect.
      if (style.textOverflow === 'ellipsis' || ['auto', 'scroll'].includes(style.overflowX)) continue
      if (element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
        found.push(`${element.tagName.toLowerCase()}.${element.className}: ${element.innerText.slice(0, 60)}`)
      }
    }
    return found
  })
}

/** The page settled for a still picture: fonts in, no pending spinner of the screen itself. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(page.locator('main .app-main__loading')).toHaveCount(0)
}

/**
 * Writes <name>.png into screenshotDir: test-results/screenshots/<lang>/, or the committed
 * tests/e2e/screenshots/<lang>/ with GOAT_E2E_UPDATE_SCREENSHOTS=1. Animations stopped, the caret
 * hidden, the pointer out of the way, and `mask` covered (what belongs to the machine, such as its
 * network addresses).
 */
export async function screenshot(
  page: Page,
  lang: Lang,
  name: string,
  opts: { mask?: Locator[] } = {},
): Promise<void> {
  await settle(page)
  await page.mouse.move(0, 0)
  const path = join(screenshotDir(await repoRoot(), lang), `${name}.png`)
  await page.screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    mask: opts.mask ?? [],
    maskColor: '#2b2340',
  })
}

// --- the mock site -------------------------------------------------------------------------------

/** Opens a room on the mock site as another player (its own cookie) and returns the room's id. */
export async function openMockRoom(site: MockWebhost): Promise<string> {
  // The mock keeps the upload's name and size only: any bytes make a seed.
  const form = new FormData()
  form.set('file', new Blob(['a seed']), 'AP_123.zip')
  const upload = await fetch(`${site.url}/uploads`, { method: 'POST', body: form, redirect: 'manual' })
  const seedId = upload.headers.get('location')?.split('/').pop()
  const created = await fetch(`${site.url}/new_room/${seedId}`, { redirect: 'manual' })
  const roomId = created.headers.get('location')?.split('/').pop()
  if (!roomId) throw new Error(`the mock site opened no room (${upload.status}, ${created.status})`)
  return roomId
}

// --- the organizer's flow through the screens ----------------------------------------------------

/** The wizard's Next button. */
const nextButton = (page: Page, t: Translate): Locator =>
  page.getByRole('button', { name: t('screens.session.nav.next'), exact: true })

/** /session/new: names a new game and creates it; ends on step 1 with its id. */
export async function createSession(page: Page, t: Translate, name: string): Promise<string> {
  await goTo(page, '/session/new')
  await expect(screenTitle(page)).toHaveText(t('nav.session'))
  await page.getByLabel(t('screens.session.new.nameLabel')).fill(name)
  await page.getByRole('button', { name: t('screens.session.new.create') }).click()
  await expect(screenTitle(page)).toHaveText(name)
  const id = /#\/session\/([^?]+)\?step=1$/.exec(page.url())?.[1]
  if (!id) throw new Error(`not on step 1 of a new game: ${page.url()}`)
  return id
}

/** Step 1: the YAML files picked in the (queued) file dialog, through the Browse button. */
export async function addPlayers(
  launched: LaunchedApp,
  t: Translate,
  files: readonly string[],
): Promise<void> {
  const { page } = launched
  launched.queueDialogs(files)
  await page.getByRole('button', { name: t('screens.session.players.browse') }).click()
  await expect(page.getByRole('list', { name: t('screens.session.players.listLabel') })).toBeVisible()
  await expect(page.locator('.roster-file')).toHaveCount(files.length)
}

/** Steps 2 and 3: the check (once it lets through), then the rules as they are. Ends on step 4. */
export async function checkAndKeepRules(
  page: Page,
  t: Translate,
  onStep?: (step: 2 | 3) => Promise<void>,
): Promise<void> {
  await nextButton(page, t).click()
  // Exact: the step's subtitle ("On vérifie que tout est prêt…") holds the same words.
  await expect(page.getByText(t('screens.session.check.readyTitle'), { exact: true })).toBeVisible()
  await onStep?.(2)
  await nextButton(page, t).click()
  await expect(page.getByRole('group', { name: t('screens.session.steps.rules'), exact: true })).toBeVisible()
  await onStep?.(3)
  await nextButton(page, t).click()
  await expect(page.getByRole('button', { name: t('screens.session.generate.start') })).toBeVisible()
}

/** Step 4: generates with the fake ArchipelagoGenerate, up to the slot list. */
export async function generate(page: Page, t: Translate): Promise<void> {
  await page.getByRole('button', { name: t('screens.session.generate.start') }).click()
  await expect(page.getByText(t('screens.session.generate.success'), { exact: true })).toBeVisible({
    timeout: 60_000,
  })
}

/** Step 5, local server: started with the fake ArchipelagoServer, then the live screen shows it ready. */
export async function hostLocally(page: Page, t: Translate, sessionId: string): Promise<void> {
  await nextButton(page, t).click()
  await page.getByRole('button', { name: t('screens.session.host.local.action') }).click()
  await expect(page).toHaveURL(new RegExp(`#/play/${sessionId}$`))
  await expect(screenTitle(page)).toHaveText(t('nav.play'))
  await expect(page.locator('.screen-header').getByText(t('screens.host.status.ready'))).toBeVisible({
    timeout: 30_000,
  })
}

/** The live screen's stop button and its confirmation; ends on the stopped server. */
export async function stopServer(page: Page, t: Translate): Promise<void> {
  await page.getByRole('button', { name: t('screens.host.stop.button') }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('screens.host.stop.confirm'), exact: true })
    .click()
  await expect(page.getByText(t('screens.host.stopped.title'))).toBeVisible({ timeout: 30_000 })
}
