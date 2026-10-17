// The managed install of Archipelago on Linux, end to end: the latest release read from (a local copy
// of) GitHub, its tar.gz downloaded and verified, installed in the app's data folder, then detected; the
// first install also adds the desktop entry. The services believe they run on Linux, whatever the host.
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, posix } from 'node:path'
import type { ApInstall } from '@shared/types'
import { reply, startTestServer, type TestServer } from '../helpers/http-server'
import { AP_LINUX_RELEASE_ITEMS, tarGz } from '../helpers/make-targz'
import { createTestCore, type TestCore } from './harness'

const TGZ_NAME = 'Archipelago_0.6.8_linux-x86_64.tar.gz'
const TGZ_PATH = `/ArchipelagoMW/Archipelago/releases/download/0.6.8/${TGZ_NAME}`
const LATEST_PATH = '/repos/ArchipelagoMW/Archipelago/releases/latest'

const tgz = tarGz(AP_LINUX_RELEASE_ITEMS)
const sha256 = createHash('sha256').update(tgz).digest('hex')

/** What GitHub answers for the latest release, its Linux asset being the local tar.gz. */
const release = {
  tag_name: '0.6.8',
  published_at: '2026-10-04T16:20:11Z',
  body: 'Bug fixes.',
  assets: [
    {
      name: TGZ_NAME,
      browser_download_url: `https://github.com${TGZ_PATH}`,
      size: tgz.length,
      digest: `sha256:${sha256}`,
    },
  ],
}

let tmp: string
let github: TestServer
let active: TestCore | undefined

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'goat-int-linux-'))
  github = await startTestServer((req, res) => {
    if (req.url === LATEST_PATH) return reply(res, 200, JSON.stringify(release))
    if (req.url === TGZ_PATH) return reply(res, 200, tgz)
    reply(res, 404)
  })
  active = await createTestCore({
    tmp,
    os: 'linux',
    hosts: { 'api.github.com': github.url, 'github.com': github.url },
  })
})

afterEach(async () => {
  await active?.cleanup()
  active = undefined
  await github.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

it('install linux managed from local tar.gz then detect', async () => {
  const core = active
  if (!core) throw new Error('no test core')
  const { dataRoot } = core.ctx.platform.paths
  expect(await core.call('ap:detect')).toBeNull()

  // No custom folder: the managed copy, in the app's data folder.
  const ref = await core.call('ap:install', { desktopIcons: true })
  const installed = await core.waitTask<ApInstall>(ref)

  const root = posix.join(dataRoot, 'archipelago', 'Archipelago')
  expect(installed).toMatchObject({ kind: 'linux-managed', version: '0.6.8', root, appImagePath: null })
  // Archipelago's user folder is its own folder, which the app can write to.
  expect(installed.paths).toMatchObject({
    localPath: root,
    userPath: root,
    customWorlds: posix.join(root, 'custom_worlds'),
    templates: posix.join(root, 'Players', 'Templates'),
  })
  // The settings file is joined after the shape of its folder, which on a Windows host looks like a
  // Windows path: compared as paths of the host.
  expect(normalize(installed.paths.settingsFile)).toBe(normalize(join(root, 'host.yaml')))
  expect(github.requests.map((request) => request.url)).toEqual([LATEST_PATH, TGZ_PATH])
  expect(readFileSync(join(root, 'ArchipelagoLauncher'), 'utf8')).toBe('launcher 0.6.8')
  expect(existsSync(join(root, 'Players', 'Templates', 'A Link to the Past.yaml'))).toBe(true)
  if (process.platform !== 'win32')
    expect(statSync(join(root, 'ArchipelagoLauncher')).mode & 0o111).toBe(0o111)
  // What the release installed is recorded next to the install, for the uninstall.
  expect(existsSync(join(dataRoot, 'archipelago', 'archipelagoat-files.json'))).toBe(true)
  // The extraction folder is gone.
  expect(existsSync(join(dataRoot, 'archipelago', '.staging-0.6.8'))).toBe(false)

  // Detection, through the channel the screens use, finds the same install.
  expect(await core.call('ap:detect')).toEqual(installed)

  // The first install of the managed copy adds the desktop entry (on by default under Linux).
  await vi.waitFor(
    async () => expect(await core.call('system:integration')).toMatchObject({ linuxDesktop: true }),
    {
      timeout: 10_000,
      interval: 100,
    },
  )
})
