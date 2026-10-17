import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { resolveApPaths, type Locator } from '@main/core/ap/locator'
import { createApSettings, SETTINGS_KEYS, type ApSettings } from '@main/core/ap/settings'
import type { ExecFn } from '@main/core/exec'
import { createServices } from '@main/services'
// The `settings` entry of Services (the service file is loaded by import.meta.glob at run time).
import type {} from '@main/services/settings.service'
import { apExeFileName } from '@shared/data/ap-constants'
import { ROM_TABLE } from '@shared/data/rom-table'
import type { AppError } from '@shared/errors'
import type { ApInstall } from '@shared/types'
import { createTestContext, hostOs, type TestCore } from '../../helpers/core'

/** An excerpt of the host.yaml Archipelago 0.6.8 writes (settings.py dumps strings double-quoted). */
const HOST_YAML = [
  'general_options:',
  '  # Where to place output files',
  '  output_path: "output"',
  '# Options for MultiServer',
  '# Null means nothing, for the server this means to default the value',
  '# These overwrite command line arguments!',
  'server_options:',
  '  host: null',
  '  port: 38281',
  '  password: null',
  '  disable_item_cheat: false',
  '# Options for Generation',
  'generator:',
  '  # Folder from which the player yaml files are pulled from',
  '  player_files_path: "Players"',
  '  spoiler: 3',
  '  race: 0',
  '  plando_options: "bosses, connections, texts"',
  'bizhawkclient_options:',
  '  # The location of the EmuHawk you want to auto launch patched ROMs with',
  '  emuhawk_path: null',
  '  # Set this to true to autostart a patched ROM in BizHawk with the connector script,',
  '  rom_start: true',
  'lttp_options:',
  '  # File name of the v1.0 J rom',
  '  rom_file: "Zelda no Densetsu - Kamigami no Triforce (Japan).sfc"',
  '',
].join('\n')

let dir: string
let core: TestCore
/** The install folder, where Archipelago keeps its data (Windows, or a writable Linux folder). */
let ap: string
let hostYaml: string
let backups: string

/**
 * tasklist / ps listing these Archipelago programs, plus this app, which never counts. Anything else
 * is refused: the tests never look at the real machine.
 */
function apProcesses(names: string[]): ExecFn {
  return (command) => {
    if (command === 'tasklist') {
      const rows = names.map((name, i) => `"${name}.exe","${100 + i}","Console","1","10 000 K"`)
      rows.push('"ArchipelaGOAT.exe","5000","Console","1","120 000 K"')
      return Promise.resolve({ code: 0, stdout: rows.join('\r\n'), stderr: '' })
    }
    if (command === 'ps') {
      // Linux cuts `comm` to 15 characters.
      const rows = names.map((name, i) => ` ${100 + i} ${name.slice(0, 15)}`)
      rows.push(' 5000 archipelagoat')
      return Promise.resolve({ code: 0, stdout: rows.join('\n'), stderr: '' })
    }
    return Promise.reject(new Error(`unexpected command ${command}`))
  }
}

const locatorOf = (install: ApInstall | null): Locator => ({
  detect: () => Promise.resolve(install),
  fromRoot: () => Promise.reject(new Error('not used')),
  exe: () => {
    throw new Error('not used')
  },
  invalidate: () => undefined,
})

/** An install whose data stays in its own folder. */
function folderInstall(root: string): ApInstall {
  const input = {
    localPath: root,
    os: hostOs,
    home: core.platform.paths.home,
    localWritable: true,
    cwd: root,
  }
  return {
    kind: 'custom',
    version: '0.6.8',
    root,
    appImagePath: null,
    paths: resolveApPaths(input, existsSync),
  }
}

/** An AppImage: its own folder is inside its mount (localPath ''), its data lives in `userPath`. */
function appImageInstall(userPath: string): ApInstall {
  const base = folderInstall(userPath)
  return {
    ...base,
    kind: 'linux-appimage',
    root: dir,
    appImagePath: join(dir, 'Archipelago_0.6.8_linux-x86_64.AppImage'),
    paths: { ...base.paths, localPath: '', coreWorlds: '' },
  }
}

const settingsFor = (install: ApInstall | null): ApSettings => createApSettings(core.ctx, locatorOf(install))

