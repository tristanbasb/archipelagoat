import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildElevatedScript,
  buildInnoArgs,
  interpretInstallResult,
  runElevated,
  uninstallWindows,
} from '@main/core/ap/installer-win'
import type { ExecFn, ExecOptions, ExecResult } from '@main/core/exec'
import { AppError } from '@shared/errors'
import type { ApInstall, ApPaths } from '@shared/types'
import { createTestContext, type TestCore } from '../../helpers/core'
import { makeApworld } from '../../helpers/make-apworld'

/** The script `runPowerShell` hands to powershell.exe on its stdin, the prelude it adds included. */
const scriptOf = (opts: ExecOptions | undefined): string => opts?.input ?? ''

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('expected the promise to reject')
}

describe('buildInnoArgs', () => {
  it('buildInnoArgs passes tasks explicitly', () =>
    expect(buildInnoArgs({ desktopIcons: true, customDir: null, logPath: 'C:\\l.txt' })).toEqual([
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SP-',
      '/CLOSEAPPLICATIONS',
      '/TASKS="desktopicon,deletelib"',
      '/LOG="C:\\l.txt"',
    ]))

  it('buildInnoArgs deselects desktop icons and adds DIR', () =>
    expect(
      buildInnoArgs({ desktopIcons: false, customDir: 'D:\\Jeux\\Archipelago', logPath: 'C:\\l.txt' }),
    ).toEqual([
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SP-',
      '/CLOSEAPPLICATIONS',
      '/TASKS="!desktopicon,deletelib"',
      '/DIR="D:\\Jeux\\Archipelago"',
      '/LOG="C:\\l.txt"',
    ]))
})

describe('buildElevatedScript', () => {
  it("elevated script quotes ' ‘ ’ and keeps spaces and accents", async () => {
    const exe = "C:\\Users\\O'Neil Jérôme\\Setup.exe"
    const args = ['/VERYSILENT', '/LOG="C:\\Users\\O‘Neil’ Jérôme\\l.txt"']
    const script = buildElevatedScript(exe, args)
    expect(script).toBe(
      [
        '$psi = New-Object Diagnostics.ProcessStartInfo',
        "$psi.FileName = 'C:\\Users\\O''Neil Jérôme\\Setup.exe'; " +
          '$psi.Arguments = \'/VERYSILENT /LOG="C:\\Users\\O‘‘Neil’’ Jérôme\\l.txt"\'; ' +
          "$psi.Verb = 'runas'; $psi.UseShellExecute = $true",
        'try { $p = [Diagnostics.Process]::Start($psi); $p.WaitForExit(); exit $p.ExitCode }',
        'catch [ComponentModel.Win32Exception] { exit $_.Exception.NativeErrorCode }',
      ].join('\n'),
    )

    // Through runPowerShell: stdin carries the accents and the spaces unchanged.
    const calls: { cmd: string; opts?: ExecOptions }[] = []
    const exec: ExecFn = (cmd, _args, opts) => {
      calls.push({ cmd, opts })
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    }
    expect(await runElevated(exec, exe, args)).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toBe('powershell.exe')
    expect(scriptOf(calls[0]?.opts).endsWith(`\n${script}`)).toBe(true)
  })
})

describe('interpretInstallResult', () => {
  it('maps exit 1223 to INSTALL_ELEVATION_DENIED and 4 to INSTALL_FAILED with reason', () => {
    expect(interpretInstallResult(0)).toBeNull()
    expect(interpretInstallResult(1223)).toEqual({ code: 'INSTALL_ELEVATION_DENIED' })
    expect(interpretInstallResult(4)).toEqual({
      code: 'INSTALL_FAILED',
      params: { exitCode: 4, reason: 'Fatal error during install' },
    })
    expect(interpretInstallResult(1)).toEqual({
      code: 'INSTALL_FAILED',
      params: { exitCode: 1, reason: 'Initialization failed' },
    })
    expect(interpretInstallResult(8)).toEqual({
      code: 'INSTALL_FAILED',
      params: { exitCode: 8, reason: 'Preparing to Install says it cannot proceed, and a restart is needed' },
    })
    // Any other code: only the number, whatever language Windows speaks.
    expect(interpretInstallResult(9)).toEqual({ code: 'INSTALL_FAILED', params: { exitCode: 9 } })
    expect(interpretInstallResult(-1)).toEqual({ code: 'INSTALL_FAILED', params: { exitCode: -1 } })
  })
})

