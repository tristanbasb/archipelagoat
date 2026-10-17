import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import {
  createLocator,
  fakeApFromEnv,
  nodeLocatorFs,
  readManifestVersion,
  resolveApPaths,
  resolveSettingsFile,
  type LocatorFs,
} from '@main/core/ap/locator'
import type { PlatformPaths } from '@main/core/context'
import { exec as realExec, type ExecFn } from '@main/core/exec'
import { registerHandlers } from '@main/ipc'
import { createIpcRegistry } from '@main/ipc/registry'
import { createServices } from '@main/services'
import { AP_UNINSTALL_KEY, apExeFileName } from '@shared/data/ap-constants'
import type { ApInstall, OS } from '@shared/types'
import { createTestContext, hostOs, type TestCore } from '../../helpers/core'

const PROTOCOL_KEY = 'HKLM\\SOFTWARE\\Classes\\archipelago\\shell\\open\\command'

const WIN: Omit<PlatformPaths, 'userData'> = {
  home: 'C:\\Users\\Jérôme',
  dataRoot: 'C:\\Users\\Jérôme\\AppData\\Local\\ArchipelaGOAT',
  temp: 'C:\\Users\\Jérôme\\AppData\\Local\\Temp',
  downloads: 'C:\\Users\\Jérôme\\Downloads',
  exe: 'C:\\Program Files\\ArchipelaGOAT\\ArchipelaGOAT.exe',
}

const LINUX: Omit<PlatformPaths, 'userData'> = {
  home: '/home/jerome',
  dataRoot: '/home/jerome/.local/share/ArchipelaGOAT',
  temp: '/tmp',
  downloads: '/home/jerome/Téléchargements',
  exe: '/opt/ArchipelaGOAT/archipelagoat',
}

const MANIFEST_068 = '{"buildtime":"2026-10-04 12:00:00+00:00","hashes":{},"version":[0,6,8]}'

interface MemTree {
  files?: Record<string, string>
  writable?: string[]
}

/** An in-memory file system: its folders are the parents of its files. */
function memFs(os: OS, tree: MemTree): LocatorFs & { probed: string[] } {
  const lib = os === 'win32' ? path.win32 : path.posix
  const files = new Map(Object.entries(tree.files ?? {}))
  const dirs = new Set<string>()
  for (const file of files.keys()) {
    for (let dir = lib.dirname(file); dir !== lib.dirname(dir); dir = lib.dirname(dir)) dirs.add(dir)
  }
  const probed: string[] = []
  return {
    exists: (p) => files.has(p) || dirs.has(p),
    readText: (p) => Promise.resolve(files.get(p) ?? null),
    list: (dir) =>
      Promise.resolve(
        [...new Set([...files.keys(), ...dirs])]
          .filter((p) => lib.dirname(p) === dir)
          .map((p) => lib.basename(p)),
      ),
    isWritableDir: (dir) => {
      probed.push(dir)
      return Promise.resolve((tree.writable ?? []).includes(dir))
    },
    probed,
  }
}

/** A fake powershell.exe answering registry reads from `keys` (full key path → values). */
function registryExec(keys: Record<string, Record<string, string>>): ExecFn & { scripts: string[] } {
  const scripts: string[] = []
  const fn: ExecFn = (_cmd, _args, opts) => {
    const script = opts?.input ?? ''
    scripts.push(script)
    const subKey = /OpenSubKey\('((?:[^']|'')*)'\)/.exec(script)?.[1]?.replaceAll("''", "'")
    const hit = Object.entries(keys).find(([key]) => key.replace(/^HKLM\\/, '') === subKey)
    return Promise.resolve({ code: 0, stdout: hit ? JSON.stringify(hit[1]) : 'null', stderr: '' })
  }
  return Object.assign(fn, { scripts })
}

const noRegistry = (): ExecFn & { scripts: string[] } => registryExec({})

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-locator-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A test context for `os`, whose platform folders are the fake ones above. */
function coreFor(os: OS, exec: ExecFn = noRegistry(), override: string | null = null): TestCore {
  const core = createTestContext(dir, {
    os,
    paths: { ...(os === 'win32' ? WIN : LINUX), userData: join(dir, 'userData') },
  })
  core.ctx.exec = exec
  if (override) core.ctx.config.updateInternal({ apPathOverride: override })
  return core
}

const winLauncher = (root: string): Record<string, string> => ({
  [`${root}\\ArchipelagoLauncher.exe`]: 'MZ',
})
const linuxLauncher = (root: string): Record<string, string> => ({ [`${root}/ArchipelagoLauncher`]: 'ELF' })

describe('readManifestVersion', () => {
  it('reads the version tuple of manifest.json', () => {
    expect(readManifestVersion(JSON.parse(MANIFEST_068))).toBe('0.6.8')
    expect(readManifestVersion({ version: [0, 6, 10] })).toBe('0.6.10')
  })

  it('returns null for anything else', () => {
    for (const json of [
      null,
      'x',
      [0, 6, 8],
      {},
      { version: '0.6.8' },
      { version: [] },
      { version: [0, -1, 2] },
    ]) {
      expect(readManifestVersion(json), JSON.stringify(json)).toBeNull()
    }
    expect(readManifestVersion({ version: [0, 6.5, 8] })).toBeNull()
  })
})

