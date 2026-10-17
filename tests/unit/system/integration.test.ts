import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFn, ExecResult } from '@main/core/exec'
import {
  LINUX_MIME_TYPES,
  desktopEntry,
  installLinuxIntegration,
  linuxDataHome,
  mimeXml,
  removeLinuxIntegration,
} from '@main/core/system/integration-linux'
import { WIN_PATCH_PROG_ID, setWinAssociations, winOpenCommand } from '@main/core/system/integration-win'
import { createIntegration } from '@main/services/integration.service'
import type { ApInstall, ApInstallKind } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'

const OK: ExecResult = { code: 0, stdout: '', stderr: '' }

interface Call {
  cmd: string
  args: string[]
}

/** Records every command and answers it with `answer` (success by default). */
function recordingExec(answer: (call: Call) => ExecResult | Error = () => OK): ExecFn & { calls: Call[] } {
  const calls: Call[] = []
  const fn: ExecFn = (cmd, args) => {
    calls.push({ cmd, args })
    const result = answer({ cmd, args })
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
  return Object.assign(fn, { calls })
}

/**
 * A fake HKCU: `reg add` and `reg delete` change it, and the PowerShell reads of readRegistryValues
 * are answered from it (`null` for a missing key, else its values as JSON).
 */
function fakeRegistry(): ExecFn & { keys: Map<string, Map<string, string>>; regCalls: string[][] } {
  const keys = new Map<string, Map<string, string>>()
  const regCalls: string[][] = []
  const valuesOf = (key: string): Map<string, string> => {
    const values = keys.get(key) ?? new Map<string, string>()
    keys.set(key, values)
    return values
  }
  const fn: ExecFn = (cmd, args) => {
    if (cmd === 'reg') {
      regCalls.push(args)
      const [verb = '', key = '', ...rest] = args
      const after = (flag: string): string => rest[rest.indexOf(flag) + 1] ?? ''
      if (verb === 'add') {
        if (rest.includes('/ve')) valuesOf(key).set('', after('/d'))
        else valuesOf(key).set(after('/v'), rest.includes('/d') ? after('/d') : '')
      } else if (verb === 'delete') {
        if (rest.includes('/ve')) keys.get(key)?.delete('')
        else
          for (const name of [...keys.keys()])
            if (name === key || name.startsWith(`${key}\\`)) keys.delete(name)
      }
      return Promise.resolve(OK)
    }
    if (cmd === 'powershell.exe') {
      const script = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le')
      const subKey = (/OpenSubKey\('((?:[^']|'')*)'\)/.exec(script)?.[1] ?? '').replaceAll("''", "'")
      const full = `HKCU\\${subKey}`
      const exists = [...keys.keys()].some((name) => name === full || name.startsWith(`${full}\\`))
      const stdout = exists ? JSON.stringify(Object.fromEntries(keys.get(full) ?? [])) : 'null'
      return Promise.resolve({ code: 0, stdout, stderr: '' })
    }
    return Promise.reject(new Error(`unexpected command ${cmd}`))
  }
  return Object.assign(fn, { keys, regCalls })
}

function apInstall(kind: ApInstallKind, root: string): ApInstall {
  const paths = {
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
  }
  return { kind, version: '0.6.8', root, appImagePath: null, paths }
}

let dir: string
let dataHome: string
let core: TestCore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goat integration é-'))
  dataHome = join(dir, 'xdg-data')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const desktopFile = (): string => join(dataHome, 'applications', 'archipelagoat.desktop')
const mimeFile = (): string => join(dataHome, 'mime', 'packages', 'archipelagoat.xml')

