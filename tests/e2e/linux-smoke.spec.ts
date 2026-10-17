// Smoke run of the Linux builds of `npm run dist:linux:docker` (spec §8), in the electronuserland/builder
// container under Xvfb, as root: `node scripts/smoke-linux-docker.mjs` (GOAT_E2E_LINUX_SMOKE=1).
// linux-unpacked, the deb (installed with dpkg) and the extracted tar.gz each start and show the home
// screen without an error. The AppImage cannot be mounted in a container (no FUSE): it is asked for its
// version, extracting itself (APPIMAGE_EXTRACT_AND_RUN, since its runtime only reads its own options
// first, before any other argument).
//
// Chromium refuses to run as root with its sandbox: every start passes --no-sandbox.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, removeDirs, translator, type LaunchedApp } from './helpers'
import { expectStarts, release, versionOf } from './packaged'

test.skip(process.platform !== 'linux', 'the Linux builds run on Linux')

const NO_SANDBOX = ['--no-sandbox']

let launches: LaunchedApp[] = []
let cleanups: (() => void)[] = []

test.afterEach(() => {
  for (const launched of launches) removeDirs(launched.dirs)
  for (const cleanup of cleanups.reverse()) cleanup()
  launches = []
  cleanups = []
})

async function startsAndShowsHome(exe: string): Promise<void> {
  const { version } = await release()
  expect(existsSync(exe), `${exe} (run npm run dist:linux:docker first)`).toBe(true)
  const launched = await launchApp({ lang: 'en', fakeAp: true, executablePath: exe, argv: NO_SANDBOX })
  launches.push(launched)
  try {
    await expectStarts(launched, await translator('en'), version)
  } finally {
    await launched.close().catch(() => undefined)
  }
}

test('linux-unpacked starts', async () => {
  const { dir } = await release()
  await startsAndShowsHome(join(dir, 'linux-unpacked', 'archipelagoat'))
})

test('the AppImage answers --version', async () => {
  const { version, dir } = await release()
  const appImage = join(dir, `ArchipelaGOAT-${version}.AppImage`)
  expect(existsSync(appImage), `${appImage} (run npm run dist:linux:docker first)`).toBe(true)
  // It extracts itself into the temp folder of the test environment, listing each file it writes, and
  // removes it on exit. Its runtime buffers that list and flushes the rest when it exits, after the
  // app has answered: stdbuf makes it write line by line, so that the answer is the last line.
  const { stdout, status } = await versionOf('stdbuf', ['-oL', appImage, ...NO_SANDBOX], {
    APPIMAGE_EXTRACT_AND_RUN: '1',
  })
  expect(stdout.split('\n').at(-1)).toBe(version)
  expect(status).toBe(0)
})

test('the deb installs with dpkg and its app starts', async () => {
  test.skip(process.getuid?.() !== 0, 'dpkg -i needs root: run it through scripts/smoke-linux-docker.mjs')
  const { version, dir } = await release()
  const deb = join(dir, `archipelagoat_${version}_amd64.deb`)
  expect(existsSync(deb), `${deb} (run npm run dist:linux:docker first)`).toBe(true)
  execFileSync('dpkg', ['-i', deb], { stdio: 'inherit' })
  cleanups.push(() => execFileSync('dpkg', ['-r', 'archipelagoat'], { stdio: 'inherit' }))
  // The package installs the app under /opt and links the command into /usr/bin.
  expect(execFileSync('readlink', ['-f', '/usr/bin/archipelagoat'], { encoding: 'utf8' }).trim()).toBe(
    '/opt/ArchipelaGOAT/archipelagoat',
  )
  // Its menu entry: a game, the handler of archipelago:// links (spec §8).
  const entry = readFileSync('/usr/share/applications/archipelagoat.desktop', 'utf8')
  expect(entry).toContain('Exec=/opt/ArchipelaGOAT/archipelagoat %U\n')
  expect(entry).toContain('Categories=Game;\n')
  expect(entry).toContain('MimeType=x-scheme-handler/archipelago;\n')
  await startsAndShowsHome('/opt/ArchipelaGOAT/archipelagoat')
})

test('the extracted tar.gz starts', async () => {
  const { version, dir } = await release()
  const archive = join(dir, `ArchipelaGOAT-${version}.tar.gz`)
  expect(existsSync(archive), `${archive} (run npm run dist:linux:docker first)`).toBe(true)
  const target = mkdtempSync(join(tmpdir(), 'goat-targz-'))
  cleanups.push(() => rmSync(target, { recursive: true, force: true }))
  execFileSync('tar', ['-xzf', archive, '-C', target])
  // One top folder, named after the archive.
  const [top, ...others] = readdirSync(target)
  expect(others).toEqual([])
  await startsAndShowsHome(join(target, top ?? '', 'archipelagoat'))
})