describe('resolveApPaths', () => {
  it('windows: userPath = localPath, customWorlds = custom_worlds', () => {
    const root = 'C:\\ProgramData\\Archipelago'
    const paths = resolveApPaths(
      {
        localPath: root,
        os: 'win32',
        home: WIN.home,
        // Ignored on Windows: Archipelago has no other user folder there.
        localWritable: false,
        cwd: root,
        localAppData: 'C:\\Users\\Jérôme\\AppData\\Local',
      },
      () => false,
    )
    expect(paths).toEqual({
      localPath: root,
      userPath: root,
      customWorlds: `${root}\\custom_worlds`,
      coreWorlds: `${root}\\lib\\worlds`,
      players: `${root}\\Players`,
      templates: `${root}\\Players\\Templates`,
      output: `${root}\\output`,
      logs: `${root}\\logs`,
      cache: 'C:\\Users\\Jérôme\\AppData\\Local\\Archipelago\\Cache',
      settingsFile: `${root}\\host.yaml`,
    })
  })

  it('windows: the cache defaults to AppData\\Local under home', () => {
    const paths = resolveApPaths(
      { localPath: 'D:\\AP', os: 'win32', home: WIN.home, localWritable: true, cwd: 'D:\\AP' },
      () => false,
    )
    expect(paths.cache).toBe('C:\\Users\\Jérôme\\AppData\\Local\\Archipelago\\Cache')
  })

  it('linux tar.gz writable: data inside install', () => {
    const root = '/home/jerome/.local/share/ArchipelaGOAT/archipelago/Archipelago'
    const paths = resolveApPaths(
      { localPath: root, os: 'linux', home: LINUX.home, localWritable: true, cwd: root },
      () => false,
    )
    expect(paths).toEqual({
      localPath: root,
      userPath: root,
      customWorlds: `${root}/custom_worlds`,
      coreWorlds: `${root}/lib/worlds`,
      players: `${root}/Players`,
      templates: `${root}/Players/Templates`,
      output: `${root}/output`,
      logs: `${root}/logs`,
      cache: '/home/jerome/.cache/Archipelago',
      settingsFile: `${root}/host.yaml`,
    })
  })

  it('linux appimage read-only: userPath ~/.local/share/Archipelago, customWorlds worlds/', () => {
    const home = '/home/jerome/.local/share/Archipelago'
    const paths = resolveApPaths(
      { localPath: '', os: 'linux', home: LINUX.home, localWritable: false, cwd: home },
      () => false,
    )
    expect(paths).toEqual({
      localPath: '',
      userPath: home,
      customWorlds: `${home}/worlds`,
      // Inside the mount, which is not readable.
      coreWorlds: '',
      players: `${home}/Players`,
      templates: `${home}/Players/Templates`,
      output: `${home}/output`,
      logs: `${home}/logs`,
      cache: '/home/jerome/.cache/Archipelago',
      settingsFile: `${home}/host.yaml`,
    })
  })

  it('linux read-only folder: user data in $XDG_DATA_HOME/Archipelago, cache in $XDG_CACHE_HOME', () => {
    const paths = resolveApPaths(
      {
        localPath: '/opt/Archipelago',
        os: 'linux',
        home: LINUX.home,
        xdgDataHome: '/data/xdg',
        xdgCacheHome: '/cache/xdg',
        localWritable: false,
        cwd: '/opt/Archipelago',
      },
      () => false,
    )
    expect(paths).toMatchObject({
      localPath: '/opt/Archipelago',
      userPath: '/data/xdg/Archipelago',
      customWorlds: '/data/xdg/Archipelago/worlds',
      coreWorlds: '/opt/Archipelago/lib/worlds',
      cache: '/cache/xdg/Archipelago',
      settingsFile: '/data/xdg/Archipelago/host.yaml',
    })
  })

  it('linux: a relative XDG_DATA_HOME is ignored', () => {
    const paths = resolveApPaths(
      {
        localPath: '/opt/Archipelago',
        os: 'linux',
        home: LINUX.home,
        xdgDataHome: 'relative',
        xdgCacheHome: '',
        localWritable: false,
        cwd: '/opt/Archipelago',
      },
      () => false,
    )
    expect(paths.userPath).toBe('/home/jerome/.local/share/Archipelago')
    expect(paths.cache).toBe('/home/jerome/.cache/Archipelago')
  })

  it('picks the settings file AP loads', () => {
    const root = '/opt/Archipelago'
    const user = '/home/jerome/.local/share/Archipelago'
    const paths = resolveApPaths(
      { localPath: root, os: 'linux', home: LINUX.home, localWritable: false, cwd: root },
      (p) => p === `${user}/options.yaml`,
    )
    expect(paths.settingsFile).toBe(`${user}/options.yaml`)
  })
})

