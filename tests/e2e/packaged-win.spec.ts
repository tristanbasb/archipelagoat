// Smoke run of the Windows builds of `npm run dist:win` (spec §8): each one starts and shows the home
// screen without an error. The unpacked app (which also answers --version, and checks for updates once
// given an app-update.yml), the portable exe, and the NSIS installer: installed silently into a
// temporary folder, its app started, then uninstalled.
//
//   GOAT_E2E_PACKAGED=1 npx playwright test tests/e2e/packaged-win.spec.ts
//
// The installer only touches this app's own per-user install: the folder given to /D, its shortcuts,
// its uninstall entry (all removed by the silent uninstall at the end) and its own copy for the
// updater, removed by the test.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import {
  appEnv,
  freePort,
  freshDirs,
  launchApp,
  removeDirs,
  translator,
  watchProblems,
  type AppDirs,
} from './helpers'
import { expectStarts, release, versionOf } from './packaged'

test.skip(process.platform !== 'win32', 'the Windows builds run on Windows')

let dirsToRemove: AppDirs[] = []

test.afterEach(() => {
  for (const dirs of dirsToRemove) removeDirs(dirs)
  dirsToRemove = []
})

const exists = (file: string): void =>
  expect(existsSync(file), `${file} (run npm run dist:win first)`).toBe(true)

/**
 * Starts the build at `exe` with fresh folders and the fake Archipelago, checks that it starts, and
 * quits it whatever happens (an installed copy is uninstalled next).
 */
async function startsAndShowsHome(exe: string): Promise<void> {
  const { version } = await release()
  exists(exe)
  const launched = await launchApp({ lang: 'fr', fakeAp: true, executablePath: exe })
  dirsToRemove.push(launched.dirs)
  try {
    await expectStarts(launched, await translator('fr'), version)
  } finally {
    await launched.close().catch(() => undefined)
  }
}

/** Runs a program to its end; its exit code. */
function run(exe: string, args: string[]): number | null {
  const result = spawnSync(exe, args, { stdio: 'ignore', timeout: 300_000 })
  if (result.error) throw result.error
  return result.status
}

test('the unpacked app answers --version and starts', async () => {
  const { version, dir } = await release()
  const exe = join(dir, 'win-unpacked', 'ArchipelaGOAT.exe')
  exists(exe)
  expect(await versionOf(exe)).toEqual({ stdout: version, status: 0 })
  await startsAndShowsHome(exe)
})

test('a build with an app-update.yml loads electron-updater and checks for updates at startup', async () => {
  // A release of the workflow has an app-update.yml; a local build has none and its updater stays off.
  // A copy of the unpacked app gets one that points at a port nothing listens on: the check reaches
  // electron-updater, which writes to the app's log, then fails on the network.
  const { dir } = await release()
  const source = join(dir, 'win-unpacked')
  exists(join(source, 'ArchipelaGOAT.exe'))
  const copy = mkdtempSync(join(tmpdir(), 'goat-updater-'))
  try {
    cpSync(source, copy, { recursive: true })
    const feed = `http://127.0.0.1:${await freePort()}/`
    writeFileSync(join(copy, 'resources', 'app-update.yml'), `provider: generic\nurl: ${feed}\n`)
    const launched = await launchApp({
      lang: 'fr',
      fakeAp: true,
      executablePath: join(copy, 'ArchipelaGOAT.exe'),
    })
    dirsToRemove.push(launched.dirs)
    try {
      const log = join(launched.dirs.dataRoot, 'logs', 'archipelagoat.log')
      const text = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '')
      await expect.poll(text, { timeout: 60_000 }).toContain('updater: check failed')
      expect(text()).toContain('Checking for update')
      expect(text()).not.toContain('TypeError')
    } finally {
      await launched.close().catch(() => undefined)
    }
  } finally {
    rmSync(copy, { recursive: true, force: true, maxRetries: 60, retryDelay: 1000 })
  }
})

test('the portable exe starts', async () => {
  // The portable exe unpacks the app into the temp folder and runs it as a child that does not share
  // its output, where Playwright's Electron launch reads the debugging endpoints: the app is reached
  // over the DevTools protocol on a known port instead.
  const { version, dir } = await release()
  const exe = join(dir, `ArchipelaGOAT-${version}-portable.exe`)
  exists(exe)
  const dirs = await freshDirs({ lang: 'fr', fakeAp: true })
  dirsToRemove.push(dirs)
  const port = await freePort()
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    cwd: dirs.root,
    env: await appEnv(dirs),
    stdio: 'ignore',
  })
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  try {
    const endpoint = `http://127.0.0.1:${port}`
    await expect
      .poll(
        () =>
          fetch(`${endpoint}/json/version`).then(
            (answer) => answer.ok,
            () => false,
          ),
        {
          timeout: 120_000,
        },
      )
      .toBe(true)
    const browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    if (!context) throw new Error('the portable app has no browser context')
    const problems: string[] = []
    await watchProblems(context, problems)
    const page = context.pages()[0] ?? (await context.waitForEvent('page'))
    // Loaded again with the watchers in place, so that the start itself is checked too.
    await page.reload()
    await expectStarts({ page, problems }, await translator('fr'), version)
    // Quits as a user closing the window would; the portable exe then removes what it unpacked.
    void page.evaluate(() => window.close()).catch(() => undefined)
    await Promise.race([exited, new Promise((done) => setTimeout(done, 60_000))])
  } finally {
    if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    await exited
  }
  expect(child.exitCode).toBe(0)
})

test('the NSIS installer installs silently, its app starts, and it uninstalls silently', async () => {
  const { version, dir } = await release()
  const setup = join(dir, `ArchipelaGOAT-Setup-${version}.exe`)
  exists(setup)
  const parent = mkdtempSync(join(tmpdir(), 'goat-nsis-'))
  // /D must come last and stay unquoted, spaces included.
  const installDir = join(parent, 'ArchipelaGOAT')
  // The installer also keeps a copy of itself there, for the updater's differential downloads, and
  // the uninstaller leaves it: removed at the end when this run made it.
  const installerCopy = join(process.env.LOCALAPPDATA ?? tmpdir(), 'archipelagoat-updater')
  const hadInstallerCopy = existsSync(installerCopy)
  try {
    expect(run(setup, ['/S', `/D=${installDir}`])).toBe(0)
    expect(existsSync(join(installerCopy, 'installer.exe'))).toBe(true)
    await startsAndShowsHome(join(installDir, 'ArchipelaGOAT.exe'))
  } finally {
    const uninstaller = join(installDir, 'Uninstall ArchipelaGOAT.exe')
    if (existsSync(uninstaller)) {
      // The uninstaller copies itself to the temp folder and returns at once; that copy removes the
      // install folder last, and exits.
      expect(run(uninstaller, ['/S'])).toBe(0)
      await expect.poll(() => existsSync(installDir), { timeout: 120_000 }).toBe(false)
    }
    if (!hadInstallerCopy) rmSync(installerCopy, { recursive: true, force: true })
    rmSync(parent, { recursive: true, force: true, maxRetries: 60, retryDelay: 1000 })
  }
})
