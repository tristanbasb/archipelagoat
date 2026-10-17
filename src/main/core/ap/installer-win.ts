// Installs, updates and uninstalls Archipelago on Windows with its official Inno Setup installer
// (spec §3.4, brief §1.2). The installer needs administrator rights: it is the only program the app
// ever runs elevated, through one UAC prompt. Its outcome is read from its exit code only, since
// Windows localizes every message.
import { mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CoreContext } from '@main/core/context'
import type { ExecFn } from '@main/core/exec'
import { pathExists } from '@main/core/system/fsx'
import { psQuote, runPowerShell } from '@main/core/system/powershell'
import type { TaskHandle } from '@main/core/tasks'
import { INNO_EXIT_CODES } from '@shared/data/ap-constants'
import { AppError, type AppErrorData } from '@shared/errors'
import type { ApInstall, ApRelease } from '@shared/types'
import {
  backupApData,
  fetchReleaseAsset,
  purgeApUserData,
  quarantineCorruptWorlds,
  throwIfCancelled,
  userDataTargets,
} from './install-steps'

/** ERROR_CANCELLED: the user said no to the UAC prompt. */
const ELEVATION_DENIED = 1223

const UNINSTALLER = 'unins000.exe'
const UNINSTALL_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']
/** How long the uninstaller's second phase may take to remove the files. */
const UNINSTALL_TIMEOUT_MS = 10 * 60 * 1000
const UNINSTALL_POLL_MS = 250

export interface InnoArgsOptions {
  desktopIcons: boolean
  /** Checked by `assertUserPath` beforehand; null keeps the installer's folder (or the previous one). */
  customDir: string | null
  logPath: string
}

/**
 * The silent command line of the installer. `/TASKS` is always given, since Inno otherwise reuses
 * the choices of the previous install; `deletelib` empties `lib/` first, as the wizard does.
 */
export function buildInnoArgs({ desktopIcons, customDir, logPath }: InnoArgsOptions): string[] {
  return [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    '/CLOSEAPPLICATIONS',
    `/TASKS="${desktopIcons ? '' : '!'}desktopicon,deletelib"`,
    ...(customDir === null ? [] : [`/DIR="${customDir}"`]),
    `/LOG="${logPath}"`,
  ]
}

/**
 * The PowerShell script that starts `exePath` elevated (`runas`), waits for it and exits with its
 * exit code, or with the Win32 error of a start that failed (1223 when UAC was refused).
 */
export function buildElevatedScript(exePath: string, args: string[]): string {
  return [
    '$psi = New-Object Diagnostics.ProcessStartInfo',
    `$psi.FileName = ${psQuote(exePath)}; $psi.Arguments = ${psQuote(args.join(' '))}; ` +
      "$psi.Verb = 'runas'; $psi.UseShellExecute = $true",
    'try { $p = [Diagnostics.Process]::Start($psi); $p.WaitForExit(); exit $p.ExitCode }',
    'catch [ComponentModel.Win32Exception] { exit $_.Exception.NativeErrorCode }',
  ].join('\n')
}

/** Runs `exePath` elevated and resolves with its exit code (null when PowerShell was killed). */
export async function runElevated(exec: ExecFn, exePath: string, args: string[]): Promise<number | null> {
  const { code } = await runPowerShell(exec, buildElevatedScript(exePath, args))
  return code
}

/** The error an exit code of the installer means, or null for a success. */
export function interpretInstallResult(exitCode: number): AppErrorData | null {
  if (exitCode === 0) return null
  if (exitCode === ELEVATION_DENIED) return { code: 'INSTALL_ELEVATION_DENIED' }
  const reason = exitCode >= 1 && exitCode <= 8 ? INNO_EXIT_CODES[exitCode] : undefined
  return { code: 'INSTALL_FAILED', params: reason === undefined ? { exitCode } : { exitCode, reason } }
}