describe('resolveSettingsFile', () => {
  const local = '/opt/Archipelago'
  const user = '/home/jerome/.local/share/Archipelago'
  const cwd = '/home/jerome/sessions/s1'
  const all = [`${cwd}/options.yaml`, `${cwd}/host.yaml`, `${user}/options.yaml`, `${user}/host.yaml`]
  const existing =
    (...files: string[]) =>
    (p: string): boolean =>
      files.includes(p)

  it('settings resolution order: cwd options.yaml > cwd host.yaml > user options.yaml > user host.yaml', () => {
    expect(resolveSettingsFile(local, user, cwd, existing(...all))).toBe(`${cwd}/options.yaml`)
    expect(resolveSettingsFile(local, user, cwd, existing(...all.slice(1)))).toBe(`${cwd}/host.yaml`)
    expect(resolveSettingsFile(local, user, cwd, existing(...all.slice(2)))).toBe(`${user}/options.yaml`)
    expect(resolveSettingsFile(local, user, cwd, existing(...all.slice(3)))).toBe(`${user}/host.yaml`)
  })

  it('falls back to the user host.yaml AP would create', () => {
    expect(resolveSettingsFile(local, user, cwd, () => false)).toBe(`${user}/host.yaml`)
  })

  it('ignores the cwd files when the cwd is the install folder', () => {
    const files = existing(`${local}/options.yaml`, `${user}/host.yaml`)
    expect(resolveSettingsFile(local, user, local, files)).toBe(`${user}/host.yaml`)
    expect(resolveSettingsFile(local, user, `${local}/`, files)).toBe(`${user}/host.yaml`)
  })

  it('windows paths: compares the cwd without case or trailing separator', () => {
    const root = 'C:\\ProgramData\\Archipelago'
    const cwd = 'c:\\programdata\\archipelago\\'
    // Only what the cwd would find: it must not be looked at.
    const files = existing('c:\\programdata\\archipelago\\options.yaml')
    expect(resolveSettingsFile(root, root, cwd, files)).toBe(`${root}\\host.yaml`)
    expect(resolveSettingsFile(root, root, 'D:\\Sessions\\s1', existing('D:\\Sessions\\s1\\host.yaml'))).toBe(
      'D:\\Sessions\\s1\\host.yaml',
    )
    expect(resolveSettingsFile(root, root, root, () => false)).toBe(`${root}\\host.yaml`)
    const share = '\\\\nas\\jeux\\Archipelago'
    expect(resolveSettingsFile(share, share, share, () => false)).toBe(`${share}\\host.yaml`)
  })
})

