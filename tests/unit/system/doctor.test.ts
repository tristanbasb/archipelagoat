import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  everyoneCanModify,
  fixDoctor,
  freeBytes,
  probeNetwork,
  runDoctor,
  type DoctorDeps,
} from '@main/core/system/doctor'
import { listZip, readZipText } from '@main/core/system/archive'
import type { ExecFn } from '@main/core/exec'
import { MASK } from '@main/core/system/redact'
import { createSupportBundle, type SupportBundleDeps } from '@main/core/system/support-bundle'
import { disabledWorldsDir } from '@main/core/worlds/inventory'
import { DOCTOR_CHECK_IDS, type DoctorCheckId } from '@shared/codes'
import { AppError } from '@shared/errors'
import type { ApInstall, ApRelease, BizhawkState, DoctorCheck } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'
import { makeApworld } from '../../helpers/make-apworld'

const BIZHAWK_OK: BizhawkState = {
  installed: true,
  managed: true,
  version: '2.11.1',
  path: 'C:\\BizHawk',
  configuredInAp: true,
  prereqs: [{ name: 'bizhawk-version', ok: true, hint: null }],
}

const release = (version: string): ApRelease => ({
  tag: version,
  version,
  publishedAt: '2026-10-01T00:00:00Z',
  notes: '',
  windows: null,
  linuxTarGz: null,
  appImage: null,
})

let dir: string
let core: TestCore
let install: ApInstall

function apInstall(root: string): ApInstall {
  return {
    kind: 'windows-installer',
    version: '0.6.8',
    root,
    appImagePath: null,
    paths: {
      localPath: root,
      userPath: root,
      customWorlds: join(root, 'custom_worlds'),
      coreWorlds: join(root, 'lib', 'worlds'),
      players: join(root, 'Players'),
      templates: join(root, 'Players', 'Templates'),
      output: join(root, 'output'),
      logs: join(root, 'logs'),
      cache: join(root, 'cache'),
      settingsFile: join(root, 'host.yaml'),
    },
  }
}

/** Every probe answers "all is well"; each test changes what it looks at. */
function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    ctx: core.ctx,
    locator: { detect: () => Promise.resolve(install) },
    settingsFile: () => Promise.resolve(install.paths.settingsFile),
    bizhawkState: () => Promise.resolve(BIZHAWK_OK),
    listProcesses: () => Promise.resolve([]),
    ownServerPorts: () => [],
    latestRelease: () => Promise.resolve(release('0.6.8')),
    isPortFree: () => Promise.resolve(true),
    checkGlibc: () => Promise.resolve({ version: '2.39', ok: true }),
    freeBytes: () => Promise.resolve(50 * 1024 ** 3),
    everyoneCanModify: () => Promise.resolve(false),
    network: () => Promise.resolve({ online: true, clockSkewS: 1 }),
    ...overrides,
  }
}

const byId = (checks: DoctorCheck[], id: DoctorCheckId): DoctorCheck | undefined =>
  checks.find((check) => check.id === id)

