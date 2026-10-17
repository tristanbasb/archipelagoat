// Constants of Archipelago 0.6.8 and of the sites the app talks to. Each value comes from the
// research brief (docs/research/archipelago-research-brief.md); the section is named where it helps.
import type { OS } from '../types'
import { coreWorldsFor, type CoreWorld } from './core-worlds'

// Repositories and endpoints
export const AP_REPO = 'ArchipelagoMW/Archipelago'
export const IONIUM_REPO = 'ionium-ap/Archipelago-index'
export const WIKI_API = 'https://archipelago.miraheze.org/w/api.php'
export const WEBHOST_DEFAULT = 'https://archipelago.gg'

/** Port `ArchipelagoServer` listens on unless told otherwise (settings.py ServerOptions.port). */
export const DEFAULT_PORT = 38281

/**
 * The AppId of the Windows installer (Inno Setup, brief 1.2). inno_setup.iss:15 writes
 * `AppId={{918BA46A-…}}`: `{{` is Inno's escape for `{`, but a `}` needs none, so `}}` stays two
 * braces. The real 0.6.8 install wrote its uninstall key with both
 * (docs/verification/2026-10-16-real-run.md).
 */
export const AP_INNO_APPID = '{918BA46A-FAB8-460C-9DFF-AE691E1C865B}}'

/** Uninstall key of the installer, read in the native 64-bit registry view. */
export const AP_UNINSTALL_KEY =
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + AP_INNO_APPID + '_is1'

/** Exit codes of an Inno Setup installer. Only the code is stable: Windows localizes its messages. */
export const INNO_EXIT_CODES: Record<number, string> = {
  0: 'Success',
  1: 'Initialization failed',
  2: 'Cancelled before install',
  3: 'Fatal error between phases',
  4: 'Fatal error during install',
  5: 'Cancelled during install',
  6: 'Killed by debugger',
  7: 'Preparing to Install says it cannot proceed',
  8: 'Preparing to Install says it cannot proceed, and a restart is needed',
}

/**
 * Release assets are always picked by these patterns, never by position. The Windows RC keeps the
 * pattern's shape (`Setup.Archipelago.0.6.8-RC1.exe`) and the Linux RC assets reuse the final names,
 * so the release itself is chosen by tag (`/releases/latest`), not by file name (brief 1.1).
 */
export const ASSET_PATTERNS = {
  windows: /^Setup\.Archipelago\.(.+)\.exe$/,
  linuxTarGz: /^Archipelago_(.+)_linux-x86_64\.tar\.gz$/,
  appImage: /^Archipelago_(.+)_linux-x86_64\.AppImage$/,
} as const

/**
 * Frozen executables of an Archipelago install, without extension (brief 1.5; setup.py:186-202 builds
 * one per component that has a script, named `Archipelago<script>`). On Windows the file ends in
 * `.exe` (`apExeFileName`). `ArchipelagoLauncherDebug` exists on Windows only: a console copy of the
 * Launcher. `ArchipelagoGenerate` and `ArchipelagoServer` are console programs.
 */
export const AP_EXES = {
  launcher: 'ArchipelagoLauncher',
  launcherDebug: 'ArchipelagoLauncherDebug',
  generate: 'ArchipelagoGenerate',
  server: 'ArchipelagoServer',
  optionsCreator: 'ArchipelagoOptionsCreator',
  textClient: 'ArchipelagoTextClient',
  bizhawkClient: 'ArchipelagoBizHawkClient',
  sniClient: 'ArchipelagoSNIClient',
  ootClient: 'ArchipelagoOoTClient',
  mmbn3Client: 'ArchipelagoMMBN3Client',
  zelda1Client: 'ArchipelagoZelda1Client',
  adventureClient: 'ArchipelagoAdventureClient',
  zillionClient: 'ArchipelagoZillionClient',
  checksFinderClient: 'ArchipelagoChecksFinderClient',
  ahitClient: 'ArchipelagoAHITClient',
  undertaleClient: 'ArchipelagoUndertaleClient',
  lttpAdjuster: 'ArchipelagoLttPAdjuster',
  ootAdjuster: 'ArchipelagoOoTAdjuster',
} as const

/** File name of a frozen executable on `os`. */
export function apExeFileName(name: string, os: OS): string {
  return os === 'win32' ? `${name}.exe` : name
}

// BizHawk, the emulator the app can install (brief 1.11)
export const BIZHAWK_REPO = 'TASEmulators/BizHawk'
export const BIZHAWK_TAG = '2.11.1'
export const BIZHAWK_ASSETS = {
  win32: 'BizHawk-2.11.1-win-x64.zip',
  linux: 'BizHawk-2.11.1-linux-x64.tar.gz',
} as const

/**
 * The core worlds the frozen build ships as folders and that no custom world can replace. Taken from
 * the generated 0.6.8 table, never typed here (setup.py `non_apworlds`, brief 1.10).
 */
export const CORE_LOOSE_WORLDS: readonly CoreWorld[] = (coreWorldsFor('0.6.8') ?? []).filter(
  (world) => world.loose,
)