describe('locator on Windows', () => {
  const programData = 'C:\\ProgramData\\Archipelago'
  const custom = 'D:\\AP perso'
  const installed = 'D:\\Jeux\\Archipélago'

  const uninstallKey = (
    location: string,
    displayName = 'Archipelago 0.6.8',
  ): Record<string, Record<string, string>> => ({
    [AP_UNINSTALL_KEY]: { InstallLocation: `${location}\\`, DisplayName: displayName },
  })

  it('windows order: the chosen folder comes first, before any registry read', async () => {
    const exec = registryExec(uninstallKey(installed))
    const fs = memFs('win32', {
      files: { ...winLauncher(custom), ...winLauncher(installed), ...winLauncher(programData) },
    })
    const install = await createLocator(coreFor('win32', exec, custom).ctx, { fs, env: {} }).detect()
    expect(install).toMatchObject({ kind: 'custom', root: custom, appImagePath: null, version: null })
    expect(exec.scripts).toHaveLength(0)
  })

  it('windows order: then the uninstall key, read in the 64-bit view', async () => {
    const exec = registryExec(uninstallKey(installed))
    const fs = memFs('win32', {
      files: {
        ...winLauncher(installed),
        [`${installed}\\manifest.json`]: MANIFEST_068,
        ...winLauncher(programData),
      },
    })
    const install = await createLocator(coreFor('win32', exec).ctx, { fs, env: {} }).detect()
    expect(install).toEqual<ApInstall>({
      kind: 'windows-installer',
      version: '0.6.8',
      root: installed,
      appImagePath: null,
      paths: {
        localPath: installed,
        userPath: installed,
        customWorlds: `${installed}\\custom_worlds`,
        coreWorlds: `${installed}\\lib\\worlds`,
        players: `${installed}\\Players`,
        templates: `${installed}\\Players\\Templates`,
        output: `${installed}\\output`,
        logs: `${installed}\\logs`,
        cache: 'C:\\Users\\Jérôme\\AppData\\Local\\Archipelago\\Cache',
        settingsFile: `${installed}\\host.yaml`,
      },
    })
    expect(exec.scripts[0]).toContain('[Microsoft.Win32.RegistryView]::Registry64')
    // Nothing is written in Archipelago's folder to learn whether it is writable.
    expect(fs.probed).toEqual([])
  })

  it('windows: without a readable manifest.json, the version comes from DisplayName', async () => {
    const exec = registryExec(uninstallKey(installed, 'Archipelago 0.6.9'))
    const fs = memFs('win32', { files: winLauncher(installed) })
    const install = await createLocator(coreFor('win32', exec).ctx, { fs, env: {} }).detect()
    expect(install?.version).toBe('0.6.9')

    const corrupt = memFs('win32', {
      files: { ...winLauncher(installed), [`${installed}\\manifest.json`]: '{"vers' },
    })
    const again = await createLocator(coreFor('win32', exec).ctx, { fs: corrupt, env: {} }).detect()
    expect(again?.version).toBe('0.6.9')
  })

  it('windows order: then the archipelago:// command', async () => {
    const exec = registryExec({ [PROTOCOL_KEY]: { '': '"E:\\Archipelago\\ArchipelagoLauncher.exe" "%1"' } })
    const fs = memFs('win32', { files: { ...winLauncher('E:\\Archipelago'), ...winLauncher(programData) } })
    const install = await createLocator(coreFor('win32', exec).ctx, { fs, env: {} }).detect()
    expect(install).toMatchObject({ kind: 'windows-installer', root: 'E:\\Archipelago' })
  })

  it('windows: an unquoted archipelago:// command is read too', async () => {
    const exec = registryExec({ [PROTOCOL_KEY]: { '': 'E:\\AP\\ArchipelagoLauncher.exe %1' } })
    const fs = memFs('win32', { files: winLauncher('E:\\AP') })
    expect((await createLocator(coreFor('win32', exec).ctx, { fs, env: {} }).detect())?.root).toBe('E:\\AP')
  })

  it('windows: an archipelago:// command that points to ArchipelaGOAT is ignored', async () => {
    const own = 'C:\\Program Files\\ArchipelaGOAT'
    for (const command of [`"${WIN.exe}" "%1"`, '"D:\\Apps\\ArchipelaGOAT\\ArchipelaGOAT.exe" "%1"']) {
      const exec = registryExec({ [PROTOCOL_KEY]: { '': command } })
      // Even with a launcher beside it, which only the rule can rule out.
      const fs = memFs('win32', {
        files: {
          ...winLauncher(own),
          ...winLauncher('D:\\Apps\\ArchipelaGOAT'),
          ...winLauncher(programData),
        },
      })
      const install = await createLocator(coreFor('win32', exec).ctx, { fs, env: {} }).detect()
      expect(install?.root, command).toBe(programData)
    }
  })

  it('windows order: finally the default ProgramData folder', async () => {
    const fs = memFs('win32', { files: winLauncher(programData) })
    const install = await createLocator(coreFor('win32').ctx, { fs, env: {} }).detect()
    expect(install).toMatchObject({ kind: 'windows-installer', root: programData, version: null })
  })

  it('windows: ProgramData follows the environment', async () => {
    const fs = memFs('win32', { files: winLauncher('E:\\PD\\Archipelago') })
    const install = await createLocator(coreFor('win32').ctx, { fs, env: { ProgramData: 'E:\\PD' } }).detect()
    expect(install?.root).toBe('E:\\PD\\Archipelago')
  })

  it('windows: registry entries that lead to no launcher are skipped', async () => {
    const exec = registryExec({
      ...uninstallKey('D:\\Gone'),
      [PROTOCOL_KEY]: { '': '"D:\\Gone\\ArchipelagoLauncher.exe" "%1"' },
    })
    const fs = memFs('win32', { files: winLauncher(programData) })
    expect((await createLocator(coreFor('win32', exec).ctx, { fs, env: {} }).detect())?.root).toBe(
      programData,
    )
  })

  it('windows: a failing registry read is skipped', async () => {
    const failing: ExecFn = () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom' })
    const fs = memFs('win32', { files: winLauncher(programData) })
    expect((await createLocator(coreFor('win32', failing).ctx, { fs, env: {} }).detect())?.root).toBe(
      programData,
    )
    const throwing: ExecFn = () => Promise.reject(new Error('spawn powershell.exe ENOENT'))
    expect((await createLocator(coreFor('win32', throwing).ctx, { fs, env: {} }).detect())?.root).toBe(
      programData,
    )
  })

  it('windows: a chosen folder that is no longer an install falls back to detection', async () => {
    const fs = memFs('win32', { files: winLauncher(programData) })
    const install = await createLocator(coreFor('win32', noRegistry(), 'D:\\Moved').ctx, {
      fs,
      env: {},
    }).detect()
    expect(install?.root).toBe(programData)
  })

  it('exe(install, name) runs <root>\\<name>.exe', async () => {
    const fs = memFs('win32', { files: winLauncher(programData) })
    const locator = createLocator(coreFor('win32').ctx, { fs, env: {} })
    const install = await locator.fromRoot(`${programData}\\`)
    expect(install.root).toBe(programData)
    expect(locator.exe(install, 'ArchipelagoGenerate')).toEqual({
      command: `${programData}\\ArchipelagoGenerate.exe`,
      argsPrefix: [],
    })
  })
})

