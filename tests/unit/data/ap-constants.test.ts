import {
  AP_EXES,
  AP_INNO_APPID,
  AP_REPO,
  AP_UNINSTALL_KEY,
  apExeFileName,
  ASSET_PATTERNS,
  BIZHAWK_ASSETS,
  BIZHAWK_REPO,
  BIZHAWK_TAG,
  CORE_LOOSE_WORLDS,
  DEFAULT_PORT,
  INNO_EXIT_CODES,
  IONIUM_REPO,
  WEBHOST_DEFAULT,
  WIKI_API,
} from '@shared/data/ap-constants'
import { coreWorldsFor } from '@shared/data/core-worlds'

describe('repositories and urls', () => {
  it('names the repositories and endpoints of the brief', () => {
    expect(AP_REPO).toBe('ArchipelagoMW/Archipelago')
    expect(IONIUM_REPO).toBe('ionium-ap/Archipelago-index')
    expect(WIKI_API).toBe('https://archipelago.miraheze.org/w/api.php')
    expect(WEBHOST_DEFAULT).toBe('https://archipelago.gg')
    expect(DEFAULT_PORT).toBe(38281)
  })
})

describe('Inno Setup installer', () => {
  it('has the AppId and the uninstall key built from it (64-bit view path, _is1 suffix)', () => {
    expect(AP_INNO_APPID).toBe('{918BA46A-FAB8-460C-9DFF-AE691E1C865B}')
    expect(AP_UNINSTALL_KEY).toBe(
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{918BA46A-FAB8-460C-9DFF-AE691E1C865B}_is1',
    )
  })

  it('maps exit codes 0 to 8 and nothing else', () => {
    expect(Object.keys(INNO_EXIT_CODES).map(Number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(INNO_EXIT_CODES[0]).toBe('Success')
    expect(INNO_EXIT_CODES[1]).toBe('Initialization failed')
    expect(INNO_EXIT_CODES[7]).toMatch(/cannot proceed/)
    expect(INNO_EXIT_CODES[8]).toMatch(/restart/)
  })
})

describe('release asset patterns', () => {
  const names = {
    windows: 'Setup.Archipelago.0.6.8.exe',
    linuxTarGz: 'Archipelago_0.6.8_linux-x86_64.tar.gz',
    appImage: 'Archipelago_0.6.8_linux-x86_64.AppImage',
  }

  it('match their own asset and capture the version', () => {
    expect(ASSET_PATTERNS.windows.exec(names.windows)?.[1]).toBe('0.6.8')
    expect(ASSET_PATTERNS.linuxTarGz.exec(names.linuxTarGz)?.[1]).toBe('0.6.8')
    expect(ASSET_PATTERNS.appImage.exec(names.appImage)?.[1]).toBe('0.6.8')
  })

  it('never match another asset of the release', () => {
    const others = [
      'archipelago-0.6.7-arm64-v8a-debug.apk',
      'source.zip',
      'Setup.Archipelago.0.6.8.exe.sha256',
    ]
    for (const pattern of Object.values(ASSET_PATTERNS)) {
      for (const other of others) expect(pattern.test(other)).toBe(false)
    }
    expect(ASSET_PATTERNS.windows.test(names.appImage)).toBe(false)
    expect(ASSET_PATTERNS.appImage.test(names.linuxTarGz)).toBe(false)
    expect(ASSET_PATTERNS.linuxTarGz.test(names.appImage)).toBe(false)
  })

  it('still match the RC file names, which is why the release is chosen by tag and not by name', () => {
    expect(ASSET_PATTERNS.windows.exec('Setup.Archipelago.0.6.8-RC1.exe')?.[1]).toBe('0.6.8-RC1')
  })
})

describe('executables', () => {
  it('lists the frozen executables without extension (brief 1.5)', () => {
    expect(Object.values(AP_EXES).sort()).toEqual(
      [
        'ArchipelagoAHITClient',
        'ArchipelagoAdventureClient',
        'ArchipelagoBizHawkClient',
        'ArchipelagoChecksFinderClient',
        'ArchipelagoGenerate',
        'ArchipelagoLauncher',
        'ArchipelagoLauncherDebug',
        'ArchipelagoLttPAdjuster',
        'ArchipelagoMMBN3Client',
        'ArchipelagoOoTAdjuster',
        'ArchipelagoOoTClient',
        'ArchipelagoOptionsCreator',
        'ArchipelagoSNIClient',
        'ArchipelagoServer',
        'ArchipelagoTextClient',
        'ArchipelagoUndertaleClient',
        'ArchipelagoZelda1Client',
        'ArchipelagoZillionClient',
      ].sort(),
    )
    for (const name of Object.values(AP_EXES)) expect(name).not.toMatch(/\./)
  })

  it('adds .exe on Windows only', () => {
    expect(apExeFileName(AP_EXES.server, 'win32')).toBe('ArchipelagoServer.exe')
    expect(apExeFileName(AP_EXES.launcher, 'win32')).toBe('ArchipelagoLauncher.exe')
    expect(apExeFileName(AP_EXES.server, 'linux')).toBe('ArchipelagoServer')
  })
})

describe('BizHawk', () => {
  it('pins 2.11.1 with its two official assets', () => {
    expect(BIZHAWK_REPO).toBe('TASEmulators/BizHawk')
    expect(BIZHAWK_TAG).toBe('2.11.1')
    expect(BIZHAWK_ASSETS).toEqual({
      win32: 'BizHawk-2.11.1-win-x64.zip',
      linux: 'BizHawk-2.11.1-linux-x64.tar.gz',
    })
  })
})

describe('CORE_LOOSE_WORLDS', () => {
  it('is the loose worlds of the 0.6.8 table, never a separate list', () => {
    const table = coreWorldsFor('0.6.8')
    expect(table).not.toBeNull()
    expect(CORE_LOOSE_WORLDS).toEqual((table ?? []).filter((world) => world.loose))
  })

  it('holds the 11 games of setup.py non_apworlds', () => {
    expect(CORE_LOOSE_WORLDS.map((world) => world.game).sort()).toEqual([
      'A Link to the Past',
      'Adventure',
      'Archipelago',
      'Lufia II Ancient Cave',
      'Meritous',
      'Ocarina of Time',
      'Overcooked! 2',
      'Raft',
      'Super Mario 64',
      'VVVVVV',
      'Wargroove',
    ])
  })
})