const yaml11 = (text: string): Record<string, Record<string, unknown>> =>
  parse(text, { version: '1.1' }) as Record<string, Record<string, unknown>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat-settings-'))
  core = createTestContext(dir)
  core.ctx.exec = apProcesses([])
  ap = join(dir, 'Jeux', 'Archipélago')
  mkdirSync(ap, { recursive: true })
  hostYaml = join(ap, 'host.yaml')
  backups = join(core.platform.paths.dataRoot, 'backups')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ap settings', () => {
  it('set preserves comments, order and unrelated keys', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    await settingsFor(folderInstall(ap)).set([
      { path: SETTINGS_KEYS.emuhawkPath, value: 'D:\\Emus\\BizHawk\\EmuHawk.exe' },
      { path: SETTINGS_KEYS.romFile('lttp_options.rom_file'), value: 'D:\\ROMs\\Zelda.sfc' },
      // A group the file does not have yet.
      { path: SETTINGS_KEYS.romFile('sml2_options.rom_file'), value: 'D:\\ROMs\\Mario Land 2.gb' },
    ])
    // A new value keeps the style of the old one (plain null, double-quoted string), and a new group
    // is a plain mapping: in YAML 1.1 `setIn` alone would write `!!omap`, a list for PyYAML.
    const expected =
      HOST_YAML.replace('  emuhawk_path: null', '  emuhawk_path: D:\\Emus\\BizHawk\\EmuHawk.exe').replace(
        '  rom_file: "Zelda no Densetsu - Kamigami no Triforce (Japan).sfc"',
        '  rom_file: "D:\\\\ROMs\\\\Zelda.sfc"',
      ) + 'sml2_options:\n  rom_file: D:\\ROMs\\Mario Land 2.gb\n'
    const text = readFileSync(hostYaml, 'utf8')
    expect(text).toBe(expected)
    expect(yaml11(text).sml2_options).toEqual({ rom_file: 'D:\\ROMs\\Mario Land 2.gb' })
  })

  it('keeps the CRLF line endings Archipelago writes on Windows, and drops a BOM as it does', async () => {
    const crlf = HOST_YAML.replaceAll('\n', '\r\n')
    writeFileSync(hostYaml, `\uFEFF${crlf}`)
    await settingsFor(folderInstall(ap)).set([{ path: SETTINGS_KEYS.romStart, value: false }])
    expect(readFileSync(hostYaml, 'utf8')).toBe(crlf.replace('  rom_start: true', '  rom_start: false'))
  })

  it('set throws SETTINGS_LOCKED when an Archipelago process runs', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    const settings = settingsFor(folderInstall(ap))
    const entries = [{ path: SETTINGS_KEYS.romStart, value: false }]
    core.ctx.exec = apProcesses(['ArchipelagoServer', 'ArchipelagoBizHawkClient', 'ArchipelagoBizHawkClient'])

    const error = await settings.set(entries).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'SETTINGS_LOCKED' })
    // Each program once, never this app; Linux names are cut to 15 characters by ps.
    expect(String((error as AppError).params?.processes).split(', ')).toEqual(
      hostOs === 'win32'
        ? ['ArchipelagoServer.exe', 'ArchipelagoBizHawkClient.exe']
        : ['ArchipelagoServ', 'ArchipelagoBizH'],
    )
    expect(readFileSync(hostYaml, 'utf8')).toBe(HOST_YAML)
    expect(existsSync(backups)).toBe(false)

    // A listing that fails does not mean that nothing runs.
    core.ctx.exec = () => Promise.resolve({ code: 1, stdout: '', stderr: 'denied' })
    await expect(settings.set(entries)).rejects.toThrow('exited with code 1')
    expect(readFileSync(hostYaml, 'utf8')).toBe(HOST_YAML)

    // Nothing to write needs no lock, and writes nothing.
    core.ctx.exec = apProcesses(['ArchipelagoServer'])
    await settings.set([])
    expect(readFileSync(hostYaml, 'utf8')).toBe(HOST_YAML)
    expect(existsSync(backups)).toBe(false)
  })

  it('set backs up the file before writing', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    const settings = settingsFor(folderInstall(ap))
    await settings.set([{ path: SETTINGS_KEYS.romStart, value: false }])
    const [first, ...others] = readdirSync(backups)
    expect(others).toEqual([])
    expect(first).toMatch(/^\d{8}-\d{6}-settings$/)
    expect(readFileSync(join(backups, first ?? '', 'host.yaml'), 'utf8')).toBe(HOST_YAML)
    const changed = HOST_YAML.replace('  rom_start: true', '  rom_start: false')
    expect(readFileSync(hostYaml, 'utf8')).toBe(changed)

    // Each write keeps the content it replaces.
    await settings.set([{ path: SETTINGS_KEYS.romStart, value: true }])
    const copies = readdirSync(backups).map((folder) =>
      readFileSync(join(backups, folder, 'host.yaml'), 'utf8'),
    )
    expect(copies.sort()).toEqual([HOST_YAML, changed].sort())
  })

  it('effective options.yaml is edited, and host.yaml is never created beside it', async () => {
    const options = join(ap, 'options.yaml')
    writeFileSync(options, '# my overrides\nbizhawkclient_options:\n  rom_start: true\n')
    const settings = settingsFor(folderInstall(ap))
    expect(await settings.file()).toBe(options)
    await settings.set([{ path: SETTINGS_KEYS.emuhawkPath, value: 'D:\\BizHawk\\EmuHawk.exe' }])
    expect(readFileSync(options, 'utf8')).toBe(
      '# my overrides\nbizhawkclient_options:\n  rom_start: true\n  emuhawk_path: D:\\BizHawk\\EmuHawk.exe\n',
    )
    expect(readdirSync(ap)).toEqual(['options.yaml'])

    // With a host.yaml beside it, options.yaml is still the one Archipelago loads.
    writeFileSync(hostYaml, HOST_YAML)
    await settings.set([{ path: SETTINGS_KEYS.romStart, value: false }])
    expect(readFileSync(options, 'utf8')).toContain('  rom_start: false\n')
    expect(readFileSync(hostYaml, 'utf8')).toBe(HOST_YAML)
  })

  it('creates host.yaml (not options.yaml) when no settings file exists', async () => {
    // An AppImage that never ran: its user folder does not exist yet.
    const userPath = join(core.platform.paths.home, '.local', 'share', 'Archipelago')
    const settings = settingsFor(appImageInstall(userPath))
    expect(await settings.get(SETTINGS_KEYS.emuhawkPath)).toBeUndefined()
    await settings.set([
      { path: SETTINGS_KEYS.emuhawkPath, value: '/opt/BizHawk/EmuHawkMono.sh' },
      { path: SETTINGS_KEYS.romStart, value: true },
    ])
    expect(readdirSync(userPath)).toEqual(['host.yaml'])
    expect(readFileSync(join(userPath, 'host.yaml'), 'utf8')).toBe(
      'bizhawkclient_options:\n  emuhawk_path: /opt/BizHawk/EmuHawkMono.sh\n  rom_start: true\n',
    )
    // There was nothing to back up.
    expect(existsSync(backups)).toBe(false)
  })

  it('makeSessionSettings copies effective file and overrides generator and server_options', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    // The session file belongs to the session: no lock, even while Archipelago runs.
    core.ctx.exec = apProcesses(['ArchipelagoLauncher'])
    const settings = settingsFor(folderInstall(ap))
    const sessionDir = join(core.platform.paths.dataRoot, 'sessions', 's_mgx0abcd1234')
    const overrides = (password: string) => [
      { path: ['generator', 'spoiler'], value: 2 },
      { path: ['generator', 'race'], value: 1 },
      { path: ['server_options', 'password'], value: password },
      { path: ['server_options', 'disable_item_cheat'], value: true },
      { path: ['server_options', 'hint_cost'], value: 5 },
    ]
    const sessionYaml = (password: string): string =>
      HOST_YAML.replace('  password: null', `  password: ${password}`)
        .replace('  disable_item_cheat: false', '  disable_item_cheat: true\n  hint_cost: 5')
        .replace('  spoiler: 3', '  spoiler: 2')
        .replace('  race: 0', '  race: 1')

    const file = await settings.makeSessionSettings(sessionDir, overrides('mot de passe'))
    expect(file).toBe(join(sessionDir, 'host.yaml'))
    expect(readFileSync(file, 'utf8')).toBe(sessionYaml('mot de passe'))
    expect(readdirSync(sessionDir)).toEqual(['host.yaml'])
    // The global settings are neither changed nor backed up.
    expect(readFileSync(hostYaml, 'utf8')).toBe(HOST_YAML)
    expect(existsSync(backups)).toBe(false)

    // Rewritten from the effective file each time (e.g. before each server start).
    await settings.makeSessionSettings(sessionDir, overrides('autre'))
    expect(readFileSync(file, 'utf8')).toBe(sessionYaml('autre'))

    // Without any settings file, the session file holds the overrides alone.
    const fresh = join(dir, 'Fresh AP')
    mkdirSync(fresh)
    const freshSession = join(dir, 'fresh session')
    await settingsFor(folderInstall(fresh)).makeSessionSettings(freshSession, overrides('x'))
    expect(readFileSync(join(freshSession, 'host.yaml'), 'utf8')).toBe(
      'generator:\n  spoiler: 2\n  race: 1\nserver_options:\n  password: x\n  disable_item_cheat: true\n  hint_cost: 5\n',
    )
    expect(readdirSync(fresh)).toEqual([])
  })

  it('writes absolute paths with spaces and accents unquoted-safe and rereads identically', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    const settings = settingsFor(folderInstall(ap))
    const values: [readonly string[], string][] = [
      [SETTINGS_KEYS.emuhawkPath, 'C:\\Users\\Jérôme Dupont\\Jeux vidéo\\BizHawk 2.11.1\\EmuHawk.exe'],
      [
        SETTINGS_KEYS.romFile('lttp_options.rom_file'),
        '/home/jérôme/Jeux vidéo/Zelda: Link #1/Kamigami (Japan).sfc',
      ],
      [SETTINGS_KEYS.romFile('sm_options.rom_file'), '\\\\NAS\\Rétro\\Super Metroid (Japan, USA) [!].sfc'],
      [SETTINGS_KEYS.romFile('ladx_options.rom_file'), "D:\\ROMs\\Link's Awakening - DX {v1.0} & co.gbc"],
      // Words that YAML 1.1 reads as booleans or null when unquoted.
      [SETTINGS_KEYS.romFile('soe_options.rom_file'), 'yes'],
      [SETTINGS_KEYS.romFile('smw_options.rom_file'), '~'],
      // Longer than a line: never folded.
      [
        SETTINGS_KEYS.romFile('oot_options.rom_file'),
        `/mnt/Bibliothèque/${'Très long dossier '.repeat(8)}/oot.z64`,
      ],
    ]
    await settings.set(values.map(([path, value]) => ({ path, value })))

    const text = readFileSync(hostYaml, 'utf8')
    // Two values replaced on their own line, five groups of two lines added.
    expect(text.split('\n')).toHaveLength(HOST_YAML.split('\n').length + 10)
    expect(text).not.toMatch(/^%YAML|!!/m)
    // What Archipelago (PyYAML, YAML 1.1) reads, and what get() answers.
    const reread = yaml11(text)
    for (const [[group = '', key = ''], value] of values) {
      expect(reread[group]?.[key]).toBe(value)
      expect(await settings.get([group, key])).toBe(value)
    }
  })

  it('file() is the effective file, looked up on each call with the install folder as cwd', async () => {
    const settings = settingsFor(folderInstall(ap))
    // None yet: the host.yaml Archipelago would create.
    expect(await settings.file()).toBe(hostYaml)
    writeFileSync(join(ap, 'options.yaml'), '{}\n')
    expect(await settings.file()).toBe(join(ap, 'options.yaml'))

    // Running in its install folder, Archipelago skips the files of that folder for user_path's.
    const userPath = join(dir, 'user')
    const readOnly = folderInstall(ap)
    expect(await settingsFor({ ...readOnly, paths: { ...readOnly.paths, userPath } }).file()).toBe(
      join(userPath, 'host.yaml'),
    )

    // An AppImage runs in its user folder.
    mkdirSync(userPath)
    writeFileSync(join(userPath, 'options.yaml'), '{}\n')
    expect(await settingsFor(appImageInstall(userPath)).file()).toBe(join(userPath, 'options.yaml'))

    // No install, no settings.
    const none = settingsFor(null)
    await expect(none.file()).rejects.toMatchObject({ code: 'AP_NOT_INSTALLED' })
    await expect(none.set([{ path: SETTINGS_KEYS.romStart, value: true }])).rejects.toMatchObject({
      code: 'AP_NOT_INSTALLED',
    })
  })

  it('get reads values and groups, and answers undefined for a missing key', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    const settings = settingsFor(folderInstall(ap))
    expect(await settings.get(SETTINGS_KEYS.romStart)).toBe(true)
    expect(await settings.get(['server_options', 'port'])).toBe(38281)
    expect(await settings.get(SETTINGS_KEYS.emuhawkPath)).toBeNull()
    expect(await settings.get(['bizhawkclient_options'])).toEqual({ emuhawk_path: null, rom_start: true })
    expect(await settings.get(SETTINGS_KEYS.romFile('sml2_options.rom_file'))).toBeUndefined()
    expect(await settings.get(['generator', 'race', 'deeper'])).toBeUndefined()
  })

  it('refuses a settings file it cannot read, and leaves it untouched', async () => {
    const broken = 'generator:\n  race: 0\n\tspoiler: 3\n'
    writeFileSync(hostYaml, broken)
    const settings = settingsFor(folderInstall(ap))
    const entries = [{ path: SETTINGS_KEYS.romStart, value: false }]
    const yamlError = { code: 'YAML_PARSE', params: { file: hostYaml, line: 3, column: 1 } }
    await expect(settings.set(entries)).rejects.toMatchObject(yamlError)
    await expect(settings.get(['generator', 'race'])).rejects.toMatchObject(yamlError)
    await expect(settings.makeSessionSettings(join(dir, 'session'), entries)).rejects.toMatchObject(yamlError)
    expect(readFileSync(hostYaml, 'utf8')).toBe(broken)
    expect(existsSync(backups)).toBe(false)
    expect(existsSync(join(dir, 'session'))).toBe(false)

    // A path names a key: an empty one would replace the whole file.
    writeFileSync(hostYaml, HOST_YAML)
    await expect(settings.set([{ path: [], value: {} }])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(readFileSync(hostYaml, 'utf8')).toBe(HOST_YAML)
  })

  it('a group that is not a mapping is replaced by one, as Archipelago does', async () => {
    writeFileSync(hostYaml, 'bizhawkclient_options:\nlttp_options: 3\n')
    await settingsFor(folderInstall(ap)).set([
      { path: SETTINGS_KEYS.emuhawkPath, value: 'D:\\EmuHawk.exe' },
      { path: SETTINGS_KEYS.romFile('lttp_options.rom_file'), value: 'D:\\z.sfc' },
    ])
    expect(readFileSync(hostYaml, 'utf8')).toBe(
      'bizhawkclient_options:\n  emuhawk_path: D:\\EmuHawk.exe\nlttp_options:\n  rom_file: D:\\z.sfc\n',
    )
  })

  it('concurrent writes are applied one after the other, and none is lost', async () => {
    writeFileSync(hostYaml, HOST_YAML)
    const settings = settingsFor(folderInstall(ap))
    await Promise.all([
      settings.set([{ path: SETTINGS_KEYS.emuhawkPath, value: 'D:\\EmuHawk.exe' }]),
      settings.set([{ path: SETTINGS_KEYS.romFile('lttp_options.rom_file'), value: 'D:\\z.sfc' }]),
      settings.set([{ path: SETTINGS_KEYS.romStart, value: false }]),
    ])
    const reread = yaml11(readFileSync(hostYaml, 'utf8'))
    expect(reread.bizhawkclient_options).toEqual({ emuhawk_path: 'D:\\EmuHawk.exe', rom_start: false })
    expect(reread.lttp_options).toEqual({ rom_file: 'D:\\z.sfc' })

    // A refused write does not hold up the next ones. (Archipelago runs during the first listing only.)
    let listings = 0
    core.ctx.exec = (command, args) =>
      apProcesses(listings++ === 0 ? ['ArchipelagoLauncher'] : [])(command, args)
    const refused = settings.set([{ path: SETTINGS_KEYS.romStart, value: true }])
    const next = settings.set([{ path: ['generator', 'race'], value: 1 }])
    await expect(refused).rejects.toMatchObject({ code: 'SETTINGS_LOCKED' })
    await next
    expect(yaml11(readFileSync(hostYaml, 'utf8')).generator?.race).toBe(1)
  })

  it('SETTINGS_KEYS name the BizHawk keys and split a ROM table key into its path', () => {
    expect(SETTINGS_KEYS.emuhawkPath).toEqual(['bizhawkclient_options', 'emuhawk_path'])
    expect(SETTINGS_KEYS.romStart).toEqual(['bizhawkclient_options', 'rom_start'])
    expect(SETTINGS_KEYS.romFile('lttp_options.rom_file')).toEqual(['lttp_options', 'rom_file'])
    expect(SETTINGS_KEYS.romFile('pokemon_rb_options.blue_rom_file')).toEqual([
      'pokemon_rb_options',
      'blue_rom_file',
    ])
    for (const entry of ROM_TABLE) expect(SETTINGS_KEYS.romFile(entry.settingsKey)).toHaveLength(2)
    for (const bad of ['rom_file', '', 'lttp_options.', '.rom_file']) {
      expect(() => SETTINGS_KEYS.romFile(bad)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
    }
  })
})

describe('settings service', () => {
  it('edits the settings of the install the locator service finds', async () => {
    writeFileSync(join(ap, apExeFileName('ArchipelagoLauncher', hostOs)), 'launcher')
    writeFileSync(hostYaml, HOST_YAML)
    core.ctx.config.updateInternal({ apPathOverride: ap })
    const settings = createServices(core.ctx).get('settings')
    expect(await settings.file()).toBe(hostYaml)
    await settings.set([{ path: SETTINGS_KEYS.romStart, value: false }])
    expect(await settings.get(SETTINGS_KEYS.romStart)).toBe(false)
  })
})