describe('locator on Linux', () => {
  const managed = '/home/jerome/.local/share/ArchipelaGOAT/archipelago/Archipelago'
  const custom = '/home/jerome/Jeux/Archipelago'
  const image = (dir: string, name: string): Record<string, string> => ({ [`${dir}/${name}`]: 'AppImage' })
  const appImage068 = image('/home/jerome/Applications', 'Archipelago_0.6.8_linux-x86_64.AppImage')

  it('linux order: the chosen folder comes first', async () => {
    const fs = memFs('linux', {
      files: { ...linuxLauncher(custom), ...linuxLauncher(managed), ...appImage068 },
      writable: [custom],
    })
    const install = await createLocator(coreFor('linux', noRegistry(), custom).ctx, { fs, env: {} }).detect()
    expect(install).toMatchObject({ kind: 'custom', root: custom, paths: { userPath: custom } })
  })

  it('linux order: then the install the app manages', async () => {
    const fs = memFs('linux', {
      files: { ...linuxLauncher(managed), [`${managed}/manifest.json`]: MANIFEST_068, ...appImage068 },
      writable: [managed],
    })
    const install = await createLocator(coreFor('linux').ctx, { fs, env: {} }).detect()
    expect(install).toMatchObject({
      kind: 'linux-managed',
      version: '0.6.8',
      root: managed,
      paths: { userPath: managed, customWorlds: `${managed}/custom_worlds` },
    })
    expect(fs.probed).toEqual([managed])
  })

  it('linux order: finally the newest AppImage, by the version in its name', async () => {
    const fs = memFs('linux', {
      files: {
        ...image('/home/jerome/Applications', 'Archipelago_0.6.7_linux-x86_64.AppImage'),
        ...image('/home/jerome/Downloads', 'Archipelago_0.6.10_linux-x86_64.AppImage'),
        ...image('/home/jerome/.local/bin', 'Archipelago_0.6.8_linux-x86_64.AppImage'),
        ...image('/home/jerome/Downloads', 'Archipelago.AppImage'),
        // Our own AppImage, and files that are not AppImages.
        ...image('/home/jerome/Téléchargements', 'ArchipelaGOAT-0.9.0.AppImage'),
        ...image('/home/jerome/Downloads', 'Archipelago_0.6.11_linux-x86_64.tar.gz'),
      },
    })
    const install = await createLocator(coreFor('linux').ctx, { fs, env: {} }).detect()
    const appImagePath = '/home/jerome/Downloads/Archipelago_0.6.10_linux-x86_64.AppImage'
    expect(install).toEqual<ApInstall>({
      kind: 'linux-appimage',
      version: '0.6.10',
      root: '/home/jerome/Downloads',
      appImagePath,
      paths: {
        localPath: '',
        userPath: '/home/jerome/.local/share/Archipelago',
        customWorlds: '/home/jerome/.local/share/Archipelago/worlds',
        coreWorlds: '',
        players: '/home/jerome/.local/share/Archipelago/Players',
        templates: '/home/jerome/.local/share/Archipelago/Players/Templates',
        output: '/home/jerome/.local/share/Archipelago/output',
        logs: '/home/jerome/.local/share/Archipelago/logs',
        cache: '/home/jerome/.cache/Archipelago',
        settingsFile: '/home/jerome/.local/share/Archipelago/host.yaml',
      },
    })
  })

  it('linux: between AppImages of the same version, the first folder searched wins', async () => {
    const fs = memFs('linux', {
      files: {
        ...image('/home/jerome/.local/bin', 'Archipelago_0.6.8_linux-x86_64.AppImage'),
        ...image('/home/jerome/Applications', 'Archipelago_0.6.8_linux-x86_64 (1).AppImage'),
      },
    })
    const install = await createLocator(coreFor('linux').ctx, { fs, env: {} }).detect()
    expect(install?.appImagePath).toBe(
      '/home/jerome/Applications/Archipelago_0.6.8_linux-x86_64 (1).AppImage',
    )
  })

  it('linux: an AppImage in the localized downloads folder is found', async () => {
    const fs = memFs('linux', {
      files: image('/home/jerome/Téléchargements', 'Archipelago_0.6.8_linux-x86_64.AppImage'),
    })
    const install = await createLocator(coreFor('linux').ctx, { fs, env: {} }).detect()
    expect(install?.appImagePath).toBe('/home/jerome/Téléchargements/Archipelago_0.6.8_linux-x86_64.AppImage')
  })

  it('appimage version comes from file name and ~/.local/share/Archipelago/manifest.json', async () => {
    const manifest = { '/home/jerome/.local/share/Archipelago/manifest.json': MANIFEST_068 }
    const renamed = memFs('linux', {
      files: { ...image('/home/jerome/Applications', 'Archipelago.AppImage'), ...manifest },
    })
    expect((await createLocator(coreFor('linux').ctx, { fs: renamed, env: {} }).detect())?.version).toBe(
      '0.6.8',
    )

    const named = memFs('linux', {
      files: {
        ...image('/home/jerome/Applications', 'Archipelago_0.6.9_linux-x86_64.AppImage'),
        ...manifest,
      },
    })
    expect((await createLocator(coreFor('linux').ctx, { fs: named, env: {} }).detect())?.version).toBe(
      '0.6.9',
    )

    const bare = memFs('linux', { files: image('/home/jerome/Applications', 'Archipelago.AppImage') })
    expect((await createLocator(coreFor('linux').ctx, { fs: bare, env: {} }).detect())?.version).toBeNull()
  })

  it('appimage: user data follows XDG_DATA_HOME', async () => {
    const fs = memFs('linux', {
      files: {
        ...image('/home/jerome/Applications', 'Archipelago.AppImage'),
        '/data/xdg/Archipelago/manifest.json': '{"version":[0,6,7]}',
      },
    })
    const install = await createLocator(coreFor('linux').ctx, {
      fs,
      env: { XDG_DATA_HOME: '/data/xdg' },
    }).detect()
    expect(install).toMatchObject({ version: '0.6.7', paths: { userPath: '/data/xdg/Archipelago' } })
  })

  it('appimage exe uses --executable=Name prefix', async () => {
    const fs = memFs('linux', { files: appImage068 })
    const locator = createLocator(coreFor('linux').ctx, { fs, env: {} })
    const install = await locator.detect()
    if (!install) throw new Error('no install')
    expect(locator.exe(install, 'ArchipelagoServer')).toEqual({
      command: '/home/jerome/Applications/Archipelago_0.6.8_linux-x86_64.AppImage',
      argsPrefix: ['--executable=ArchipelagoServer'],
    })
  })

  it('exe(install, name) runs <root>/<name> for a folder install', async () => {
    const fs = memFs('linux', { files: linuxLauncher(managed), writable: [managed] })
    const locator = createLocator(coreFor('linux').ctx, { fs, env: {} })
    const install = await locator.fromRoot(managed, 'linux-managed')
    expect(locator.exe(install, 'ArchipelagoTextClient')).toEqual({
      command: `${managed}/ArchipelagoTextClient`,
      argsPrefix: [],
    })
  })
})