/** The checks that are not `ok`, by id. */
function problems(checks: DoctorCheck[]): Partial<Record<DoctorCheckId, DoctorCheck>> {
  return Object.fromEntries(checks.filter((c) => c.severity !== 'ok').map((c) => [c.id, c]))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat doctor é-'))
  core = createTestContext(dir)
  install = apInstall(join(dir, 'Archipelago'))
  mkdirSync(install.paths.customWorlds, { recursive: true })
  mkdirSync(install.paths.coreWorlds, { recursive: true })
  writeFileSync(install.paths.settingsFile, 'general_options:\n  output_path: output\n')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('runDoctor', () => {
  it('doctor flags corrupt world as error with auto fix and no-manifest as warning', async () => {
    writeFileSync(join(install.paths.customWorlds, 'broken.apworld'), 'not a zip at all')
    await makeApworld(join(install.paths.customWorlds, 'pokemon_crystal.apworld'), { manifest: null })
    await makeApworld(join(install.paths.customWorlds, 'celeste.apworld'))

    const checks = await runDoctor(deps())
    expect(checks.map((check) => check.id)).toEqual([...DOCTOR_CHECK_IDS])
    expect(problems(checks)).toEqual({
      'worlds-corrupt': {
        id: 'worlds-corrupt',
        severity: 'error',
        params: { count: 1, files: 'broken.apworld' },
        fix: { kind: 'auto' },
      },
      'worlds-no-manifest': {
        id: 'worlds-no-manifest',
        severity: 'warning',
        params: { count: 1, files: 'pokemon_crystal.apworld' },
        fix: { kind: 'navigate', to: '/worlds' },
      },
    })
    expect(byId(checks, 'ap-installed')).toMatchObject({
      severity: 'ok',
      params: { version: '0.6.8', path: install.root },
    })
  })

  it('flags incompatible worlds and custom duplicates, not a core world a newer custom one replaces', async () => {
    const manifest = (game: string, fields: Record<string, unknown>) => ({
      game,
      version: 7,
      compatible_version: 7,
      ...fields,
    })
    await makeApworld(join(install.paths.customWorlds, 'future.apworld'), {
      manifest: manifest('Future', { minimum_ap_version: '0.7.0' }),
    })
    await makeApworld(join(install.paths.customWorlds, 'celeste.apworld'), {
      manifest: manifest('Celeste', { world_version: '2.0.0' }),
    })
    await makeApworld(join(install.paths.customWorlds, 'celeste_old.apworld'), {
      module: 'celeste_old',
      manifest: manifest('Celeste', { world_version: '1.0.0' }),
    })
    await makeApworld(join(install.paths.customWorlds, 'pokemon_emerald.apworld'), {
      manifest: manifest('Pokemon Emerald', { world_version: '9.0.0' }),
    })
    await makeApworld(join(install.paths.coreWorlds, 'pokemon_emerald.apworld'), {
      manifest: manifest('Pokemon Emerald', { world_version: '2.4.0' }),
    })

    expect(problems(await runDoctor(deps()))).toEqual({
      'worlds-incompatible': {
        id: 'worlds-incompatible',
        severity: 'warning',
        params: { count: 1, files: 'future.apworld' },
        fix: { kind: 'navigate', to: '/worlds' },
      },
      'worlds-shadowed': {
        id: 'worlds-shadowed',
        severity: 'warning',
        params: { count: 1, files: 'celeste_old.apworld' },
        fix: { kind: 'navigate', to: '/worlds' },
      },
    })
  })

  it('flags a world whose file is not named after its module: Archipelago never loads it', async () => {
    await makeApworld(join(install.paths.customWorlds, 'rhythm_doctor-v0.0.11.apworld'), {
      module: 'rhythm_doctor',
      game: 'Rhythm Doctor',
    })
    expect(problems(await runDoctor(deps()))).toEqual({
      'worlds-bad-name': {
        id: 'worlds-bad-name',
        severity: 'warning',
        params: { count: 1, files: 'rhythm_doctor-v0.0.11.apworld' },
        fix: { kind: 'navigate', to: '/worlds' },
      },
    })
  })

  it('a corrupt core world sends to the install screen: it cannot be set aside', async () => {
    writeFileSync(join(install.paths.coreWorlds, 'alttp.apworld'), 'garbage')
    expect(byId(await runDoctor(deps()), 'worlds-corrupt')).toEqual({
      id: 'worlds-corrupt',
      severity: 'error',
      params: { count: 1, files: 'alttp.apworld' },
      fix: { kind: 'navigate', to: '/install' },
    })
  })

  it('a missing Archipelago is an error with the install screen as fix; what needs it is skipped', async () => {
    const checks = await runDoctor(deps({ locator: { detect: () => Promise.resolve(null) } }))
    expect(problems(checks)).toEqual({
      'ap-installed': {
        id: 'ap-installed',
        severity: 'error',
        params: {},
        fix: { kind: 'navigate', to: '/install' },
      },
    })
    for (const id of ['ap-update', 'settings-file', 'worlds-corrupt', 'worlds-shadowed'] as const) {
      expect(byId(checks, id)).toEqual({
        id,
        severity: 'ok',
        params: { skipped: 'ap-not-installed' },
        fix: null,
      })
    }
  })

  it('ap-update warns when a newer release exists, and stays quiet when GitHub cannot say', async () => {
    const newer = await runDoctor(deps({ latestRelease: () => Promise.resolve(release('0.6.10')) }))
    expect(byId(newer, 'ap-update')).toEqual({
      id: 'ap-update',
      severity: 'warning',
      params: { installed: '0.6.8', latest: '0.6.10' },
      fix: { kind: 'navigate', to: '/install' },
    })

    const offline = await runDoctor(
      deps({
        latestRelease: () => Promise.reject(new AppError('NETWORK_OFFLINE', undefined, { detail: 'x' })),
      }),
    )
    expect(byId(offline, 'ap-update')).toEqual({
      id: 'ap-update',
      severity: 'ok',
      params: { skipped: 'release-unavailable', error: 'NETWORK_OFFLINE: x' },
      fix: null,
    })

    install = { ...install, version: null }
    expect(byId(await runDoctor(deps()), 'ap-update')).toEqual({
      id: 'ap-update',
      severity: 'info',
      params: { installed: 'unknown', latest: '0.6.8' },
      fix: { kind: 'navigate', to: '/install' },
    })
  })

  it('doctor flags port 38281 busy and running AP processes', async () => {
    const isPortFree = vi.fn((port: number) => Promise.resolve(port !== 38281))
    const checks = await runDoctor(
      deps({
        isPortFree,
        listProcesses: () =>
          Promise.resolve([
            { pid: 42, name: 'ArchipelagoServer.exe' },
            { pid: 43, name: 'ArchipelagoLauncher.exe' },
          ]),
      }),
    )
    expect(problems(checks)).toEqual({
      'ap-processes': {
        id: 'ap-processes',
        severity: 'warning',
        params: { count: 2, processes: 'ArchipelagoServer.exe, ArchipelagoLauncher.exe' },
        fix: null,
      },
      'port-38281': { id: 'port-38281', severity: 'warning', params: { port: 38281 }, fix: null },
    })
    expect(isPortFree).toHaveBeenCalledWith(38281)
  })

  it("a port held by one of the app's servers is a note, and is not probed", async () => {
    const isPortFree = vi.fn(() => Promise.resolve(false))
    const checks = await runDoctor(deps({ isPortFree, ownServerPorts: () => [38281] }))
    expect(byId(checks, 'port-38281')).toEqual({
      id: 'port-38281',
      severity: 'info',
      params: { port: 38281, owner: 'archipelagoat' },
      fix: null,
    })
    expect(isPortFree).not.toHaveBeenCalled()
  })

  it('settings file: missing is a note, unreadable YAML an error', async () => {
    rmSync(install.paths.settingsFile)
    expect(byId(await runDoctor(deps()), 'settings-file')).toEqual({
      id: 'settings-file',
      severity: 'info',
      params: { path: install.paths.settingsFile, reason: 'missing' },
      fix: null,
    })

    writeFileSync(install.paths.settingsFile, 'general_options:\n  output_path: [unclosed\n')
    expect(byId(await runDoctor(deps()), 'settings-file')).toMatchObject({
      severity: 'error',
      params: { path: install.paths.settingsFile, reason: 'yaml' },
    })

    mkdirSync(join(dir, 'folder.yaml'))
    expect(
      byId(
        await runDoctor(deps({ settingsFile: () => Promise.resolve(join(dir, 'folder.yaml')) })),
        'settings-file',
      ),
    ).toMatchObject({ severity: 'error', params: { reason: 'unreadable' } })
  })

  it('bizhawk, disk space and network', async () => {
    const found = problems(
      await runDoctor(
        deps({
          bizhawkState: () =>
            Promise.resolve({
              ...BIZHAWK_OK,
              prereqs: [
                { name: 'vc-redist', ok: false, hint: null },
                { name: 'bizhawk-version', ok: true, hint: null },
              ],
            }),
          freeBytes: (path) =>
            Promise.resolve(path === install.paths.userPath ? 300 * 1024 ** 2 : 9 * 1024 ** 3),
          network: () => Promise.resolve({ online: true, clockSkewS: -900 }),
        }),
      ),
    )
    expect(found.bizhawk).toEqual({
      id: 'bizhawk',
      severity: 'warning',
      params: { missing: 'vc-redist' },
      fix: { kind: 'navigate', to: '/vault' },
    })
    expect(found['disk-space']).toEqual({
      id: 'disk-space',
      severity: 'warning',
      params: { path: install.paths.userPath, freeMb: 300 },
      fix: null,
    })
    expect(found.network).toEqual({
      id: 'network',
      severity: 'warning',
      params: { reason: 'clock', skewS: -900 },
      fix: null,
    })
  })

  it('the ProgramData permissions are a Windows note, glibc a Linux check', async () => {
    const probes: Partial<DoctorDeps> = {
      everyoneCanModify: () => Promise.resolve(true),
      checkGlibc: () => Promise.resolve({ version: '2.31', ok: false }),
    }
    core = createTestContext(dir, { os: 'win32' })
    const windows = await runDoctor(deps(probes))
    expect(byId(windows, 'programdata-acl')).toEqual({
      id: 'programdata-acl',
      severity: 'info',
      params: { path: install.root },
      fix: null,
    })
    expect(byId(windows, 'glibc')).toMatchObject({ severity: 'ok', params: { skipped: 'not-linux' } })
    // A folder the user picked is not the installer's.
    install = { ...install, kind: 'custom' }
    expect(byId(await runDoctor(deps(probes)), 'programdata-acl')).toMatchObject({
      severity: 'ok',
      params: { skipped: 'no-installer-folder' },
    })

    core = createTestContext(dir, { os: 'linux' })
    const linux = await runDoctor(deps(probes))
    expect(byId(linux, 'glibc')).toEqual({
      id: 'glibc',
      severity: 'error',
      params: { version: '2.31', min: '2.35' },
      fix: null,
    })
    expect(byId(linux, 'programdata-acl')).toMatchObject({
      severity: 'ok',
      params: { skipped: 'not-windows' },
    })
    // A C library that is not glibc (musl), or an ldd that cannot run: unknown, so a warning.
    const unknown = await runDoctor(deps({ checkGlibc: () => Promise.resolve({ version: null, ok: false }) }))
    expect(byId(unknown, 'glibc')).toEqual({
      id: 'glibc',
      severity: 'warning',
      params: { version: 'unknown', min: '2.35' },
      fix: null,
    })
  })

  it('bizhawk not installed is a note; offline is a warning', async () => {
    const checks = await runDoctor(
      deps({
        bizhawkState: () =>
          Promise.resolve({ ...BIZHAWK_OK, installed: false, managed: false, version: null, path: null }),
        network: () => Promise.resolve({ online: false, clockSkewS: null }),
      }),
    )
    expect(byId(checks, 'bizhawk')).toEqual({
      id: 'bizhawk',
      severity: 'info',
      params: {},
      fix: { kind: 'navigate', to: '/vault' },
    })
    expect(byId(checks, 'network')).toEqual({
      id: 'network',
      severity: 'warning',
      params: { reason: 'offline' },
      fix: null,
    })
  })

  it('a check that fails is a note with its error, and secrets never reach the params', async () => {
    const checks = await runDoctor(
      deps({
        listProcesses: () => Promise.reject(new Error('cannot reach https://joueur:hunter2@example.org/x')),
      }),
    )
    expect(byId(checks, 'ap-processes')).toEqual({
      id: 'ap-processes',
      severity: 'info',
      params: { error: `cannot reach https://joueur:${MASK}@example.org/x` },
      fix: null,
    })
  })
})

describe('default probes', () => {
  it('freeBytes reads the free space of the volume', async () => {
    expect(await freeBytes(dir)).toBeGreaterThan(0)
  })

  it('probeNetwork reads the clock of the server', async () => {
    const now = Date.parse('2026-10-17T10:00:00Z')
    const fetchRaw = vi.fn(() =>
      Promise.resolve(new Response(null, { headers: { date: 'Sat, 17 Oct 2026 09:58:00 GMT' } })),
    )
    expect(await probeNetwork({ fetchRaw }, () => now)).toEqual({ online: true, clockSkewS: 120 })
    expect(fetchRaw).toHaveBeenCalledWith('https://github.com', expect.objectContaining({ method: 'HEAD' }))
    expect(await probeNetwork({ fetchRaw: () => Promise.resolve(new Response(null)) })).toEqual({
      online: true,
      clockSkewS: null,
    })
    expect(await probeNetwork({ fetchRaw: () => Promise.reject(new AppError('NETWORK_OFFLINE')) })).toEqual({
      online: false,
      clockSkewS: null,
    })
  })

  it('everyoneCanModify asks PowerShell about the well-known groups, by SID', async () => {
    const scripts: string[] = []
    const exec: ExecFn = (_cmd, _args, opts) => {
      scripts.push(opts?.input ?? '')
      return Promise.resolve({ code: 0, stdout: 'true\r\n', stderr: '' })
    }
    expect(await everyoneCanModify(exec, "C:\\ProgramData\\Archipel'ago")).toBe(true)
    expect(scripts[0]).toContain("Get-Acl -LiteralPath 'C:\\ProgramData\\Archipel''ago'")
    expect(scripts[0]).toContain('S-1-1-0')
    const failing: ExecFn = () => Promise.resolve({ code: 1, stdout: '', stderr: 'denied' })
    await expect(everyoneCanModify(failing, 'C:\\x')).rejects.toThrow(/denied/)
  })
})

describe('fixDoctor', () => {
  it('fix worlds-corrupt moves files to disabled-worlds', async () => {
    const broken = join(install.paths.customWorlds, 'broken.apworld')
    writeFileSync(broken, 'not a zip at all')
    await makeApworld(join(install.paths.customWorlds, 'celeste.apworld'))
    const changed = vi.fn()
    core.ctx.bus.on('worlds:changed', changed)

    const checks = await fixDoctor('worlds-corrupt', deps())
    expect(byId(checks, 'worlds-corrupt')).toEqual({
      id: 'worlds-corrupt',
      severity: 'ok',
      params: {},
      fix: null,
    })
    expect(existsSync(broken)).toBe(false)
    expect(readdirSync(disabledWorldsDir(core.platform.paths.dataRoot))).toEqual(['broken.apworld'])
    expect(readdirSync(install.paths.customWorlds)).toEqual(['celeste.apworld'])
    expect(changed).toHaveBeenCalledOnce()
  })

  it('refuses a check without an automatic fix, and a fix without Archipelago', async () => {
    await expect(fixDoctor('port-38281', deps())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      params: { checkId: 'port-38281' },
    })
    await expect(
      fixDoctor('worlds-corrupt', deps({ locator: { detect: () => Promise.resolve(null) } })),
    ).rejects.toMatchObject({ code: 'AP_NOT_INSTALLED' })
  })
})