/** Throws the error an exit code means; the log is attached when the installer wrote one. */
async function throwOnFailure(code: number | null, logPath?: string): Promise<void> {
  const failure: AppErrorData | null =
    code === null ? { code: 'INSTALL_FAILED' } : interpretInstallResult(code)
  if (!failure) return
  const withLog = logPath !== undefined && (await pathExists(logPath)) ? { logPath } : {}
  throw new AppError(failure.code, failure.params, withLog)
}

export interface WindowsInstallOptions {
  release: ApRelease
  desktopIcons: boolean
  /** Checked by `assertUserPath` beforehand; null: the installer's default, or the previous folder. */
  customDir: string | null
  /** The install being updated: its settings are backed up and its corrupt worlds set aside first. */
  current: ApInstall | null
  /** Runs right before the installer starts (the service checks that no Archipelago program runs). */
  beforeInstall?: () => Promise<void>
}

/**
 * Downloads and verifies the installer, backs up and quarantines (task stages `download`, `verify`,
 * `backup`, `quarantine`), then runs it elevated and silent (`install`). Throws
 * `INSTALL_ELEVATION_DENIED` or `INSTALL_FAILED` (with the Inno log) when it does not succeed.
 */
export async function installWindows(
  ctx: CoreContext,
  opts: WindowsInstallOptions,
  task: TaskHandle,
): Promise<void> {
  const asset = opts.release.windows
  if (!asset) throw new AppError('NOT_FOUND', undefined, { detail: 'the release has no Windows installer' })
  const setup = await fetchReleaseAsset(ctx, asset, task)

  task.progress('backup', null)
  if (opts.current) await backupApData(ctx, opts.current, { label: 'ap-install' })
  task.progress('quarantine', null)
  if (opts.current) await quarantineCorruptWorlds(ctx, opts.current)

  await opts.beforeInstall?.()
  throwIfCancelled(task.signal)
  task.progress('install', null)
  const logDir = path.join(ctx.platform.paths.dataRoot, 'logs')
  await mkdir(logDir, { recursive: true })
  const logPath = path.join(logDir, `ap-setup-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const args = buildInnoArgs({ desktopIcons: opts.desktopIcons, customDir: opts.customDir, logPath })
  // Once started, the installer cannot be cancelled: it runs elevated, out of our reach.
  await throwOnFailure(await runElevated(ctx.exec, setup, args), logPath)
}

/** Inno's uninstaller hands over to a copy of itself and exits: the copy deletes the original last. */
async function waitUntilGone(file: string): Promise<void> {
  const deadline = Date.now() + UNINSTALL_TIMEOUT_MS
  while (await pathExists(file)) {
    if (Date.now() > deadline) {
      throw new AppError('INSTALL_FAILED', undefined, { detail: 'the uninstaller did not finish' })
    }
    await sleep(UNINSTALL_POLL_MS)
  }
}

/**
 * Uninstalls with `unins000.exe`, silent and elevated like the installer (Archipelago is installed
 * for all users). The uninstaller leaves the user data; `purgeUserData` backs up the settings and
 * the added worlds, then deletes what `purgeApUserData` lists once the uninstaller is done.
 */
export async function uninstallWindows(
  ctx: CoreContext,
  install: ApInstall,
  { purgeUserData }: { purgeUserData: boolean },
): Promise<void> {
  const uninstaller = path.join(install.root, UNINSTALLER)
  if (!(await pathExists(uninstaller))) throw new AppError('NOT_FOUND', undefined, { detail: uninstaller })
  if (purgeUserData) {
    userDataTargets(install.paths)
    await backupApData(ctx, install, { label: 'ap-uninstall', worldFiles: true })
  }

  // Inno only promises that a failed uninstall exits with a code other than 0.
  await throwOnFailure(await runElevated(ctx.exec, uninstaller, UNINSTALL_ARGS))
  await waitUntilGone(uninstaller)

  if (purgeUserData) {
    await purgeApUserData(install.paths)
    // The folder itself goes only when nothing is left in it (a ROM kept there, for instance).
    await rmdir(install.root).catch(() => undefined)
  }
}