describe('locator', () => {
  const programData = 'C:\\ProgramData\\Archipelago'
  const managed = '/home/jerome/.local/share/ArchipelaGOAT/archipelago/Archipelago'

  it('detect returns null when nothing found and uses override when set', async () => {
    expect(await createLocator(coreFor('win32').ctx, { fs: memFs('win32', {}), env: {} }).detect()).toBeNull()
    expect(await createLocator(coreFor('linux').ctx, { fs: memFs('linux', {}), env: {} }).detect()).toBeNull()

    const fs = memFs('linux', { files: linuxLauncher('/srv/AP'), writable: ['/srv/AP'] })
    const install = await createLocator(coreFor('linux', noRegistry(), '/srv/AP').ctx, {
      fs,
      env: {},
    }).detect()
    expect(install).toMatchObject({ kind: 'custom', root: '/srv/AP' })
  })

  it('a folder that cannot be read is skipped and logged', async () => {
    const core = coreFor('linux', noRegistry(), '/srv/AP')
    const warn = vi.fn()
    core.ctx.log = { ...core.ctx.log, warn }
    const fs = memFs('linux', { files: { ...linuxLauncher('/srv/AP'), ...linuxLauncher(managed) } })
    const broken: LocatorFs = {
      ...fs,
      readText: (p) => (p.startsWith('/srv/AP/') ? Promise.reject(new Error('EACCES')) : fs.readText(p)),
    }
    const install = await createLocator(core.ctx, { fs: broken, env: {} }).detect()
    expect(install?.root).toBe(managed)
    expect(warn).toHaveBeenCalledWith('locator: cannot read /srv/AP', expect.any(Error))
  })

  it('detect is cached until invalidate()', async () => {
    const exec = registryExec({})
    const fs = memFs('win32', { files: winLauncher(programData) })
    const locator = createLocator(coreFor('win32', exec).ctx, { fs, env: {} })
    const first = await locator.detect()
    expect(await locator.detect()).toBe(first)
    expect(exec.scripts).toHaveLength(2) // uninstall key + archipelago:// command, once
    locator.invalidate()
    expect(await locator.detect()).toEqual(first)
    expect(exec.scripts).toHaveLength(4)
  })

  it('looks again in the background once its answer is old, and announces an install made outside the app', async () => {
    const withAp = memFs('win32', { files: winLauncher(programData) })
    const empty = memFs('win32', {})
    let current: LocatorFs = empty
    const fs: LocatorFs = {
      exists: (p) => current.exists(p),
      readText: (p) => current.readText(p),
      list: (d) => current.list(d),
      isWritableDir: (d) => current.isWritableDir(d),
    }
    let clock = 0
    const core = coreFor('win32')
    const announced: (ApInstall | null)[] = []
    core.ctx.bus.on('ap:installed', (install) => void announced.push(install))
    const locator = createLocator(core.ctx, { fs, env: {}, now: () => clock })
    expect(await locator.detect()).toBeNull()

    // Installed with the official Setup while the app is open.
    current = withAp
    clock = 4_000
    expect(await locator.detect()).toBeNull()
    // Nothing found 5 s ago: still answered at once, and looked for again.
    clock = 5_000
    expect(await locator.detect()).toBeNull()
    await vi.waitFor(() => expect(announced).toHaveLength(1))
    expect(announced[0]?.root).toBe(programData)
    expect((await locator.detect())?.root).toBe(programData)

    // Uninstalled outside the app: an install found is trusted for 30 s.
    current = empty
    clock = 34_000
    expect((await locator.detect())?.root).toBe(programData)
    clock = 35_000
    expect((await locator.detect())?.root).toBe(programData)
    await vi.waitFor(() => expect(announced).toHaveLength(2))
    expect(announced[1]).toBeNull()
    expect(await locator.detect()).toBeNull()

    // The same answer again is not announced.
    clock = 41_000
    await locator.detect()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(announced).toHaveLength(2)
  })

  it('a failed detection is not cached', async () => {
    let fail = true
    const fs = memFs('linux', {})
    const flaky: LocatorFs = {
      ...fs,
      list: (d) => (fail ? Promise.reject(new Error('EIO')) : fs.list(d)),
    }
    const locator = createLocator(coreFor('linux').ctx, { fs: flaky, env: {} })
    await expect(locator.detect()).rejects.toThrow('EIO')
    fail = false
    expect(await locator.detect()).toBeNull()
  })

  it('fromRoot throws AP_NOT_INSTALLED without ArchipelagoLauncher', async () => {
    const fs = memFs('win32', { files: { 'D:\\AP\\ArchipelagoLauncher.mjs': '' } })
    const locator = createLocator(coreFor('win32').ctx, { fs, env: {} })
    await expect(locator.fromRoot('D:\\Empty')).rejects.toMatchObject({
      code: 'AP_NOT_INSTALLED',
      detail: 'D:\\Empty',
    })
    // A .mjs launcher only counts with fake executables.
    await expect(locator.fromRoot('D:\\AP')).rejects.toMatchObject({ code: 'AP_NOT_INSTALLED' })
    const fake = createLocator(coreFor('win32').ctx, { fs, env: {}, exeOverride: () => null })
    expect(await fake.fromRoot('D:\\AP')).toMatchObject({ kind: 'custom', root: 'D:\\AP' })
  })

  it('nodeLocatorFs.isWritableDir checks access like os.access(W_OK) and writes nothing', async () => {
    const ap = join(dir, 'AP')
    mkdirSync(ap)
    const old = new Date('2001-01-01T00:00:00Z')
    utimesSync(ap, old, old)
    expect(await nodeLocatorFs.isWritableDir(ap)).toBe(true)
    // Creating and deleting a probe file would leave nothing behind but would bump the folder's mtime.
    expect(statSync(ap).mtimeMs).toBe(old.getTime())
    expect(readdirSync(ap)).toEqual([])
    expect(await nodeLocatorFs.isWritableDir(join(dir, 'missing'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'nodeLocatorFs.isWritableDir is false for a read-only folder',
    async () => {
      const ap = join(dir, 'AP')
      mkdirSync(ap)
      chmodSync(ap, 0o555)
      try {
        expect(await nodeLocatorFs.isWritableDir(ap)).toBe(false)
      } finally {
        chmodSync(ap, 0o755)
      }
    },
  )

  it('exeOverride replaces the executable, and null falls back to the real one', async () => {
    const fs = memFs('win32', { files: winLauncher(programData) })
    const exeOverride = (name: string) =>
      name === 'ArchipelagoServer' ? { command: 'node', argsPrefix: ['fake-server.mjs'] } : null
    const locator = createLocator(coreFor('win32').ctx, { fs, env: {}, exeOverride })
    const install = await locator.fromRoot(programData, 'windows-installer')
    expect(locator.exe(install, 'ArchipelagoServer')).toEqual({
      command: 'node',
      argsPrefix: ['fake-server.mjs'],
    })
    expect(locator.exe(install, 'ArchipelagoGenerate').command).toBe(
      `${programData}\\ArchipelagoGenerate.exe`,
    )
  })
})

describe('GOAT_FAKE_AP_DIR', () => {
  let source: string

  beforeEach(() => {
    source = join(dir, 'fake ap source')
    mkdirSync(join(source, 'custom_worlds'), { recursive: true })
    writeFileSync(join(source, 'ArchipelagoLauncher.mjs'), '')
    writeFileSync(
      join(source, 'ArchipelagoGenerate.mjs'),
      "process.stdout.write('fake generate ' + JSON.stringify(process.argv.slice(2)))\n",
    )
    writeFileSync(join(source, 'manifest.json'), MANIFEST_068)
  })

  it('GOAT_FAKE_AP_DIR yields a custom install with .mjs launchers and ELECTRON_RUN_AS_NODE env', async () => {
    const core = createTestContext(dir)
    const exec = vi.fn<ExecFn>(() => Promise.reject(new Error('the registry must not be read')))
    core.ctx.exec = exec
    core.ctx.config.updateInternal({ apPathOverride: join(dir, 'elsewhere') })

    const opts = fakeApFromEnv(core.ctx, { GOAT_FAKE_AP_DIR: source }, {})
    if (!opts) throw new Error('GOAT_FAKE_AP_DIR ignored')
    const locator = createLocator(core.ctx, opts)
    const install = await locator.detect()
    if (!install) throw new Error('no install')

    // A copy in the temporary folder, so that tests never change the source tree.
    expect(install).toMatchObject({ kind: 'custom', version: '0.6.8', appImagePath: null })
    expect(install.root).not.toBe(source)
    expect(install.root.startsWith(core.platform.paths.temp)).toBe(true)
    expect(existsSync(join(install.root, 'ArchipelagoLauncher.mjs'))).toBe(true)
    expect(install.paths.customWorlds).toBe(join(install.root, 'custom_worlds'))
    expect(exec).not.toHaveBeenCalled()

    const generate = locator.exe(install, 'ArchipelagoGenerate')
    expect(generate).toEqual({
      command: process.execPath,
      argsPrefix: [join(install.root, 'ArchipelagoGenerate.mjs')],
      env: {},
    })
    const run = await realExec(generate.command, [...generate.argsPrefix, '--seed', '1'], {
      env: { ...process.env, ...generate.env },
    })
    expect(run.stdout).toBe('fake generate ["--seed","1"]')

    // Under Electron, process.execPath is the app itself: it must run as Node.
    const electron = fakeApFromEnv(core.ctx, { GOAT_FAKE_AP_DIR: source }, { electron: '44.8.0' })
    expect(electron?.exeOverride?.('ArchipelagoServer')?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('removes the copy when the app quits', async () => {
    const core = createTestContext(dir)
    const opts = fakeApFromEnv(core.ctx, { GOAT_FAKE_AP_DIR: source }, {})
    const root = opts?.fakeRoot ?? ''
    expect(existsSync(join(root, 'manifest.json'))).toBe(true)
    await core.lifecycle.runBeforeQuit()
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(source, 'manifest.json'))).toBe(true)
  })

  it('GOAT_FAKE_AP_DIR=none turns the system detection off, a folder picked by hand excepted', async () => {
    const PROGRAMDATA = 'C:\\ProgramData\\Archipelago'
    // A machine with Archipelago installed: registry key and ProgramData.
    const exec = registryExec({ [AP_UNINSTALL_KEY]: { InstallLocation: PROGRAMDATA } })
    const core = coreFor('win32', exec)
    const fs = memFs('win32', { files: winLauncher(PROGRAMDATA) })
    const opts = fakeApFromEnv(core.ctx, { GOAT_FAKE_AP_DIR: 'none' }, {})
    expect(opts).toEqual({ noDetection: true })
    const locator = createLocator(core.ctx, { ...opts, fs, env: {} })
    expect(await locator.detect()).toBeNull()
    expect(exec.scripts).toEqual([])

    // The user's own choice still counts (the app's own screens set it).
    core.ctx.config.updateInternal({ apPathOverride: PROGRAMDATA })
    locator.invalidate()
    expect((await locator.detect())?.root).toBe(PROGRAMDATA)
    // Never outside the test environment.
    expect(
      fakeApFromEnv(createTestContext(dir, { isPackaged: true }).ctx, { GOAT_FAKE_AP_DIR: 'none' }, {}),
    ).toBeNull()
  })

  it('is honoured only in the test environment', () => {
    const packaged = createTestContext(dir, { isPackaged: true })
    expect(fakeApFromEnv(packaged.ctx, { GOAT_FAKE_AP_DIR: source }, {})).toBeNull()
    expect(fakeApFromEnv(packaged.ctx, { GOAT_FAKE_AP_DIR: source, GOAT_E2E: '1' }, {})).not.toBeNull()
    expect(fakeApFromEnv(createTestContext(dir).ctx, {}, {})).toBeNull()
  })
})

describe('ap handlers', () => {
  let core: TestCore
  let call: (name: string, input?: unknown) => Promise<unknown>
  let ap: string

  beforeEach(() => {
    core = createTestContext(dir)
    // Neither the real registry nor a real Archipelago install may be seen.
    core.ctx.exec = noRegistry()
    vi.stubEnv('ProgramData', join(dir, 'ProgramData'))
    vi.stubEnv('XDG_DATA_HOME', join(dir, 'xdg'))
    const ipc = createIpcRegistry()
    registerHandlers(createServices(core.ctx), ipc.registerHandler)
    call = (name, input) => ipc.dispatch(name, input, { senderId: 1 })
    ap = join(dir, 'Jeux', 'Archipélago')
    mkdirSync(ap, { recursive: true })
  })

  const addLauncher = (): void =>
    writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), 'launcher')

  it('ap:detect answers null when Archipelago is nowhere', async () => {
    expect(await call('ap:detect')).toEqual({ ok: true, value: null })
  })

  it('ap:setCustomPath validates the folder, saves it and makes detect use it', async () => {
    addLauncher()
    const result = (await call('ap:setCustomPath', { path: ap })) as { ok: boolean; value: ApInstall }
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ kind: 'custom', root: ap })
    expect(core.ctx.config.get().apPathOverride).toBe(ap)
    expect(await call('ap:detect')).toEqual(result)

    // The install folder becomes openable.
    expect(await call('app:openPath', { path: ap })).toEqual({ ok: true, value: undefined })

    expect(await call('ap:setCustomPath', { path: null })).toEqual({ ok: true, value: null })
    expect(core.ctx.config.get().apPathOverride).toBeNull()
  })

  it('the locator service is eager: the install folder is openable from startup', async () => {
    addLauncher()
    core.ctx.config.updateInternal({ apPathOverride: ap })
    // What src/main/index.ts does at startup, before any handler asks for the locator.
    const services = createServices(core.ctx)
    services.startEager()
    const ipc = createIpcRegistry()
    registerHandlers(services, ipc.registerHandler)
    expect(await ipc.dispatch('app:openPath', { path: ap }, { senderId: 1 })).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it('ap:setCustomPath refuses a folder without Archipelago, a file and a missing path', async () => {
    expect(await call('ap:setCustomPath', { path: ap })).toMatchObject({
      error: { code: 'AP_NOT_INSTALLED' },
    })
    const file = join(dir, 'notes.txt')
    writeFileSync(file, 'x')
    expect(await call('ap:setCustomPath', { path: file })).toMatchObject({
      error: { code: 'PATH_FORBIDDEN' },
    })
    expect(await call('ap:setCustomPath', { path: join(dir, 'missing') })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
    expect(core.ctx.config.get().apPathOverride).toBeNull()
  })
})