describe('createSupportBundle', () => {
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const NOW = new Date(2026, 9, 17, 10, 15, 0)
  const DAY = 24 * 60 * 60 * 1000

  function bundleDeps(overrides: Partial<SupportBundleDeps> = {}): SupportBundleDeps {
    return {
      paths: core.platform.paths,
      appVersion: '0.1.0-test',
      os: core.platform.os,
      locator: { detect: () => Promise.resolve(install) },
      runDoctor: () => runDoctor(deps()),
      extraSecrets: () => Promise.resolve(['sesame-ouvre-toi']),
      now: () => NOW,
      ...overrides,
    }
  }

  function writeLog(file: string, text: string, ageDays = 0): void {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
    const time = new Date(NOW.getTime() - ageDays * DAY)
    utimesSync(file, time, time)
  }

  async function entries(zip: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const entry of await listZip(zip, { maxRatio: Number.MAX_SAFE_INTEGER })) {
      if (!entry.isDir) out[entry.name] = (await readZipText(zip, entry.name, 64 * 1024 * 1024)) ?? ''
    }
    return out
  }

  it('support bundle contains no password or session uuid', async () => {
    const { dataRoot, downloads } = core.platform.paths
    writeLog(
      join(dataRoot, 'logs', 'archipelagoat.log'),
      [
        '2026-10-17T08:00:00.000Z INFO webhost: GET https://archipelago.gg/session/' + UUID,
        '2026-10-17T08:00:01.000Z INFO server ready, password sesame-ouvre-toi',
        '2026-10-17T08:00:02.000Z INFO cookie session=eyJhbGciOi.abc',
      ].join('\n'),
    )
    writeLog(
      join(install.paths.logs, 'Server_2026_10_17.txt'),
      'Hosting game at 1.2.3.4:38281 (Password: hunter2)\n' +
        "A client connection was refused due to: {'cmd': 'Connect', 'password': 'hunter2'}\n",
      1,
    )
    writeLog(join(install.paths.logs, 'Generate_old.txt'), 'OLD LOG', 8)
    writeLog(
      join(dataRoot, 'sessions', 's1', 'logs', 'server.log'),
      'Set option password to sesame-ouvre-toi\n',
      2,
    )

    const zip = await createSupportBundle(bundleDeps())
    expect(zip).toBe(join(downloads, 'archipelagoat-support-20261017-101500.zip'))
    const files = await entries(zip)
    expect(Object.keys(files).sort()).toEqual([
      'ap-logs/Server_2026_10_17.txt',
      'app-logs/archipelagoat.log',
      'doctor.json',
      'session-logs/s1/server.log',
    ])
    for (const [name, text] of Object.entries(files)) {
      for (const secret of ['hunter2', 'sesame-ouvre-toi', UUID, 'eyJhbGciOi'])
        expect(text, `${name} leaks ${secret}`).not.toContain(secret)
    }
    expect(files['ap-logs/Server_2026_10_17.txt']).toContain(`(Password: ${MASK})`)
    const doctor = JSON.parse(files['doctor.json'] ?? '') as { appVersion: string; checks: DoctorCheck[] }
    expect(doctor.appVersion).toBe('0.1.0-test')
    expect(doctor.checks.map((check) => check.id)).toEqual([...DOCTOR_CHECK_IDS])
  })

  it('keeps the newest Archipelago logs of the last 7 days within 20 MB', async () => {
    const big = (): string => randomBytes(6 * 1024 * 1024).toString('base64') // 8 MiB of text
    writeLog(join(install.paths.logs, 'newest.txt'), big(), 0)
    writeLog(join(install.paths.logs, 'middle.txt'), big(), 1)
    writeLog(join(install.paths.logs, 'oldest.txt'), big(), 2)
    writeLog(join(install.paths.logs, 'small.txt'), 'small', 3)

    const files = await entries(await createSupportBundle(bundleDeps()))
    expect(
      Object.keys(files)
        .filter((name) => name.startsWith('ap-logs/'))
        .sort(),
    ).toEqual(['ap-logs/middle.txt', 'ap-logs/newest.txt', 'ap-logs/small.txt'])
  })

  it('works without Archipelago, logs or known secrets', async () => {
    const zip = await createSupportBundle(
      bundleDeps({
        locator: { detect: () => Promise.resolve(null) },
        extraSecrets: undefined,
        now: undefined,
      }),
    )
    expect(zip).toMatch(/archipelagoat-support-\d{8}-\d{6}\.zip$/)
    expect(Object.keys(await entries(zip))).toEqual(['doctor.json'])
  })
})