describe('uninstallWindows', () => {
  let root: string
  let core: TestCore
  let ap: string
  let install: ApInstall
  let calls: { cmd: string; script: string }[]
  /** What the fake elevated uninstaller does once started; returns its exit code. */
  let uninstaller: () => number

  function apPaths(base: string): ApPaths {
    return {
      localPath: base,
      userPath: base,
      customWorlds: join(base, 'custom_worlds'),
      coreWorlds: join(base, 'lib', 'worlds'),
      players: join(base, 'Players'),
      templates: join(base, 'Players', 'Templates'),
      output: join(base, 'output'),
      logs: join(base, 'logs'),
      cache: join(base, 'cache'),
      settingsFile: join(base, 'host.yaml'),
    }
  }

  /** What the real uninstaller removes: the files it installed. */
  function removeProgram(): void {
    rmSync(join(ap, 'ArchipelagoLauncher.exe'), { force: true })
    rmSync(join(ap, 'lib'), { recursive: true, force: true })
    rmSync(join(ap, 'unins000.exe'), { force: true })
    rmSync(join(ap, 'unins000.dat'), { force: true })
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'goat uninstall é-'))
    core = createTestContext(root, { os: 'win32' })
    ap = join(root, 'Program Data', 'Archipelago')
    install = {
      kind: 'windows-installer',
      version: '0.6.8',
      root: ap,
      appImagePath: null,
      paths: apPaths(ap),
    }
    mkdirSync(join(ap, 'lib', 'worlds'), { recursive: true })
    mkdirSync(join(ap, 'Players', 'Templates'), { recursive: true })
    mkdirSync(join(ap, 'output'), { recursive: true })
    mkdirSync(join(ap, 'logs'), { recursive: true })
    writeFileSync(join(ap, 'ArchipelagoLauncher.exe'), 'exe')
    writeFileSync(join(ap, 'unins000.exe'), 'uninstaller')
    writeFileSync(join(ap, 'unins000.dat'), 'data')
    writeFileSync(join(ap, 'host.yaml'), 'general_options: {}\n')
    writeFileSync(join(ap, 'options.yaml'), 'generator: {}\n')
    writeFileSync(join(ap, 'Players', 'Ann.yaml'), 'name: Ann\n')
    writeFileSync(join(ap, 'output', 'AP_123.zip'), 'zip')
    writeFileSync(join(ap, 'logs', 'Launcher.txt'), 'log')
    // A ROM the user keeps next to Archipelago (its ROM paths resolve against the user folder).
    writeFileSync(join(ap, 'Zelda.sfc'), 'rom')
    await makeApworld(join(ap, 'custom_worlds', 'foo.apworld'))

    calls = []
    uninstaller = () => {
      removeProgram()
      return 0
    }
    core.ctx.exec = (cmd, _args, opts): Promise<ExecResult> => {
      calls.push({ cmd, script: scriptOf(opts) })
      return Promise.resolve({ code: uninstaller(), stdout: '', stderr: '' })
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const backups = (): string[] => {
    const dir = join(core.ctx.platform.paths.dataRoot, 'backups')
    return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []
  }

  it('runs unins000.exe silently through the elevated wrapper and keeps the user data', async () => {
    await uninstallWindows(core.ctx, install, { purgeUserData: false })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toBe('powershell.exe')
    expect(calls[0]?.script).toContain(
      buildElevatedScript(join(ap, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']),
    )
    expect(readdirSync(ap).sort()).toEqual([
      'Players',
      'Zelda.sfc',
      'custom_worlds',
      'host.yaml',
      'logs',
      'options.yaml',
      'output',
    ])
    expect(backups()).toEqual([])
  })

  it('waits for the second phase of the uninstaller, which outlives the process it started', async () => {
    let finished = false
    uninstaller = () => {
      // Inno's unins000.exe starts a copy of itself and exits at once: the files go a bit later.
      setTimeout(() => {
        removeProgram()
        finished = true
      }, 400)
      return 0
    }

    await uninstallWindows(core.ctx, install, { purgeUserData: true })

    expect(finished).toBe(true)
    expect(existsSync(join(ap, 'Players'))).toBe(false)
  })

  it('purge backs up then removes exactly the YAMLs, games, added worlds, logs and settings', async () => {
    const host = readFileSync(join(ap, 'host.yaml'))
    const world = readFileSync(join(ap, 'custom_worlds', 'foo.apworld'))

    await uninstallWindows(core.ctx, install, { purgeUserData: true })

    // The ROM is not part of what the screen promises to delete.
    expect(readdirSync(ap)).toEqual(['Zelda.sfc'])
    const [backup, ...others] = backups()
    expect(others).toEqual([])
    expect(backup).toMatch(/\d{8}-\d{6}-ap-uninstall$/)
    expect(readdirSync(backup ?? '').sort()).toEqual([
      'custom-worlds.json',
      'custom_worlds',
      'host.yaml',
      'options.yaml',
    ])
    expect(readFileSync(join(backup ?? '', 'host.yaml'))).toEqual(host)
    expect(readFileSync(join(backup ?? '', 'custom_worlds', 'foo.apworld'))).toEqual(world)
    expect(JSON.parse(readFileSync(join(backup ?? '', 'custom-worlds.json'), 'utf8'))).toEqual({
      customWorlds: ['foo.apworld'],
    })
  })

  it('removes the emptied folder after a purge', async () => {
    rmSync(join(ap, 'Zelda.sfc'))
    await uninstallWindows(core.ctx, install, { purgeUserData: true })
    expect(existsSync(ap)).toBe(false)
  })

  it('reports a refused UAC prompt and deletes nothing', async () => {
    uninstaller = () => 1223
    const error = await failure(uninstallWindows(core.ctx, install, { purgeUserData: true }))
    expect(error.code).toBe('INSTALL_ELEVATION_DENIED')
    expect(existsSync(join(ap, 'Players', 'Ann.yaml'))).toBe(true)
    expect(existsSync(join(ap, 'unins000.exe'))).toBe(true)
  })

  it('reports a failed uninstaller with its exit code', async () => {
    uninstaller = () => 5
    const error = await failure(uninstallWindows(core.ctx, install, { purgeUserData: false }))
    expect(error.code).toBe('INSTALL_FAILED')
    expect(error.params).toMatchObject({ exitCode: 5 })
  })

  it('refuses an install without unins000.exe, before asking for elevation', async () => {
    rmSync(join(ap, 'unins000.exe'))
    const error = await failure(uninstallWindows(core.ctx, install, { purgeUserData: true }))
    expect(error.code).toBe('NOT_FOUND')
    expect(calls).toEqual([])
    expect(backups()).toEqual([])
  })

  it('refuses to start when a user data path leads out of the user folder', async () => {
    const elsewhere = join(root, 'Elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'keep.txt'), 'precious')
    const odd = { ...install, paths: { ...install.paths, output: elsewhere } }

    const error = await failure(uninstallWindows(core.ctx, odd, { purgeUserData: true }))

    expect(error.code).toBe('PATH_FORBIDDEN')
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true)
    expect(existsSync(join(ap, 'Players', 'Ann.yaml'))).toBe(true)
    // Refused before the uninstaller was asked for.
    expect(calls).toEqual([])
    expect(existsSync(join(ap, 'unins000.exe'))).toBe(true)
    expect(backups()).toEqual([])
  })
})