describe('linux desktop entry', () => {
  it('desktopEntry contains Exec with %u and archipelago scheme handler', () => {
    const entry = desktopEntry({ execPath: '/opt/ArchipelaGOAT/archipelagoat', iconPath: '/i/goat.png' })
    const lines = entry.split('\n')
    expect(lines[0]).toBe('[Desktop Entry]')
    expect(lines).toEqual(
      expect.arrayContaining([
        'Type=Application',
        'Name=ArchipelaGOAT',
        'Exec="/opt/ArchipelaGOAT/archipelagoat" %u',
        'Icon=/i/goat.png',
        'Terminal=false',
        'Categories=Game;',
        'MimeType=x-scheme-handler/archipelago;application/x-apworld;application/x-archipelago-patch;',
      ]),
    )
    expect(entry.endsWith('\n')).toBe(true)
  })

  it('quotes Exec as the desktop entry spec asks, with the dev entry point when there is one', () => {
    const entry = desktopEntry({
      execPath: '/home/joueur/Jeux $1/"goat"\\app',
      args: ['/src/out/main/index.js'],
      iconPath: 'archipelagoat',
    })
    // Inside quotes `"`, `$` and `\` are escaped, then every backslash is doubled once more.
    expect(entry).toContain(
      'Exec="/home/joueur/Jeux \\\\$1/\\\\"goat\\\\"\\\\\\\\app" "/src/out/main/index.js" %u',
    )
    expect(desktopEntry({ execPath: '/opt/100%/goat', iconPath: 'x' })).toContain('Exec="/opt/100%%/goat" %u')
    expect(() => desktopEntry({ execPath: '/opt/a\nb', iconPath: 'x' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })

  it('mimeXml declares the apworld and patch types over zip', () => {
    const xml = mimeXml()
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/)
    expect(xml).toContain('<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">')
    expect(xml).toContain('<mime-type type="application/x-apworld">')
    expect(xml).toContain('<glob pattern="*.apworld"/>')
    expect(xml).toContain('<mime-type type="application/x-archipelago-patch">')
    for (const suffix of ['apz5', 'apsml2', 'aplttp', 'apemerald'])
      expect(xml).toContain(`<glob pattern="*.${suffix}"/>`)
    expect(xml).toContain('<sub-class-of type="application/zip"/>')
    expect(xml).toContain('<comment xml:lang="fr">')
    expect(LINUX_MIME_TYPES).toEqual([
      'x-scheme-handler/archipelago',
      'application/x-apworld',
      'application/x-archipelago-patch',
    ])
  })

  it('linuxDataHome follows XDG_DATA_HOME when it is absolute', () => {
    expect(linuxDataHome({ XDG_DATA_HOME: dataHome }, '/home/u')).toBe(dataHome)
    expect(linuxDataHome({ XDG_DATA_HOME: 'relative' }, dir)).toBe(join(dir, '.local', 'share'))
    expect(linuxDataHome({}, dir)).toBe(join(dir, '.local', 'share'))
  })

  it('install and remove write the files, run the desktop tools and report the ones that failed', async () => {
    const exec = recordingExec(({ cmd }) =>
      cmd === 'xdg-mime' ? Object.assign(new Error('spawn xdg-mime ENOENT'), { code: 'ENOENT' }) : OK,
    )
    const installed = await installLinuxIntegration(exec, {
      dataHome,
      execPath: '/opt/goat',
      iconSource: join(dir, 'no-icon.png'),
    })
    expect(installed).toEqual({ failed: ['xdg-mime'] })
    expect(readFileSync(desktopFile(), 'utf8')).toContain('Icon=archipelagoat')
    expect(readFileSync(mimeFile(), 'utf8')).toBe(mimeXml())
    expect(exec.calls).toEqual([
      { cmd: 'update-mime-database', args: [join(dataHome, 'mime')] },
      { cmd: 'update-desktop-database', args: [join(dataHome, 'applications')] },
      { cmd: 'xdg-mime', args: ['default', 'archipelagoat.desktop', ...LINUX_MIME_TYPES] },
    ])

    exec.calls.length = 0
    const failing = recordingExec(() => ({ code: 1, stdout: '', stderr: 'boom' }))
    expect(await removeLinuxIntegration(failing, { dataHome })).toEqual({
      failed: ['update-mime-database', 'update-desktop-database'],
    })
    expect(existsSync(desktopFile())).toBe(false)
    expect(existsSync(mimeFile())).toBe(false)
  })
})

describe('integration service (linux)', () => {
  let exec: ReturnType<typeof recordingExec>

  beforeEach(() => {
    core = createTestContext(dir, { os: 'linux' })
    exec = recordingExec()
    core.ctx.exec = exec
  })

  it('desktop entry uses APPIMAGE path when set', async () => {
    const appDir = join(dir, 'mount')
    mkdirSync(appDir)
    writeFileSync(join(appDir, '.DirIcon'), 'png')
    const integration = createIntegration(core.ctx, {
      env: {
        APPIMAGE: '/home/joueur/Applications/ArchipelaGOAT-0.1.0.AppImage',
        APPDIR: appDir,
        XDG_DATA_HOME: dataHome,
      },
      execPath: '/tmp/.mount_ArchipXyz/archipelagoat',
    })

    expect(await integration.set({ linuxDesktop: true })).toEqual({
      linuxDesktop: true,
      winProtocol: false,
      winAssociations: false,
      available: { linuxDesktop: true, winProtocol: false, winAssociations: false },
    })
    const entry = readFileSync(desktopFile(), 'utf8')
    expect(entry).toContain('Exec="/home/joueur/Applications/ArchipelaGOAT-0.1.0.AppImage" %u')
    expect(entry).not.toContain('.mount_')
    // The icon of the AppImage is copied out of its temporary mount.
    const icon = join(dataHome, 'icons', 'hicolor', '512x512', 'apps', 'archipelagoat.png')
    expect(entry).toContain(`Icon=${icon}`)
    expect(readFileSync(icon, 'utf8')).toBe('png')
    expect(core.ctx.config.get().integration.linuxDesktop).toBe(true)

    expect((await integration.set({ linuxDesktop: false })).linuxDesktop).toBe(false)
    expect(existsSync(desktopFile())).toBe(false)
    expect(existsSync(icon)).toBe(false)
    expect(core.ctx.config.get().integration.linuxDesktop).toBe(false)
  })

  it('without an AppImage the entry runs the executable itself', async () => {
    const integration = createIntegration(core.ctx, {
      env: { XDG_DATA_HOME: dataHome },
      execPath: '/opt/ArchipelaGOAT/archipelagoat',
    })
    await integration.set({ linuxDesktop: true })
    expect(readFileSync(desktopFile(), 'utf8')).toContain('Exec="/opt/ArchipelaGOAT/archipelagoat" %u')
  })

  it('integration enables linux desktop on first ap:installed when the flag is on', async () => {
    const integration = createIntegration(core.ctx, {
      env: { XDG_DATA_HOME: dataHome },
      execPath: '/opt/ArchipelaGOAT/archipelagoat',
    })
    // On by default under Linux, but nothing is installed before Archipelago is.
    expect(core.ctx.config.get().integration.linuxDesktop).toBe(true)
    expect((await integration.state()).linuxDesktop).toBe(false)

    // A folder the user picked is not an install the app made.
    core.ctx.bus.emit('ap:installed', apInstall('custom', join(dir, 'ap')))
    expect((await integration.state()).linuxDesktop).toBe(false)
    expect(exec.calls).toEqual([])

    core.ctx.bus.emit('ap:installed', apInstall('linux-managed', join(dir, 'ap')))
    expect((await integration.state()).linuxDesktop).toBe(true)
    expect(readFileSync(desktopFile(), 'utf8')).toContain('Exec="/opt/ArchipelaGOAT/archipelagoat" %u')
    const calls = exec.calls.length
    expect(calls).toBeGreaterThan(0)

    // The next update installs Archipelago again: the entry is already there.
    core.ctx.bus.emit('ap:installed', apInstall('linux-managed', join(dir, 'ap')))
    await integration.state()
    expect(exec.calls).toHaveLength(calls)
  })

  it('stays off on ap:installed once the user turned the flag off', async () => {
    const integration = createIntegration(core.ctx, {
      env: { XDG_DATA_HOME: dataHome },
      execPath: '/opt/goat',
    })
    await integration.set({ linuxDesktop: true })
    await integration.set({ linuxDesktop: false })
    exec.calls.length = 0

    core.ctx.bus.emit('ap:installed', apInstall('linux-managed', join(dir, 'ap')))
    expect((await integration.state()).linuxDesktop).toBe(false)
    expect(existsSync(desktopFile())).toBe(false)
    expect(exec.calls).toEqual([])
  })

  it('refuses the windows integrations', async () => {
    const integration = createIntegration(core.ctx, {
      env: { XDG_DATA_HOME: dataHome },
      execPath: '/opt/goat',
    })
    await expect(integration.set({ winProtocol: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PLATFORM',
      params: { feature: 'winProtocol' },
    })
    await expect(integration.set({ linuxDesktop: true, winAssociations: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PLATFORM',
    })
    // Nothing was applied: the request is checked as a whole first.
    expect(existsSync(desktopFile())).toBe(false)
  })
})

describe('windows integration', () => {
  const EXE = 'C:\\Users\\Joueur\\AppData\\Local\\Programs\\ArchipelaGOAT\\ArchipelaGOAT.exe'
  const CLASSES = 'HKCU\\Software\\Classes'

  it('winOpenCommand quotes each part and ends with %1', () => {
    expect(winOpenCommand({ exe: EXE, args: [] })).toBe(`"${EXE}" "%1"`)
    expect(winOpenCommand({ exe: 'C:\\e\\electron.exe', args: ['D:\\app\\out\\main\\index.js'] })).toBe(
      '"C:\\e\\electron.exe" "D:\\app\\out\\main\\index.js" "%1"',
    )
  })

  it('setWinAssociations writes the HKCU ProgID for .apsml2 and removes only its own keys', async () => {
    const registry = fakeRegistry()
    // Another program listed itself for .apsml2: that stays.
    registry.keys.set(`${CLASSES}\\.apsml2\\OpenWithProgids`, new Map([['Other.Patch', '']]))

    await setWinAssociations(registry, true, { exe: EXE, args: [] })
    expect(registry.keys.get(`${CLASSES}\\${WIN_PATCH_PROG_ID}\\shell\\open\\command`)?.get('')).toBe(
      `"${EXE}" "%1"`,
    )
    expect(registry.keys.get(`${CLASSES}\\${WIN_PATCH_PROG_ID}\\DefaultIcon`)?.get('')).toBe(`"${EXE}",0`)
    expect(registry.keys.get(`${CLASSES}\\.apsml2`)?.get('')).toBe(WIN_PATCH_PROG_ID)
    expect(registry.regCalls.every((args) => args.at(-1) === '/f')).toBe(true)

    await setWinAssociations(registry, false, { exe: EXE, args: [] })
    expect([...registry.keys.keys()].filter((key) => key.includes(WIN_PATCH_PROG_ID))).toEqual([])
    expect(registry.keys.get(`${CLASSES}\\.apsml2`)?.has('')).toBe(false)
    expect(registry.keys.get(`${CLASSES}\\.apsml2\\OpenWithProgids`)?.get('Other.Patch')).toBe('')

    // Turning off what is not there deletes nothing.
    registry.regCalls.length = 0
    await setWinAssociations(registry, false, { exe: EXE, args: [] })
    expect(registry.regCalls).toEqual([])
  })

  it('leaves .apsml2 alone when the user gave it to another program', async () => {
    const registry = fakeRegistry()
    await setWinAssociations(registry, true, { exe: EXE, args: [] })
    registry.keys.get(`${CLASSES}\\.apsml2`)?.set('', 'Other.Patch')
    await setWinAssociations(registry, false, { exe: EXE, args: [] })
    expect(registry.keys.get(`${CLASSES}\\.apsml2`)?.get('')).toBe('Other.Patch')
  })

  it('a reg failure is an INSTALL_FAILED', async () => {
    const exec = recordingExec(() => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }))
    await expect(setWinAssociations(exec, true, { exe: EXE, args: [] })).rejects.toMatchObject({
      code: 'INSTALL_FAILED',
      params: { reason: 'integration' },
    })
  })

  it('the service drives setProtocolClient and the associations, and keeps the config in step', async () => {
    const setProtocolClient = vi.fn<(on: boolean) => boolean>(() => true)
    core = createTestContext(dir, { os: 'win32', setProtocolClient })
    const registry = fakeRegistry()
    core.ctx.exec = registry
    const integration = createIntegration(core.ctx, {
      env: {},
      execPath: 'C:\\e\\electron.exe',
      entryPoint: 'D:\\app\\out\\main\\index.js',
    })

    expect(await integration.state()).toEqual({
      linuxDesktop: false,
      winProtocol: false,
      winAssociations: false,
      available: { linuxDesktop: false, winProtocol: true, winAssociations: true },
    })
    expect(await integration.set({ winProtocol: true, winAssociations: true })).toMatchObject({
      winProtocol: true,
      winAssociations: true,
    })
    expect(setProtocolClient).toHaveBeenCalledWith(true)
    // In development the command repeats the entry point Electron runs.
    expect(registry.keys.get(`${CLASSES}\\${WIN_PATCH_PROG_ID}\\shell\\open\\command`)?.get('')).toBe(
      '"C:\\e\\electron.exe" "D:\\app\\out\\main\\index.js" "%1"',
    )
    expect(core.ctx.config.get().integration).toEqual({
      linuxDesktop: false,
      winProtocol: true,
      winAssociations: true,
    })

    // The OS refused: the switch stays where it was.
    setProtocolClient.mockReturnValue(false)
    await expect(integration.set({ winProtocol: false })).rejects.toMatchObject({ code: 'INSTALL_FAILED' })
    expect(core.ctx.config.get().integration.winProtocol).toBe(true)

    await expect(integration.set({ linuxDesktop: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PLATFORM',
    })
    // ap:installed never touches Windows.
    core.ctx.bus.emit('ap:installed', apInstall('windows-installer', 'C:\\ProgramData\\Archipelago'))
    expect((await integration.state()).linuxDesktop).toBe(false)
  })
})
